//! Git commands exposed to the frontend.
//!
//! Thin wrappers over `git-ops`: they translate arguments and errors, and hold no logic of their
//! own. Anything worth testing lives in the crate, where it can be tested without a Tauri app.

use git_ops::status::StatusResult;

use super::CommandError;

/// Reads the status of the repository at `repository_path`.
///
/// Returns `None` when the path isn't a git repository, which is a normal answer rather than an
/// error — see `git_ops::status::get_status`.
///
/// Invoked from the frontend as:
///
/// ```js
/// await invoke('get_status', { repositoryPath, listUntrackedFilesIndividually: true })
/// ```
///
/// Note `listUntrackedFilesIndividually` does **not** mean "include untracked files" — passing
/// `false` still reports them, just collapsing untracked directories. The parameter was renamed from
/// the original's misleading `includeUntracked` for exactly that reason.
#[tauri::command]
pub async fn get_status(
    repository_path: String,
    list_untracked_files_individually: bool,
) -> Result<Option<StatusResult>, CommandError> {
    // Owned `String` rather than `&str`: async commands can't take borrowed arguments.
    git_ops::status::get_status(&repository_path, list_untracked_files_individually)
        .await
        .map_err(CommandError::from)
}
