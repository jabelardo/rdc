// The IPC surface lives in `commands`; see that module for the conventions.
mod commands;
use tauri::{webview::PageLoadEvent, Manager};

mod blob_protocol;
mod config;
mod hook_state;
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

    // Linux and Windows render the menu as an in-window bar (`.app-menu-bar-container`,
    // 2rem tall) instead of a native system menu, so the minimum window height must
    // leave room for it or the content area can shrink below its own minimum. The value
    // deliberately tracks the CSS `2rem` (32px at the default 16px root) — keep in sync.
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
        .manage(commands::keybindings::KeybindingState::new())
        .manage(commands::config::MainProcessConfigState::new())
        .manage(commands::credential_store::CredentialStoreState::new())
        .manage(platform::menu::NativeMenuState::new())
        .manage(platform::install_id::InstallIdState::new())
        .manage(platform::notification::NotificationState::new())
        .manage(platform::context_menu::ContextMenuState::new())
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
                    .state::<platform::window::WindowRoutingState>()
                    .remove(window.label());
                window
                    .state::<platform::notification::NotificationState>()
                    .remove_window(window.label());
            }
            // A native context menu left open when its window loses focus can hold
            // an input grab and make the app unresponsive (menu covers Close/Exit).
            // Dismiss any pending context menu so the renderer's invoke resolves.
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                window
                    .app_handle()
                    .state::<platform::context_menu::ContextMenuState>()
                    .dismiss_pending();
            }
        })
        .on_menu_event(|app, event| {
            if platform::context_menu::handle_menu_event(app, event.id().as_ref()) {
                return;
            }
            platform::menu::handle_menu_event(app, event.id().as_ref());
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
            commands::editor::get_available_editors,
            commands::editor::validate_custom_integration_path,
            commands::editor::is_valid_custom_integration,
            commands::editor::launch_external_editor,
            commands::editor::launch_custom_external_editor,
            commands::shell::get_available_shells,
            commands::shell::launch_shell,
            commands::shell::launch_custom_shell,
            commands::keybindings::get_keybindings,
            commands::keybindings::set_keybinding,
            commands::keybindings::reset_keybindings,
            commands::config::get_main_process_config,
            commands::config::update_main_process_config,
            commands::credential_store::set_credential,
            commands::credential_store::get_credential,
            commands::credential_store::delete_credential,
            commands::application_folder::is_in_application_folder,
            commands::application_folder::move_to_applications_folder,
            commands::cli_installer::install_darwin_cli,
            commands::install_id::get_guid,
            commands::install_id::save_guid,
            commands::menu::set_native_menu,
            commands::menu::show_contextual_menu,
            commands::notification::show_notification,
            commands::notification::get_notifications_permission,
            commands::notification::request_notifications_permission,
            commands::window::set_window_selected_repository,
            commands::window::beep,
            commands::window::get_apple_action_on_double_click,
            commands::window::open_repository_in_new_window,
            commands::window::get_current_window_zoom_factor,
            commands::window::set_window_zoom_factor,
            commands::window::toggle_devtools,
            commands::window::renderer_ready,
            commands::files::classify_folder_open,
            commands::files::move_item_to_trash,
            commands::files::permanently_delete_repository_path,
            commands::files::get_exec_path,
            commands::files::is_running_under_arm64_translation,
            commands::branch::create_branch,
            commands::branch::rename_branch,
            commands::branch::delete_local_branch,
            commands::branch::get_branches_pointed_at,
            commands::branch::get_merged_branches,
            commands::branch::delete_ref,
            commands::branch::get_symbolic_ref,
            commands::git::reset,
            commands::git::reset_paths,
            commands::git::unstage_all,
            commands::git::unstage_all_files,
            commands::git::stage_resolved_conflict_files,
            commands::git::get_ahead_behind,
            commands::git::get_branch_merge_base_diff,
            commands::git::get_branch_merge_base_changed_files,
            commands::git::get_commit_range_changed_files,
            commands::git::get_status,
            commands::git::init_repository,
            commands::git::abort_hook,
            commands::git::resolve_hook_failure,
            commands::git::create_commit,
            commands::git::create_merge_commit,
            commands::git::checkout_branch,
            commands::git::checkout_remote_branch,
            commands::git::checkout_commit,
            commands::git::checkout_paths,
            commands::log::get_commits,
            commands::log::get_commit,
            commands::log::get_changed_files,
            commands::git::get_branches,
            commands::git::get_branches_differing_from_upstream,
            commands::git::get_index_changes,
            commands::git::get_working_directory_diff,
            commands::git::get_commit_diff,
            commands::git::get_commit_range_diff,
            commands::git::discard_changes_from_selection,
            commands::remote::push,
            commands::remote::delete_remote_branch,
            commands::remote::fetch,
            commands::remote::fetch_refspec,
            commands::remote::pull,
            commands::remote::fast_forward_branches,
            commands::remote::clone,
            commands::remote::get_remotes,
            commands::remote::add_remote,
            commands::remote::remove_remote,
            commands::remote::set_remote_url,
            commands::remote::get_remote_url,
            commands::remote::update_remote_head,
            commands::remote::get_remote_head,
            commands::stash::get_stashes,
            commands::stash::create_stash_entry,
            commands::stash::drop_stash_entry,
            commands::stash::pop_stash_entry,
            commands::stash::get_last_stash_entry_for_branch,
            commands::stash::rename_stash_entry,
            commands::stash::move_stash_entry,
            commands::stash::get_stashed_files,
            commands::stash::cherry_pick,
            commands::stash::get_cherry_pick_snapshot,
            commands::stash::continue_cherry_pick,
            commands::stash::abort_cherry_pick,
            commands::stash::list_submodules,
            commands::stash::reset_submodule_paths,
            commands::stash::squash,
            commands::stash::reorder,
            commands::misc::create_tag,
            commands::misc::delete_tag,
            commands::misc::get_all_tags,
            commands::misc::revert_commit,
            commands::misc::get_recent_branches,
            commands::misc::get_branch_checkouts,
            commands::misc::get_description,
            commands::misc::write_description,
            commands::misc::get_author_identity,
            commands::misc::clean_untracked_files,
            commands::misc::add_safe_directory,
            commands::misc::determine_mergeability,
            commands::misc::get_repository_type,
            commands::misc::is_cherry_pick_head_found,
            commands::misc::get_rebase_internal_state,
            commands::misc::checkout_index,
            commands::misc::get_trailer_separator_characters,
            commands::misc::parse_trailers,
            commands::misc::merge_trailers,
            commands::worktree::list_worktrees,
            commands::worktree::list_worktrees_from_git_dir,
            commands::worktree::list_worktrees_from_git_dir_fallback,
            commands::worktree::add_worktree,
            commands::worktree::remove_worktree,
            commands::worktree::move_worktree,
            commands::misc::get_config_value,
            commands::misc::get_global_config_path,
            commands::misc::read_gitignore_at_root,
            commands::misc::save_gitignore,
            commands::misc::append_ignore_rules,
            commands::misc::append_ignore_files,
            commands::misc::install_global_lfs_filters,
            commands::misc::install_lfs_hooks,
            commands::misc::is_using_lfs,
            commands::git::merge_branch,
            commands::git::get_merge_base,
            commands::git::abort_merge,
            commands::git::rebase_branch,
            commands::git::continue_rebase,
            commands::git::abort_rebase,
            commands::git::get_rebase_snapshot,
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
