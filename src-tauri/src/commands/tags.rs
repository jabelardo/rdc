//! Tag commands.

use crate::commands::operation_lifecycle::finish_short_mutation;
use crate::commands::operation_lifecycle::start_short_mutation;
use crate::commands::CommandError;
use crate::operation_registry::OperationRegistry;
use tauri::State;
use tauri::WebviewWindow;

/// Creates an annotated tag on a commit.
#[tauri::command]
pub async fn create_tag(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
    target_commit: String,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::tag::create_tag(&repository_path, &name, &target_commit).await,
    )
}

/// Deletes a local tag.
#[tauri::command]
pub async fn delete_tag(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::tag::delete_tag(&repository_path, &name).await,
    )
}

/// Every local tag, as `[name, commit]` pairs.
///
/// Pairs rather than an object, because a tag name is an arbitrary string. An **annotated** tag maps to
/// the commit it points at, not to its tag object — see `git_ops::tag`.
#[tauri::command]
pub async fn get_all_tags(repository_path: String) -> Result<Vec<(String, String)>, CommandError> {
    let tags = git_ops::tag::get_all_tags(&repository_path)
        .await
        .map_err(CommandError::from)?;

    let mut pairs: Vec<(String, String)> = tags.into_iter().collect();
    // git's own order isn't meaningful once it's a map, so sort for a stable result.
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(pairs)
}
