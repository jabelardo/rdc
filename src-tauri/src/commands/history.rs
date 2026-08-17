//! History commands exposed to the frontend.
//!
//! Reading the commit graph, and checking a commit out. Diffs between commits are
//! [`super::diffs`].
//!
//! Thin wrappers over `git_ops::log`, as elsewhere. The returned types carry the *constructor
//! arguments* of the TypeScript `Commit`/`CommittedFileChange` classes; `src/lib/log-ipc.ts` builds
//! the objects, so the fields those constructors derive have exactly one implementation.

use crate::commands::operation_lifecycle::run_cancellable_commit_checkout;
use crate::commands::operation_lifecycle::{abort_revert_operation, finish_revert_termination};
use crate::commands::CommandError;
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::OperationRegistry;
use crate::operation_registry::WatchdogPolicy;
use git_ops::checkout::CheckoutProgress;
use git_ops::log::{ChangesetData, Commit};
use git_ops::revert::RevertProgress;
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

/// Creates a commit undoing another.
///
/// ```js
/// await invoke('revert_commit', { repositoryPath, commit: sha, parentCount: 1, onProgress })
/// ```
///
/// `parentCount` comes from the commit's `parentSHAs`. A merge commit needs it: reverting one is
/// ambiguous without saying which side is the mainline, and git refuses rather than guessing.
///
/// Progress `value` is always `0` — see `git_ops::revert` for why.
#[tauri::command]
pub async fn revert_commit(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    commit: String,
    parent_count: usize,
    on_progress: Channel<RevertProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Revert,
        "Cancel revert",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::revert::revert_commit_controlled(
        &repository_path,
        &commit,
        parent_count,
        Some(|progress: RevertProgress| {
            let _ = on_progress.send(progress);
        }),
        Some(control),
    )
    .await;
    watchdog.abort();
    match result {
        Ok(()) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            finish_revert_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                reason,
            )
            .await
        }
        Err(error) => {
            // A conflicted revert is a recoverable operation boundary, not a terminal command
            // failure. Git reports the conflict as a non-zero exit and leaves REVERT_HEAD for the
            // user-driven recovery flow, just as cherry-pick leaves its sequencer marker.
            if git_ops::revert::is_revert_in_progress(&repository_path)
                .await
                .unwrap_or(false)
            {
                let _ = registry.enter_recovery(&operation.id);
                return Ok(());
            }
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message,
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// Aborts an interrupted revert, restoring the branch, index and worktree when Git has revert state.
///
/// A conflicted revert enters recovery and deliberately keeps its repository write lock, so this is
/// the command that ends that operation. Releasing the lock only after Git has actually cleaned up
/// is what stops the repository from looking idle while `REVERT_HEAD` is still on disk; a failed
/// abort keeps the lock and records `recoveryFailed`, matching rebase and cherry-pick.
#[tauri::command]
pub async fn abort_revert(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    abort_revert_operation(&registry, &repository_path).await
}

/// Whether a cherry-pick is in progress.
///
/// Takes the repository path and resolves the git directory itself, because a linked worktree's `.git` is a
/// file rather than a directory — the naive join is wrong exactly where it matters.
#[tauri::command]
pub async fn is_cherry_pick_head_found(repository_path: String) -> Result<bool, CommandError> {
    let git_dir = git_ops::rev_parse::resolve_git_dir(&repository_path)
        .await
        .map_err(CommandError::from)?;

    Ok(git_ops::operation_state::is_cherry_pick_head_found(git_dir).await)
}
