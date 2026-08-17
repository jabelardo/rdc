//! Conflict resolution: staging what the user resolved, and abandoning the merge.
//!
//! Both commands run only while a merge is in progress. Starting the merge is [`super::branches`];
//! what the conflict recovery does when one is terminated is [`super::operation_lifecycle`].

use crate::commands::git::operation_lifecycle::finish_checkout_mutation;
use crate::commands::CommandError;
use crate::operation::GitOperationKind;
use crate::operation::OperationError;
use crate::operation::OperationErrorKind;
use crate::operation::OperationOutcome;
use crate::operation::OperationState;
use crate::operation_registry::OperationRegistry;
use git_ops::stage::ResolvedConflict;
use tauri::State;
use tauri::WebviewWindow;

/// Aborts an in-progress merge.
#[tauri::command]
pub async fn abort_merge(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation =
        crate::commands::operations::active_repository_operation(&registry, &repository_path)
            .await?;
    let squash = git_ops::merge::is_squash_merge_in_progress(&repository_path).await;
    let result = match squash {
        Ok(true) => git_ops::merge::abort_squash_merge(&repository_path).await,
        Ok(false) => git_ops::merge::abort_merge(&repository_path).await,
        Err(error) => Err(error),
    };
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
            let command_error = CommandError::from(error);
            if let Some(operation) = operation {
                let _ = registry.finish(
                    &operation.id,
                    OperationState::Failed,
                    OperationOutcome::Unknown,
                    Some(OperationError {
                        kind: OperationErrorKind::RecoveryFailed,
                        message: command_error.message.clone(),
                        recoverable: false,
                    }),
                );
            }
            Err(command_error)
        }
    }
}

/// Stages the conflicts the user has finished with.
///
/// ```js
/// await invoke('stage_resolved_conflict_files', {
///   repositoryPath,
///   files: [{ path: 'a.txt', conflictMarkerCount: 0 }],
/// })
/// ```
///
/// A checkout refuses to run while the index holds unresolved conflicts, so anything that checks out after one
/// has to stage the resolutions first.
///
/// Two kinds count as resolved: the user picked a side in the app (`resolution`), or edited until git counted
/// **zero** conflict markers. Anything else is left alone — staging a file that still has markers in it would
/// commit them.
#[tauri::command]
pub async fn stage_resolved_conflict_files(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    files: Vec<ResolvedConflict>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_checkout_mutation(
        &registry,
        &operation.id,
        git_ops::stage::stage_resolved_conflict_files(&repository_path, &files).await,
    )
}
