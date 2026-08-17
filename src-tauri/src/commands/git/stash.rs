//! Stash and cherry-pick commands.
//!
//! Both are local operations, so unlike `commands::remote` they need no credential session.

use crate::commands::git::operation_lifecycle::{finish_stash_mutation, start_short_mutation};
use crate::commands::CommandError;
use crate::operation::GitOperationKind;
use crate::operation_registry::OperationRegistry;
use git_ops::stash::StashEntry;
use git_ops::stash::StashResult;
use git_ops::update_index::FileToStage;
use tauri::State;
use tauri::WebviewWindow;

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
    let operation = crate::commands::operations::start_repository_operation(
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
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
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
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
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
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
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
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
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
