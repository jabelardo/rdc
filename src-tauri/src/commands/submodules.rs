//! Submodule commands.
//!
//! Two commands, and they were in `stash.rs` — grouped there on the grounds that neither needs a
//! credential session, which is true of most of the surface and so grouped nothing.

use super::CommandError;
use crate::commands::operation_lifecycle::finish_stash_mutation;
use crate::operation::GitOperationKind;
use crate::operation_registry::OperationRegistry;
use tauri::State;
use tauri::WebviewWindow;

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
        git_ops::submodule::reset_submodule_paths(&repository_path, &paths).await,
    )
}
