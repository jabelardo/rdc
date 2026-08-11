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
use crate::operation_registry::OperationRegistry;
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
    repository_path: String,
    branch_name: String,
    untracked_files_to_stage: Option<Vec<FileToStage>>,
    selected_files: Option<Vec<String>>,
) -> Result<bool, CommandError> {
    git_ops::stash::create_stash_entry(
        &repository_path,
        &branch_name,
        &untracked_files_to_stage.unwrap_or_default(),
        selected_files.as_deref(),
    )
    .await
    .map_err(CommandError::from)
}

/// Drops the app's stash entry with the given commit. Dropping an unknown one succeeds.
#[tauri::command]
pub async fn drop_stash_entry(
    repository_path: String,
    stash_sha: String,
) -> Result<(), CommandError> {
    git_ops::stash::drop_stash_entry(&repository_path, &stash_sha)
        .await
        .map_err(CommandError::from)
}

/// Applies the stash entry with the given commit and removes it.
///
/// A pop that conflicts is not an error — the entry is still removed, and the caller drives resolution.
#[tauri::command]
pub async fn pop_stash_entry(
    repository_path: String,
    stash_sha: String,
) -> Result<(), CommandError> {
    git_ops::stash::pop_stash_entry(&repository_path, &stash_sha)
        .await
        .map_err(CommandError::from)
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
    repository_path: String,
    entry: StashEntry,
    new_name: Option<String>,
) -> Result<Option<String>, CommandError> {
    git_ops::stash::rename_stash_entry(&repository_path, &entry, new_name.as_deref())
        .await
        .map_err(CommandError::from)
}

/// Re-associates a stash entry with a different branch, resolving to its new SHA.
#[tauri::command]
pub async fn move_stash_entry(
    repository_path: String,
    entry: StashEntry,
    branch_name: String,
) -> Result<String, CommandError> {
    git_ops::stash::move_stash_entry(&repository_path, &entry, &branch_name)
        .await
        .map_err(CommandError::from)
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
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::CherryPick,
    )
    .await?;
    let result = git_ops::cherry_pick::cherry_pick(
        &repository_path,
        &commits,
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
    )
    .await;
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
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    git_ops::submodule::reset_submodule_paths(&repository_path, &paths)
        .await
        .map_err(CommandError::from)
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
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Rebase,
    )
    .await?;
    let result = git_ops::squash::squash(
        &repository_path,
        &to_squash,
        &squash_onto,
        last_retained_commit_ref.as_deref(),
        commit_message.as_deref().unwrap_or_default(),
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
    )
    .await;
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
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Rebase,
    )
    .await?;
    let result = git_ops::reorder::reorder(
        &repository_path,
        &to_move,
        before.as_deref(),
        last_retained_commit_ref.as_deref(),
        Some(|progress: MultiCommitOperationProgress| {
            let _ = on_progress.send(progress);
        }),
    )
    .await;
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
