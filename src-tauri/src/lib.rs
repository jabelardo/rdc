// The IPC surface lives in `commands`; see that module for the conventions.
mod commands;
mod trampoline_state;

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
        .plugin(tauri_plugin_opener::init())
        // Owns the credential server. Created eagerly, but it only binds a socket on the first
        // remote operation — see `trampoline_state`.
        .manage(trampoline_state::TrampolineState::new())
        .invoke_handler(tauri::generate_handler![
            commands::git::get_status,
            commands::git::create_commit,
            commands::git::create_merge_commit,
            commands::git::checkout_branch,
            commands::git::checkout_remote_branch,
            commands::git::checkout_commit,
            commands::git::checkout_paths,
            commands::git::stage_manual_conflict_resolution,
            commands::log::get_commits,
            commands::log::get_commit,
            commands::log::get_changed_files,
            commands::log::get_authors,
            commands::git::get_index_changes,
            commands::git::get_working_directory_diff,
            commands::git::get_commit_diff,
            commands::git::get_commit_range_diff,
            commands::remote::push,
            commands::remote::fetch,
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
            commands::misc::fetch_tags_to_push,
            commands::misc::revert_commit,
            commands::misc::get_recent_branches,
            commands::misc::get_branch_checkouts,
            commands::misc::get_description,
            commands::misc::write_description,
            commands::misc::get_author_identity,
            commands::misc::clean_untracked_files,
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
