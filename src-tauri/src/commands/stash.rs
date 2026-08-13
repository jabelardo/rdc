//! Stash and cherry-pick commands.
//!
//! Both are local operations, so unlike `commands::remote` they need no credential session.

use tauri::ipc::Channel;

use git_ops::cherry_pick::{CherryPickResult, CherryPickSnapshot};
use git_ops::rebase::{MultiCommitOperationProgress, RebaseResult};
use git_ops::rev_list::CommitOneLine;
use git_ops::stage::ManualConflictResolution;
use git_ops::stash::{StashEntry, StashResult};
use git_ops::status::AppFileStatus;
use git_ops::update_index::FileToStage;

use super::CommandError;
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::{OperationRegistry, WatchdogPolicy};
use tauri::{State, WebviewWindow};

/// Lists the app's stash entries and counts all of them.
///
/// ```js
/// await invoke('get_stashes', { repositoryPath })
/// ```
///
/// `stashEntryCount` includes stashes made outside the app. The original reported one fewer than
/// existed — see `MIGRATION_MAP.md` §8.
#[tauri::command]
pub async fn get_stashes(repository_path: String) -> Result<StashResult, CommandError> {
    git_ops::stash::get_stashes(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Stashes the working directory, resolving to whether anything was stashed.
///
/// ```js
/// await invoke('create_stash_entry', {
///   repositoryPath, branchName: 'main',
///   untrackedFilesToStage: [{ path: 'new.ts' }],
///   selectedFiles: null,     // null stashes everything
/// })
/// ```
///
/// `untrackedFilesToStage` must be supplied separately because `git stash push` with a pathspec ignores
/// untracked files — they have to be staged first to be included.
#[tauri::command]
pub async fn create_stash_entry(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    branch_name: String,
    untracked_files_to_stage: Option<Vec<FileToStage>>,
    selected_files: Option<Vec<String>>,
) -> Result<bool, CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_stash_mutation(
        &registry,
        &operation.id,
        git_ops::stash::create_stash_entry(
            &repository_path,
            &branch_name,
            &untracked_files_to_stage.unwrap_or_default(),
            selected_files.as_deref(),
        )
        .await,
    )
}

/// Drops the app's stash entry with the given commit. Dropping an unknown one succeeds.
#[tauri::command]
pub async fn drop_stash_entry(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    stash_sha: String,
) -> Result<(), CommandError> {
    let operation = start_stash_operation(&window, &registry, &repository_path).await?;
    finish_stash_mutation(
        &registry,
        &operation.id,
        git_ops::stash::drop_stash_entry(&repository_path, &stash_sha).await,
    )
}

/// Applies the stash entry with the given commit and removes it.
///
/// A pop that conflicts is not an error — the entry is still removed, and the caller drives resolution.
#[tauri::command]
pub async fn pop_stash_entry(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    stash_sha: String,
) -> Result<(), CommandError> {
    let operation = start_stash_operation(&window, &registry, &repository_path).await?;
    finish_stash_mutation(
        &registry,
        &operation.id,
        git_ops::stash::pop_stash_entry(&repository_path, &stash_sha).await,
    )
}

/// The app's most recent stash for a branch, or `null`.
#[tauri::command]
pub async fn get_last_stash_entry_for_branch(
    repository_path: String,
    branch_name: String,
) -> Result<Option<StashEntry>, CommandError> {
    git_ops::stash::get_last_stash_entry_for_branch(&repository_path, &branch_name)
        .await
        .map_err(CommandError::from)
}

/// Sets or clears a stash entry's name, resolving to its new SHA — or `null` if nothing changed.
///
/// A blank or whitespace-only name clears it. `null` when unchanged matters: rebuilding the entry would
/// change its SHA and invalidate whatever the caller holds.
#[tauri::command]
pub async fn rename_stash_entry(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    entry: StashEntry,
    new_name: Option<String>,
) -> Result<Option<String>, CommandError> {
    let operation = start_stash_operation(&window, &registry, &repository_path).await?;
    finish_stash_mutation(
        &registry,
        &operation.id,
        git_ops::stash::rename_stash_entry(&repository_path, &entry, new_name.as_deref()).await,
    )
}

/// Re-associates a stash entry with a different branch, resolving to its new SHA.
#[tauri::command]
pub async fn move_stash_entry(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    entry: StashEntry,
    branch_name: String,
) -> Result<String, CommandError> {
    let operation = start_stash_operation(&window, &registry, &repository_path).await?;
    finish_stash_mutation(
        &registry,
        &operation.id,
        git_ops::stash::move_stash_entry(&repository_path, &entry, &branch_name).await,
    )
}

/// The files a stash entry touches.
#[tauri::command]
pub async fn get_stashed_files(
    repository_path: String,
    stash_sha: String,
) -> Result<Vec<git_ops::log::CommittedFileChange>, CommandError> {
    git_ops::stash::get_stashed_files(&repository_path, &stash_sha)
        .await
        .map_err(CommandError::from)
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
    let operation = crate::commands::operation::start_cancellable_repository_operation(
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

async fn finish_cherry_pick_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    reason: git_ops::TerminationReason,
) -> Result<CherryPickResult, CommandError> {
    // A stop request can race with Git's final commit. Only abort while the sequencer still exists;
    // otherwise an unconditional `cherry-pick --abort` would undo a pick that already completed.
    let snapshot = git_ops::cherry_pick::get_cherry_pick_snapshot(repository_path)
        .await
        .map_err(|error| finish_cherry_pick_recovery_failure(registry, operation_id, error))?;
    let marker_present = git_ops::cherry_pick::is_cherry_pick_in_progress(repository_path)
        .await
        .map_err(|error| finish_cherry_pick_recovery_failure(registry, operation_id, error))?;
    if snapshot.is_none() && !marker_present {
        let current_head = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_cherry_pick_recovery_failure(registry, operation_id, error))?;
        if current_head != pre_operation_head {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(CherryPickResult::CompletedWithoutError);
        }

        let (state, kind, verb) = termination_details(reason);
        let message = format!("Cherry-pick {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    let recovery = git_ops::cherry_pick::abort_cherry_pick(repository_path).await;
    match recovery {
        Ok(()) => {
            let (state, _, verb) = termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!(
                "Cherry-pick {verb} and recovered"
            )))
        }
        Err(error) => Err(finish_cherry_pick_recovery_failure(
            registry,
            operation_id,
            error,
        )),
    }
}

fn termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

fn finish_cherry_pick_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
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
        crate::commands::operation::active_repository_operation(&registry, &repository_path)
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
        crate::commands::operation::active_repository_operation(&registry, &repository_path)
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

async fn start_stash_operation(
    window: &WebviewWindow,
    registry: &OperationRegistry,
    repository_path: &str,
) -> Result<crate::operation::OperationRecord, CommandError> {
    crate::commands::operation::start_repository_operation(
        registry,
        repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await
}

fn finish_stash_mutation<T>(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<T, git_ops::GitError>,
) -> Result<T, CommandError> {
    match result {
        Ok(value) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(value)
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
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

fn finish_cherry_pick_result(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<CherryPickResult, git_ops::GitError>,
) -> Result<CherryPickResult, CommandError> {
    match result {
        Ok(
            result @ (CherryPickResult::ConflictsEncountered
            | CherryPickResult::OutstandingFilesNotStaged),
        ) => {
            let _ = registry.enter_recovery(operation_id);
            Ok(result)
        }
        Ok(result) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
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

/// Lists the top-level submodules.
///
/// ```js
/// await invoke('list_submodules', { repositoryPath })
/// ```
///
/// `describe` is absent for an uninitialized or conflicted submodule, where git reports none. Those
/// entries **are** listed — the original dropped them, which matters because this list is what stops a
/// submodule path being moved to the trash. See `MIGRATION_MAP.md` §8.
#[tauri::command]
pub async fn list_submodules(
    repository_path: String,
) -> Result<Vec<git_ops::submodule::SubmoduleEntry>, CommandError> {
    git_ops::submodule::list_submodules(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Restores submodule paths to the commits the containing repository records.
///
/// ```js
/// await invoke('reset_submodule_paths', { repositoryPath, paths: ['sub'] })
/// ```
///
/// **Discards whatever the submodule's working tree currently has.** An empty list is a no-op.
#[tauri::command]
pub async fn reset_submodule_paths(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_stash_mutation(
        &registry,
        &operation.id,
        git_ops::submodule::reset_submodule_paths(&repository_path, &paths).await,
    )
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
    let operation = crate::commands::operation::start_cancellable_repository_operation(
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
        return crate::commands::git::recover_rebase_termination(
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
    let operation = crate::commands::operation::start_cancellable_repository_operation(
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
        return crate::commands::git::recover_rebase_termination(
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

fn finish_rebase_result(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<RebaseResult, git_ops::GitError>,
) -> Result<RebaseResult, CommandError> {
    match result {
        Ok(
            result @ (RebaseResult::ConflictsEncountered | RebaseResult::OutstandingFilesNotStaged),
        ) => {
            let _ = registry.enter_recovery(operation_id);
            Ok(result)
        }
        Ok(result) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
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

#[cfg(test)]
mod termination_tests {
    use super::*;

    #[test]
    fn classifies_cherry_pick_cancellation_and_timeout() {
        assert_eq!(
            termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }
}

#[cfg(test)]
mod cherry_pick_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_cherry_pick_and_releases_the_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("conflict.txt"), "base\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        run_git(directory.path(), &["checkout", "-qb", "feature"]);
        std::fs::write(directory.path().join("conflict.txt"), "feature\n")
            .expect("feature file should be written");
        run_git(directory.path(), &["commit", "-qam", "feature change"]);
        let feature_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        run_git(directory.path(), &["checkout", "-q", "main"]);
        std::fs::write(directory.path().join("conflict.txt"), "main\n")
            .expect("main file should be written");
        run_git(directory.path(), &["commit", "-qam", "main change"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        let cherry_pick = Command::new("git")
            .args(["cherry-pick", &feature_head])
            .current_dir(directory.path())
            .output()
            .expect("cherry-pick should start");
        assert!(
            !cherry_pick.status.success(),
            "cherry-pick should stop with a conflict"
        );

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::CherryPick,
                CancellationCapability::Available {
                    label: "Cancel cherry-pick".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = finish_cherry_pick_termination(
            &registry,
            &operation.id,
            &repository_path,
            &original_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should be reported to the caller"
        );
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("conflict.txt"))
                .expect("worktree file should be readable"),
            "main\n"
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_late_cherry_pick_stop_as_completed() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "one\n")
            .expect("first file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "first"]);
        let pre_operation_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("file.txt"), "two\n")
            .expect("second file should be written");
        run_git(directory.path(), &["commit", "-qam", "second"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::CherryPick,
                CancellationCapability::Available {
                    label: "Cancel cherry-pick".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = finish_cherry_pick_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        assert_eq!(result, CherryPickResult::CompletedWithoutError);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }
}
