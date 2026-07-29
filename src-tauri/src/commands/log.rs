//! History commands exposed to the frontend.
//!
//! Thin wrappers over `git_ops::log`, as in [`super::git`]. The returned types carry the *constructor
//! arguments* of the TypeScript `Commit`/`CommittedFileChange` classes; `src/lib/log-ipc.ts` builds
//! the objects, so the fields those constructors derive have exactly one implementation.

use git_ops::log::{ChangesetData, Commit};

use super::CommandError;

/// Reads commits, most recent first.
///
/// ```js
/// await invoke('get_commits', {
///   repositoryPath,
///   revisionRange: 'HEAD',   // optional
///   limit: 100,              // optional
///   skip: 0,                 // optional
///   additionalArgs: [],
/// })
/// ```
///
/// A repository with no commits returns an empty array rather than failing — `git log` exits 128 on
/// an unborn `HEAD`, which is a normal state rather than an error.
#[tauri::command]
pub async fn get_commits(
    repository_path: String,
    revision_range: Option<String>,
    limit: Option<u32>,
    skip: Option<u32>,
    additional_args: Option<Vec<String>>,
) -> Result<Vec<Commit>, CommandError> {
    git_ops::log::get_commits(
        &repository_path,
        revision_range.as_deref(),
        limit,
        skip,
        &additional_args.unwrap_or_default(),
    )
    .await
    .map_err(CommandError::from)
}

/// Reads a single commit, or `None` if `reference` doesn't resolve to one.
///
/// ```js
/// await invoke('get_commit', { repositoryPath, reference: 'HEAD' })
/// ```
#[tauri::command]
pub async fn get_commit(
    repository_path: String,
    reference: String,
) -> Result<Option<Commit>, CommandError> {
    git_ops::log::get_commit(&repository_path, &reference)
        .await
        .map_err(CommandError::from)
}

/// Reads the files a commit changed, with its line counts.
///
/// ```js
/// await invoke('get_changed_files', { repositoryPath, sha })
/// ```
#[tauri::command]
pub async fn get_changed_files(
    repository_path: String,
    sha: String,
) -> Result<ChangesetData, CommandError> {
    git_ops::log::get_changed_files(&repository_path, &sha)
        .await
        .map_err(CommandError::from)
}
