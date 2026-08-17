//! History commands exposed to the frontend.
//!
//! Reading the commit graph, and checking a commit out. Diffs between commits are
//! [`super::diffs`].
//!
//! Thin wrappers over `git_ops::log`, as elsewhere. The returned types carry the *constructor
//! arguments* of the TypeScript `Commit`/`CommittedFileChange` classes; `src/lib/log-ipc.ts` builds
//! the objects, so the fields those constructors derive have exactly one implementation.

use crate::commands::git::operation_lifecycle::abort_revert_operation;
use crate::commands::git::operation_lifecycle::finish_revert_termination;
use crate::commands::git::operation_lifecycle::run_cancellable_commit_checkout;
use crate::commands::git::operation_lifecycle::{
    finish_cherry_pick_result, finish_cherry_pick_termination, finish_rebase_result,
};
use crate::commands::CommandError;
use crate::operation::GitOperationKind;
use crate::operation::OperationError;
use crate::operation::OperationErrorKind;
use crate::operation::OperationOutcome;
use crate::operation::OperationState;
use crate::operation_registry::OperationRegistry;
use crate::operation_registry::WatchdogPolicy;
use git_ops::checkout::CheckoutProgress;
use git_ops::cherry_pick::CherryPickResult;
use git_ops::cherry_pick::CherryPickSnapshot;
use git_ops::log::ChangesetData;
use git_ops::log::Commit;
use git_ops::rebase::MultiCommitOperationProgress;
use git_ops::rebase::RebaseResult;
use git_ops::rev_list::CommitOneLine;
use git_ops::revert::RevertProgress;
use git_ops::stage::ManualConflictResolution;
use git_ops::status::AheadBehind;
use git_ops::status::AppFileStatus;
use tauri::ipc::Channel;
use tauri::State;
use tauri::WebviewWindow;

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
    let operation = crate::commands::operations::start_cancellable_repository_operation(
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

/// Cherry-picks commits onto the current branch, oldest first.
///
/// ```js
/// await invoke('cherry_pick', {
///   repositoryPath,
///   commits: [{ sha, summary }],
///   onProgress,
/// })
/// ```
///
/// Resolves to a `CherryPickResult` string rather than rejecting on conflicts — conflicts are an
/// expected outcome the UI drives to resolution.
#[tauri::command]
pub async fn cherry_pick(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    commits: Vec<CommitOneLine>,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<CherryPickResult, CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::CherryPick,
        "Cancel cherry-pick",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::cherry_pick::cherry_pick_controlled(
        &repository_path,
        &commits,
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
        Some(control),
    )
    .await;
    watchdog.abort();
    if let Err(git_ops::GitError::OperationTerminated { reason, .. }) = &result {
        return finish_cherry_pick_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            *reason,
        )
        .await;
    }
    finish_cherry_pick_result(&registry, &operation.id, result)
}

