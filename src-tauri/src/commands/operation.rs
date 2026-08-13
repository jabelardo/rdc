//! Operation lifecycle queries used by windows joining an existing operation.

use git_ops::operation_identity::resolve_repository_identity;
use tauri::{State, WebviewWindow};

use crate::{
    operation::{OperationEvent, OperationRecord, OperationScope},
    operation_registry::OperationRegistry,
};

use super::CommandError;

fn cancellation_is_authorized(
    owner_window: Option<&str>,
    requesting_window: &str,
    confirm_observer: bool,
) -> bool {
    let is_owner = owner_window == Some(requesting_window);
    is_owner || owner_window.is_none() || confirm_observer
}

async fn repository_scope(repository_path: &str) -> Result<Option<OperationScope>, CommandError> {
    let Some(identity) = resolve_repository_identity(repository_path)
        .await
        .map_err(CommandError::from)?
    else {
        return Ok(None);
    };

    Ok(Some(OperationScope::Repository {
        lock_key: identity.lock_key.display().to_string(),
        repository_path: identity.top_level_working_directory.display().to_string(),
    }))
}

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
    let Some(scope) = repository_scope(&repository_path).await? else {
        return Ok(None);
    };
    Ok(registry.active_for_scope(&scope))
}

/// Returns the operation currently reserving a clone destination, including before the repository
/// exists. Clone uses this separate scope because repository identity cannot be resolved yet.
#[tauri::command]
pub fn get_active_operation_for_clone_destination(
    registry: State<'_, OperationRegistry>,
    destination_path: String,
) -> Result<Option<OperationRecord>, CommandError> {
    let lock_key = git_ops::operation_identity::clone_destination_lock_key(&destination_path);
    let scope = OperationScope::CloneDestination {
        lock_key: lock_key.to_string_lossy().into_owned(),
        destination_path: lock_key.to_string_lossy().into_owned(),
    };
    Ok(registry.active_for_scope(&scope))
}

/// Resolves the stable operation scope even when the repository is currently idle.
#[tauri::command]
pub async fn get_operation_scope_for_repository(
    repository_path: String,
) -> Result<Option<OperationScope>, CommandError> {
    repository_scope(&repository_path).await
}

/// Acquires the native repository lock for a mutating command.
pub async fn start_repository_operation(
    registry: &OperationRegistry,
    repository_path: &str,
    owner_window: Option<String>,
    operation: crate::operation::GitOperationKind,
) -> Result<OperationRecord, CommandError> {
    let Some(scope) = repository_scope(repository_path).await? else {
        return Err(CommandError::message(format!(
            "cannot start an operation outside a Git repository: {repository_path}"
        )));
    };
    registry
        .start(
            scope,
            owner_window,
            operation,
            crate::operation::CancellationCapability::Unavailable,
        )
        .map_err(|error| CommandError::message(error.to_string()))
}

/// Acquires a repository lock whose process may be cancelled by its operation ID.
pub async fn start_cancellable_repository_operation(
    registry: &OperationRegistry,
    repository_path: &str,
    owner_window: Option<String>,
    operation: crate::operation::GitOperationKind,
    label: impl Into<String>,
) -> Result<OperationRecord, CommandError> {
    let Some(scope) = repository_scope(repository_path).await? else {
        return Err(CommandError::message(format!(
            "cannot start an operation outside a Git repository: {repository_path}"
        )));
    };
    registry
        .start(
            scope,
            owner_window,
            operation,
            crate::operation::CancellationCapability::Available {
                label: label.into(),
            },
        )
        .map_err(|error| CommandError::message(error.to_string()))
}

/// Finds the active operation owning a repository, including an operation retained for recovery.
pub async fn active_repository_operation(
    registry: &OperationRegistry,
    repository_path: &str,
) -> Result<Option<OperationRecord>, CommandError> {
    let Some(scope) = repository_scope(repository_path).await? else {
        return Ok(None);
    };
    Ok(registry.active_for_scope(&scope))
}

/// Replays the latest retained event for an operation after a renderer joins it.
#[tauri::command]
pub fn get_latest_operation_event(
    registry: State<'_, OperationRegistry>,
    operation_id: String,
) -> Result<Option<OperationEvent>, CommandError> {
    Ok(registry.latest_event(&operation_id))
}

/// Requests cancellation from the owner window or from an observer after explicit confirmation.
#[tauri::command]
pub fn request_operation_cancellation(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    operation_id: String,
    confirm_observer: bool,
) -> Result<OperationRecord, CommandError> {
    let record = registry
        .get(&operation_id)
        .ok_or_else(|| CommandError::message(format!("operation {operation_id} was not found")))?;
    if !cancellation_is_authorized(
        record.owner_window.as_deref(),
        window.label(),
        confirm_observer,
    ) {
        return Err(CommandError::message(
            "cancellation requires confirmation because this operation belongs to another window",
        ));
    }

    registry
        .request_cancellation(&operation_id)
        .map_err(|error| CommandError::message(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::cancellation_is_authorized;

    #[test]
    fn owner_can_cancel_without_confirmation() {
        assert!(cancellation_is_authorized(
            Some("window-a"),
            "window-a",
            false
        ));
    }

    #[test]
    fn observer_must_confirm_before_cancelling() {
        assert!(!cancellation_is_authorized(
            Some("window-a"),
            "window-b",
            false
        ));
        assert!(cancellation_is_authorized(
            Some("window-a"),
            "window-b",
            true
        ));
    }

    #[test]
    fn an_operation_without_an_owner_can_be_adopted() {
        assert!(cancellation_is_authorized(None, "window-b", false));
    }
}
