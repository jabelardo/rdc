//! Reading and writing `.gitignore`.
//!
//! One module rather than four commands filed under `repositories`: they are all about a single
//! file, and both the Changes view's "ignore this" action and repository settings reach for them.

use crate::commands::operation_lifecycle::{finish_short_mutation, start_short_mutation};
use crate::commands::CommandError;
use crate::operation_registry::OperationRegistry;
use tauri::{State, WebviewWindow};

/// Reads the repository's root `.gitignore`, or `null` if there isn't one.
#[tauri::command]
pub async fn read_gitignore_at_root(
    repository_path: String,
) -> Result<Option<String>, CommandError> {
    git_ops::gitignore::read_gitignore_at_root(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Writes the repository's root `.gitignore`.
///
/// Empty text **removes the file** rather than leaving an empty one, which is what the original did — an
/// empty `.gitignore` and no `.gitignore` mean the same thing to git, and leaving one behind shows up as a
/// change the user didn't make.
///
/// The line endings written follow `core.autocrlf` and `core.safecrlf`, so the file matches what the rest of
/// the repository uses.
#[tauri::command]
pub async fn save_gitignore(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    text: String,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::gitignore::save_gitignore(&repository_path, &text).await,
    )
}

/// Appends ignore patterns to the root `.gitignore`, as written.
///
/// ```js
/// await invoke('append_ignore_rules', { repositoryPath, patterns: ['*.log', 'build/'] })
/// ```
///
/// For patterns the user typed, so nothing is escaped: `*` and `?` are what make a pattern a pattern.
#[tauri::command]
pub async fn append_ignore_rules(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    patterns: Vec<String>,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::gitignore::append_ignore_rules(&repository_path, &patterns).await,
    )
}

/// Appends *file names* to the root `.gitignore`, escaping them.
///
/// ```js
/// await invoke('append_ignore_files', { repositoryPath, paths: ['weird[1].txt'] })
/// ```
///
/// The counterpart to `append_ignore_rules`: these are names, not patterns, so glob characters in them are
/// escaped — otherwise ignoring `weird[1].txt` would quietly ignore something else.
#[tauri::command]
pub async fn append_ignore_files(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::gitignore::append_ignore_files(&repository_path, &paths).await,
    )
}
