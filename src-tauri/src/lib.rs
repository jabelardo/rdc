// The IPC surface lives in `commands`; see that module for the conventions.
mod commands;
use tauri::{webview::PageLoadEvent, Emitter, Manager};

mod blob_protocol;
mod config;
mod hook_state;
pub mod operation;
pub mod operation_registry;
mod platform;
#[cfg(debug_assertions)]
mod qa_driver;
mod resilience;
mod security;

mod trampoline_state;

fn create_window_from_main_template(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    let mut window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| std::io::Error::other("tauri.conf.json has no main window template"))?;
    window_config.label = label.to_owned();
    let directory = app.path().app_config_dir()?;
    let main_process_config = config::read_main_process_config(&directory)?;
    let title_bar = config::title_bar_decision(
        config::HostPlatform::current(),
        main_process_config.title_bar_style,
    );

    // Linux and Windows render the menu as an in-window bar instead of a native system
    // menu, so the minimum window height must leave room for it or the content area can
    // shrink below its own minimum.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if let Some(min_height) = window_config.min_height.as_mut() {
        *min_height += 32.0;
    }

    let builder = tauri::WebviewWindowBuilder::from_config(app, &window_config)?
        .decorations(title_bar.decorations)
        .on_navigation(security::is_allowed_navigation);
    #[cfg(target_os = "macos")]
    let builder = if title_bar.macos_title_bar_overlay {
        builder.title_bar_style(tauri::TitleBarStyle::Overlay)
    } else {
        builder
    };

    Ok(builder.build()?)
}