/// Reconstructs an interrupted cherry-pick, or `null` if none is in progress.
///
/// Lets a reopened frontend recover state it never saw the Channel events for.
#[tauri::command]
pub async fn get_cherry_pick_snapshot(
    repository_path: String,
) -> Result<Option<CherryPickSnapshot>, CommandError> {
    git_ops::cherry_pick::get_cherry_pick_snapshot(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Continues a cherry-pick once conflicts are resolved.
///
/// ```js
/// await invoke('continue_cherry_pick', {
///   repositoryPath,
///   files: [['f.txt', { kind: 'Modified' }]],
///   manualResolutions: [['f.txt', 'theirs']],
///   onProgress,
/// })
/// ```
///
/// `files` is `[path, status]` pairs — pairs because a path is an arbitrary string. Untracked entries
/// are excluded automatically, so unrelated work isn't swept into the commit.
#[tauri::command]
pub async fn continue_cherry_pick(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    files: Vec<(String, AppFileStatus)>,
    manual_resolutions: Option<Vec<(String, ManualConflictResolution)>>,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<CherryPickResult, CommandError> {
    let operation =
        crate::commands::operations::active_repository_operation(&registry, &repository_path)
            .await?
            .ok_or_else(|| {
                CommandError::message("no active cherry-pick operation owns this repository")
            })?;
    let result = git_ops::cherry_pick::continue_cherry_pick(
        &repository_path,
        &files,
        &manual_resolutions.unwrap_or_default(),
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
    )
    .await;
    finish_cherry_pick_result(&registry, &operation.id, result)
}

/// Abandons the cherry-pick, restoring the branch to where it started.
#[tauri::command]
pub async fn abort_cherry_pick(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation =
        crate::commands::operations::active_repository_operation(&registry, &repository_path)
            .await?;
    let result = git_ops::cherry_pick::abort_cherry_pick(&repository_path).await;
    match result {
        Ok(()) => {
            if let Some(operation) = operation {
                let _ = registry.finish(
                    &operation.id,
                    OperationState::Cancelled,
                    OperationOutcome::Recovered,
                    None,
                );
            }
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            if let Some(operation) = operation {
                let _ = registry.finish(
                    &operation.id,
                    OperationState::Failed,
                    OperationOutcome::Unknown,
                    Some(OperationError {
                        kind: OperationErrorKind::RecoveryFailed,
                        message: message.clone(),
                        recoverable: false,
                    }),
                );
            }
            Err(command_error)
        }
    }
}

/// Squashes commits together.
///
/// ```js
/// await invoke('squash', {
///   repositoryPath,
///   toSquash: [sha1, sha2],
///   squashOnto: sha3,
///   lastRetainedCommitRef: sha0,   // null reaches the root of the branch
///   commitMessage: 'combined',
///   onProgress,
/// })
/// ```
///
/// The replay order is the **log's**, not the order `toSquash` is given in — so squashing the last two
/// commits gives the same result whichever the user selects as the target.
///
/// Resolves to a `RebaseResult` string. A validation failure — an empty list, a target that is also in
/// the list, a target not in the log — comes back as `Error` rather than rejecting.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn squash(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    to_squash: Vec<String>,
    squash_onto: String,
    last_retained_commit_ref: Option<String>,
    commit_message: Option<String>,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<RebaseResult, CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Rebase,
        "Cancel squash",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::squash::squash_controlled(
        &repository_path,
        &to_squash,
        &squash_onto,
        last_retained_commit_ref.as_deref(),
        commit_message.as_deref().unwrap_or_default(),
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
        Some(control),
    )
    .await;
    watchdog.abort();
    if let Err(git_ops::GitError::OperationTerminated { reason, .. }) = &result {
        return crate::commands::git::operation_lifecycle::recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            *reason,
        )
        .await;
    }
    finish_rebase_result(&registry, &operation.id, result)
}

/// Moves commits so they sit immediately before another.
///
/// ```js
/// await invoke('reorder', {
///   repositoryPath,
///   toMove: [sha1],
///   before: sha2,                  // null moves them to the end of history
///   lastRetainedCommitRef: sha0,
///   onProgress,
/// })
/// ```
///
/// The moved commits keep their relative log order regardless of how `toMove` is ordered.
#[tauri::command]
pub async fn reorder(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    to_move: Vec<String>,
    before: Option<String>,
    last_retained_commit_ref: Option<String>,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<RebaseResult, CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Rebase,
        "Cancel reorder",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::reorder::reorder_controlled(
        &repository_path,
        &to_move,
        before.as_deref(),
        last_retained_commit_ref.as_deref(),
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
        Some(control),
    )
    .await;
    watchdog.abort();
    if let Err(git_ops::GitError::OperationTerminated { reason, .. }) = &result {
        return crate::commands::git::operation_lifecycle::recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            *reason,
        )
        .await;
    }
    finish_rebase_result(&registry, &operation.id, result)
}
