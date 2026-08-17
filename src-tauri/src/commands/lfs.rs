//! Git LFS: detecting it, and installing its filters and hooks.

use crate::commands::operation_lifecycle::finish_short_mutation;
use crate::commands::operation_lifecycle::start_short_mutation;
use crate::commands::CommandError;
use crate::operation_registry::OperationRegistry;
use tauri::State;
use tauri::WebviewWindow;

/// Installs LFS's global filters, so `git lfs` works for every repository.
///
/// `force` overwrites filters someone else configured. Without it, git refuses rather than silently taking
/// them over.
///
/// Takes no repository, because the operation isn't about one — but git still needs *a* working directory that
/// exists, so it runs in the temp directory. Same reasoning as `GlobalConfig` in `git_ops::config`, which the
/// original solved by using its own install directory.
#[tauri::command]
pub async fn install_global_lfs_filters(force: Option<bool>) -> Result<(), CommandError> {
    git_ops::lfs::install_global_lfs_filters(std::env::temp_dir(), force.unwrap_or(false))
        .await
        .map_err(CommandError::from)
}

/// Installs LFS's hooks in one repository.
#[tauri::command]
pub async fn install_lfs_hooks(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    force: Option<bool>,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::lfs::install_lfs_hooks(&repository_path, force.unwrap_or(false)).await,
    )
}

/// Whether the repository has any LFS-tracked patterns configured.
#[tauri::command]
pub async fn is_using_lfs(repository_path: String) -> Result<bool, CommandError> {
    git_ops::lfs::is_using_lfs(&repository_path)
        .await
        .map_err(CommandError::from)
}