// WebKitGTK's native-Wayland GPU compositing path has known unresolved
// crash/render bugs as of 2026 (e.g. tauri-apps/wry#1727), and Wayland is
// now the only session type on the project's primary target (GNOME/KDE
// both dropped native X11). Force software compositing unconditionally
// rather than betting on GPU-accelerated Wayland rendering being stable —
// must be set before the webview initializes.
#[cfg(target_os = "linux")]
fn disable_webkit_compositing() {
    // SAFETY: called once, single-threaded, before any GTK/WebKitGTK
    // initialization — no concurrent env access exists yet at this point.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    disable_webkit_compositing();

    tauri::Builder::default()
        .plugin(resilience::application_log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("main")
                .build(),
        )
        .manage(trampoline_state::TrampolineState::new())
        .manage(hook_state::HookRegistry::new())
        .manage(operation_registry::OperationRegistry::new())
        .manage(commands::platform::keybindings::KeybindingState::new())
        .manage(commands::platform::config::MainProcessConfigState::new())
        .manage(commands::platform::credential_store::CredentialStoreState::new())
        .manage(platform::menu::NativeMenuState::new())
        .manage(platform::install_id::InstallIdState::new())
        .manage(platform::notification::NotificationState::new())
        .manage(platform::window::WindowRoutingState::default())
        .manage(platform::window::WindowZoomState::new())
        .manage(platform::window::LaunchTimingState::new())
        .manage(blob_protocol::BlobRegistry::new())
        .setup(|app| {
            resilience::install_panic_logging();
            app.state::<platform::window::LaunchTimingState>()
                .mark_main_ready();
            if let Ok(dir) = app.path().app_config_dir() {
                app.state::<platform::window::WindowZoomState>()
                    .load_from_config_dir(dir);
            }
            #[cfg(debug_assertions)]
            qa_driver::spawn(app.handle().clone());
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            let mut operation_events = app
                .state::<operation_registry::OperationRegistry>()
                .subscribe();
            let operation_event_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match operation_events.recv().await {
                        Ok(event) => {
                            let _ = operation_event_app.emit("operation-event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            #[cfg(target_os = "macos")]
            {
                let directory = app.path().app_config_dir()?;
                let bindings =
                    tauri::async_runtime::block_on(platform::keybindings::get_keybindings(
                        &directory,
                        platform::keybindings::BindingPlatform::MacOs,
                    ))
                    .map_err(std::io::Error::other)?;
                platform::menu::install_bootstrap(app, &bindings).map_err(std::io::Error::other)?;
            }
            create_window_from_main_template(app.handle(), "main")?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            let state = webview
                .app_handle()
                .state::<platform::window::LaunchTimingState>();
            match payload.event() {
                PageLoadEvent::Started => state.mark_load_started(webview.label()),
                PageLoadEvent::Finished => state.mark_load_finished(webview.label()),
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<operation_registry::OperationRegistry>()
                    .clear_owner_window(window.label());
                window
                    .state::<platform::window::WindowRoutingState>()
                    .remove(window.label());
                window
                    .state::<platform::notification::NotificationState>()
                    .remove_window(window.label());
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            platform::menu::handle_menu_event(app, id);
            // Every selection is relayed here too: a context menu's ids are per-invocation
            // indices, disjoint from the app-level menu's fixed ids, so the frontend can just
            // filter for the ones it's waiting on rather than this needing its own registry.
            let _ = app.emit(platform::context_menu::CONTEXT_MENU_EVENT, id);
        })
        .register_asynchronous_uri_scheme_protocol(
            blob_protocol::SCHEME,
            |context, request, responder| {
                // Reading a blob runs git, so this answers asynchronously rather than blocking the
                // webview's thread while it happens.
                let registry = context
                    .app_handle()
                    .state::<blob_protocol::BlobRegistry>()
                    .inner()
                    .clone();

                tauri::async_runtime::spawn(async move {
                    responder.respond(blob_protocol::respond(&registry, &request).await);
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            commands::platform::editor::get_available_editors,
            commands::platform::editor::validate_custom_integration_path,
            commands::platform::editor::is_valid_custom_integration,
            commands::platform::editor::launch_external_editor,
            commands::platform::editor::launch_custom_external_editor,
            commands::platform::shell::get_available_shells,
            commands::platform::shell::launch_shell,
            commands::platform::shell::launch_custom_shell,
            commands::platform::keybindings::get_keybindings,
            commands::platform::keybindings::set_keybinding,
            commands::platform::keybindings::reset_keybindings,
            commands::platform::config::get_main_process_config,
            commands::platform::config::update_main_process_config,
            commands::platform::credential_store::set_credential,
            commands::platform::credential_store::get_credential,
            commands::platform::credential_store::delete_credential,
            commands::platform::application_folder::is_in_application_folder,
            commands::platform::application_folder::move_to_applications_folder,
            commands::platform::cli_installer::install_darwin_cli,
            commands::platform::install_id::get_guid,
            commands::platform::install_id::save_guid,
            commands::platform::menu::set_native_menu,
            commands::platform::context_menu::show_context_menu_at,
            commands::platform::notification::show_notification,
            commands::platform::notification::get_notifications_permission,
            commands::platform::notification::request_notifications_permission,
            commands::platform::window::set_window_selected_repository,
            commands::platform::window::beep,
            commands::platform::window::get_apple_action_on_double_click,
            commands::platform::window::open_repository_in_new_window,
            commands::platform::window::get_current_window_zoom_factor,
            commands::platform::window::set_window_zoom_factor,
            commands::platform::window::toggle_devtools,
            commands::platform::window::renderer_ready,
            commands::platform::files::classify_folder_open,
            commands::platform::files::move_repository_paths_to_trash,
            commands::platform::files::permanently_delete_repository_paths,
            commands::platform::files::get_exec_path,
            commands::platform::files::is_running_under_arm64_translation,
            commands::git::branches::create_branch,
            commands::git::branches::rename_branch,
            commands::git::branches::delete_local_branch,
            commands::git::branches::get_branches_pointed_at,
            commands::git::branches::get_merged_branches,
            commands::git::branches::delete_ref,
            commands::git::branches::get_symbolic_ref,
            commands::git::changes::reset,
            commands::git::changes::reset_paths,
            commands::git::changes::unstage_all,
            commands::git::changes::unstage_all_files,
            commands::git::conflicts::stage_resolved_conflict_files,
            commands::git::history::get_ahead_behind,
            commands::git::diffs::get_branch_merge_base_diff,
            commands::git::diffs::get_branch_merge_base_changed_files,
            commands::git::diffs::get_commit_range_changed_files,
            commands::git::changes::get_status,
            commands::git::repositories::init_repository,
            commands::git::hooks::abort_hook,
            commands::git::hooks::resolve_hook_failure,
            commands::git::changes::create_commit,
            commands::git::changes::create_merge_commit,
            commands::git::branches::checkout_branch,
            commands::git::branches::checkout_remote_branch,
            commands::git::history::checkout_commit,
            commands::git::changes::checkout_paths,
            commands::git::history::get_commits,
            commands::git::history::get_commit,
            commands::git::history::get_changed_files,
            commands::git::branches::get_branches,
            commands::git::branches::get_branches_differing_from_upstream,
            commands::git::changes::get_index_changes,
            commands::git::diffs::get_working_directory_diff,
            commands::git::diffs::get_commit_diff,
            commands::git::diffs::get_commit_range_diff,
            commands::git::changes::discard_changes_from_selection,
            commands::git::remotes::push,
            commands::git::remotes::delete_remote_branch,
            commands::git::remotes::fetch,
            commands::git::remotes::fetch_workflow,
            commands::git::remotes::fetch_refspec,
            commands::git::remotes::pull,
            commands::git::remotes::fast_forward_branches,
            commands::git::remotes::clone,
            commands::git::remotes::get_remotes,
            commands::git::remotes::add_remote,
            commands::git::remotes::remove_remote,
            commands::git::remotes::set_remote_url,
            commands::git::remotes::get_remote_url,
            commands::git::remotes::update_remote_head,
            commands::git::remotes::get_remote_head,
            commands::git::stash::get_stashes,
            commands::git::stash::create_stash_entry,
            commands::git::stash::drop_stash_entry,
            commands::git::stash::pop_stash_entry,
            commands::git::stash::get_last_stash_entry_for_branch,
            commands::git::stash::rename_stash_entry,
            commands::git::stash::move_stash_entry,
            commands::git::stash::get_stashed_files,
            commands::git::history::cherry_pick,
            commands::git::history::get_cherry_pick_snapshot,
            commands::git::history::continue_cherry_pick,
            commands::git::history::abort_cherry_pick,
            commands::git::submodules::list_submodules,
            commands::git::submodules::reset_submodule_paths,
            commands::git::history::squash,
            commands::git::history::reorder,
            commands::git::tags::create_tag,
            commands::git::tags::delete_tag,
            commands::git::tags::get_all_tags,
            commands::git::history::revert_commit,
            commands::git::history::abort_revert,
            commands::git::branches::get_recent_branches,
            commands::git::branches::get_branch_checkouts,
            commands::git::repositories::get_description,
            commands::git::repositories::write_description,
            commands::git::repositories::get_author_identity,
            commands::git::changes::clean_untracked_files,
            commands::git::repositories::add_safe_directory,
            commands::git::branches::determine_mergeability,
            commands::git::repositories::get_repository_type,
            commands::git::history::is_cherry_pick_head_found,
            commands::git::branches::get_rebase_internal_state,
            commands::operations::get_active_operation_for_repository,
            commands::operations::get_active_operation_for_clone_destination,
            commands::operations::get_operation_scope_for_repository,
            commands::operations::get_latest_operation_event,
            commands::operations::request_operation_cancellation,
            commands::git::changes::checkout_index,
            commands::git::trailers::get_trailer_separator_characters,
            commands::git::trailers::parse_trailers,
            commands::git::trailers::merge_trailers,
            commands::git::worktree::list_worktrees,
            commands::git::worktree::list_worktrees_from_git_dir,
            commands::git::worktree::list_worktrees_from_git_dir_fallback,
            commands::git::worktree::add_worktree,
            commands::git::worktree::remove_worktree,
            commands::git::worktree::move_worktree,
            commands::git::repositories::get_config_value,
            commands::git::repositories::get_global_config_path,
            commands::git::gitignore::read_gitignore_at_root,
            commands::git::gitignore::save_gitignore,
            commands::git::gitignore::append_ignore_rules,
            commands::git::gitignore::append_ignore_files,
            commands::git::lfs::install_global_lfs_filters,
            commands::git::lfs::install_lfs_hooks,
            commands::git::lfs::is_using_lfs,
            commands::git::branches::merge_branch,
            commands::git::branches::get_merge_base,
            commands::git::conflicts::abort_merge,
            commands::git::branches::rebase_branch,
            commands::git::branches::continue_rebase,
            commands::git::branches::abort_rebase,
            commands::git::branches::get_rebase_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    fn tauri_config() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("Tauri configuration should be valid JSON")
    }

    fn directive<'a>(
        config: &'a serde_json::Value,
        policy: &str,
        name: &str,
    ) -> &'a [serde_json::Value] {
        config["app"]["security"][policy][name]
            .as_array()
            .unwrap_or_else(|| panic!("{policy}.{name} should be an explicit source list"))
    }

    fn source_is_allowed(
        config: &serde_json::Value,
        policy: &str,
        directive_name: &str,
        source: &str,
    ) -> bool {
        directive(config, policy, directive_name)
            .iter()
            .any(|value| value == source)
    }

    #[test]
    fn desktop_capability_allows_lifetime_and_updater_operations() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability should be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("default capability should list permissions");

        assert!(
            permissions
                .iter()
                .any(|permission| permission == "core:window:allow-hide"),
            "the macOS close handler calls window.hide()"
        );
        assert!(
            permissions
                .iter()
                .any(|permission| permission == "core:window:allow-start-dragging"),
            "overlay and frameless windows delegate their drag region to the webview"
        );
        for required in [
            "updater:allow-check",
            "updater:allow-download",
            "updater:allow-install",
        ] {
            assert!(
                permissions.iter().any(|permission| permission == required),
                "the frontend updater needs {required}"
            );
        }
    }

    #[test]
    fn desktop_capability_does_not_grant_unused_core_permission_sets() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability should be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("default capability should list permissions");

        assert!(
            !permissions
                .iter()
                .any(|permission| permission == "core:default"),
            "core:default also exposes unused image, resources, menu, tray and event-emission commands"
        );
        for required in [
            "core:app:allow-set-app-theme",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:path:default",
            "core:resources:allow-close",
            "core:webview:allow-set-webview-zoom",
        ] {
            assert!(
                permissions.iter().any(|permission| permission == required),
                "the current frontend imports require {required}"
            );
        }
    }

    #[test]
    fn production_csp_is_closed_and_keeps_ipc_and_blob_capabilities() {
        let config = tauri_config();

        assert_eq!(
            directive(&config, "csp", "default-src"),
            [serde_json::Value::String("'self'".into())]
        );
        for closed in ["base-uri", "frame-src", "object-src"] {
            assert_eq!(
                directive(&config, "csp", closed),
                [serde_json::Value::String("'none'".into())],
                "{closed} should fail closed"
            );
        }
        for source in ["'self'", "ipc:", "http://ipc.localhost", "rdc-blob:"] {
            assert!(
                source_is_allowed(&config, "csp", "connect-src", source),
                "connect-src needs {source}"
            );
        }
        for source in ["'self'", "data:", "blob:", "rdc-blob:"] {
            assert!(
                source_is_allowed(&config, "csp", "img-src", source),
                "img-src needs {source}"
            );
        }
        for forbidden in ["*", "http:", "https:", "'unsafe-eval'"] {
            assert!(
                !config["app"]["security"]["csp"]
                    .as_object()
                    .expect("production csp should be a directive map")
                    .values()
                    .flat_map(|value| {
                        value
                            .as_array()
                            .expect("each directive should be a source list")
                    })
                    .any(|value| value == forbidden),
                "production CSP must not contain {forbidden}"
            );
        }
        assert_eq!(config["app"]["security"]["freezePrototype"], true);
    }

    #[test]
    fn development_csp_adds_only_the_vite_loopback_transport() {
        let config = tauri_config();

        for source in ["http://localhost:1420", "ws://localhost:1420"] {
            assert!(
                source_is_allowed(&config, "devCsp", "connect-src", source),
                "Vite development requires {source}"
            );
        }
        assert!(
            source_is_allowed(&config, "devCsp", "script-src", "http://localhost:1420"),
            "the development document loads Vite's module from its loopback server"
        );
        for forbidden in ["*", "http:", "https:", "'unsafe-eval'"] {
            assert!(
                !config["app"]["security"]["devCsp"]
                    .as_object()
                    .expect("development csp should be a directive map")
                    .values()
                    .flat_map(|value| {
                        value
                            .as_array()
                            .expect("each directive should be a source list")
                    })
                    .any(|value| value == forbidden),
                "development CSP must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn updater_has_an_explicit_pre_release_configuration() {
        let config = tauri_config();
        let updater = config["plugins"]["updater"]
            .as_object()
            .expect("the updater plugin rejects an absent/null configuration at startup");

        assert_eq!(
            updater.get("pubkey").and_then(serde_json::Value::as_str),
            Some(""),
            "Phase 9 owns the real signing key; pre-release builds still need a valid config object"
        );
    }
}
