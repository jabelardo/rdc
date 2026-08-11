//! Operation lifecycle queries used by windows joining an existing operation.

use git_ops::operation_identity::resolve_repository_identity;
use tauri::State;

use crate::{
    operation::{OperationEvent, OperationRecord, OperationScope},
    operation_registry::OperationRegistry,
};

use super::CommandError;

/// Returns the operation currently owning `repository_path`, if any.
///
/// The selected path may be a subdirectory or a linked worktree. Resolve it through git-ops so
/// the query uses the same common-repository lock identity as operation start, rather than using
/// the renderer's lexical path as an application-wide key.
#[tauri::command]
pub async fn get_active_operation_for_repository(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<Option<OperationRecord>, CommandError> {
    let Some(identity) = resolve_repository_identity(&repository_path)
        .await
        .map_err(CommandError::from)?
    else {
        return Ok(None);
    };

    Ok(registry.active_for_scope(&OperationScope::Repository {
        lock_key: identity.lock_key.display().to_string(),
        repository_path: identity.top_level_working_directory.display().to_string(),
    }))
}

/// Replays the latest retained event for an operation after a renderer joins it.
#[tauri::command]
pub fn get_latest_operation_event(
    registry: State<'_, OperationRegistry>,
    operation_id: String,
) -> Result<Option<OperationEvent>, CommandError> {
    Ok(registry.latest_event(&operation_id))
}
