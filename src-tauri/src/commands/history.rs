//! History commands exposed to the frontend.
//!
//! Reading the commit graph, and checking a commit out. Diffs between commits are
//! [`super::diffs`].
//!
//! Thin wrappers over `git_ops::log`, as elsewhere. The returned types carry the *constructor
//! arguments* of the TypeScript `Commit`/`CommittedFileChange` classes; `src/lib/log-ipc.ts` builds
//! the objects, so the fields those constructors derive have exactly one implementation.

use crate::commands::operation_lifecycle::run_cancellable_commit_checkout;
use crate::commands::CommandError;
use crate::operation_registry::OperationRegistry;
use git_ops::checkout::CheckoutProgress;
use git_ops::log::{ChangesetData, Commit};
use git_ops::status::AheadBehind;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

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

/// Checks out a commit, leaving `HEAD` detached.
///
/// ```js
/// await invoke('checkout_commit', { repositoryPath, commit: sha })
/// ```
#[tauri::command]
pub async fn checkout_commit(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    commit: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    run_cancellable_commit_checkout(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        &commit,
        on_progress,
    )
    .await
}

/// How many commits each side of `range` has that the other does not.
///
/// ```js
/// await invoke('get_ahead_behind', { repositoryPath, range: 'main...origin/main' })
/// // -> { ahead: 1, behind: 2 }
/// ```
///
/// The range is built by the caller — `revRange`, `revSymmetricDifference` in `src/lib/rev-range.ts` — because
/// it is string concatenation and needs no round trip.
///
/// `null` means the question cannot be asked: a ref in the range no longer exists, most often a deleted
/// upstream. That is an answer rather than a failure, since a caller with nothing to put in a label should not
/// be handling an error.
#[tauri::command]
pub async fn get_ahead_behind(
    repository_path: String,
    range: String,
) -> Result<Option<AheadBehind>, CommandError> {
    git_ops::rev_list::get_ahead_behind(&repository_path, &range)
        .await
        .map_err(CommandError::from)
}
