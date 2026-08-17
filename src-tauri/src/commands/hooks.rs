//! Commands for a git hook that stopped and is waiting on the user.
//!
//! Running hooks is `git_ops::hooks`; holding the abort handles is `crate::hook_state`. These two
//! commands are how the frontend answers a hook that paused.

use crate::hook_state::HookFailureResolution;
use crate::hook_state::HookRegistry;
use tauri::State;

/// Stops a hook that is still running.
///
/// ```js
/// await invoke('abort_hook', { id })   // an id from an onHookProgress update
/// ```
///
/// `false` means the hook had already ended, which is not an error: the user cancelled a moment too late
/// and the operation carried on. Kills the `git hook run` process; a hook that spawned children of its own
/// may leave them running, as upstream's `AbortController` also did.
#[tauri::command]
pub fn abort_hook(hooks: State<'_, HookRegistry>, id: u64) -> bool {
    hooks.abort(id)
}

/// Answers the prompt for a failed hook. A stale id is harmless and returns `false`.
#[tauri::command]
pub fn resolve_hook_failure(
    hooks: State<'_, HookRegistry>,
    id: u64,
    resolution: HookFailureResolution,
) -> bool {
    hooks.resolve_failure(id, resolution)
}
