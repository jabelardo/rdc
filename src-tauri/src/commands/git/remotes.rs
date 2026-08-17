//! Remote operations exposed to the frontend.
//!
//! These are the first commands that need both halves of the backend: `git_ops` to run git, and the
//! trampoline to answer the credential requests git makes while it runs.
//!
//! # `isBackgroundTask` is not optional in spirit
//!
//! Every command here takes it, and passing `true` for anything the user didn't initiate is what
//! stops a credential prompt appearing unbidden. It can't be inferred from the call.

use crate::commands::CommandError;
use crate::hook_state::support_for_operation;
use crate::hook_state::HookFailurePrompt;
use crate::hook_state::HookRegistry;
use crate::operation::GitOperationKind;
use crate::operation::OperationError;
use crate::operation::OperationErrorKind;
use crate::operation::OperationOutcome;
use crate::operation::OperationProgress;
use crate::operation::OperationRecord;
use crate::operation::OperationRefresh;
use crate::operation::OperationState;
use crate::operation_registry::OperationRegistry;
use crate::trampoline_state::RemoteSession;
use crate::trampoline_state::TrampolineState;
use git_ops::clone::CloneOptions;
use git_ops::clone::CloneProgress;
use git_ops::fetch::FetchProgress;
use git_ops::hooks::runner::HookProgressUpdate;
use git_ops::pull::PullProgress;
use git_ops::push::PushOptions;
use git_ops::push::PushProgress;
use git_ops::push::PushTarget;
use git_ops::remote::Remote;
use tauri::ipc::Channel;
use tauri::State;
use tauri::WebviewWindow;

/// Turns a bind failure into a command error.
///
/// The trampoline server failing to start is not a git error, so it gets no `GitErrorKind` — but it
/// does stop the operation, and saying so beats a silent authentication failure later.
fn bind_error(error: std::io::Error) -> CommandError {
    CommandError {
        message: format!("could not start the credential server: {error}"),
        kind: None,
        is_auth_failure: false,
    }
}

/// Reports a remote failure, recognising a cancelled credential prompt for what it is.
///
/// Without this the user sees git's own message — "could not read Username … terminal prompts
/// disabled" — which is accurate and useless. It appears because a credential helper that *declines*
/// makes git give up rather than trying empty credentials, so the underlying cause is invisible.
///
/// `trampoline::is_cancelled_authentication` recognises that combination, using the endpoints the
/// session recorded as rejected. This is also why the session is held for the whole operation rather
/// than dropped once its environment has been read: those rejections accumulate on it while git runs.
fn remote_error(remote: &RemoteSession, error: git_ops::GitError) -> CommandError {
    let stderr = match &error {
        git_ops::GitError::UnexpectedExitCode { stderr, .. }
        | git_ops::GitError::Terminated { stderr, .. } => stderr.as_str(),
        _ => "",
    };

    if trampoline::is_cancelled_authentication(&remote.session, stderr) {
        return CommandError {
            message: "Authentication failed: the credential prompt was cancelled".to_owned(),
            kind: Some(git_ops::GitErrorKind::HTTPSAuthenticationFailed),
            is_auth_failure: true,
        };
    }

    CommandError::from(error)
}

fn fetch_termination(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "Fetch was cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "Fetch timed out after becoming inactive",
        ),
    }
}

/// Re-read repository facts after Fetch has stopped before releasing its write lock.
async fn recover_terminated_fetch(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    reason: git_ops::TerminationReason,
) -> CommandError {
    let _ = registry.enter_recovery(operation_id);
    let recovery = tokio::try_join!(
        git_ops::remote::get_remotes(repository_path),
        git_ops::status::get_status(repository_path, true),
    );
    let (state, kind, message) = fetch_termination(reason);
    match recovery {
        Ok((_, Some(_))) => {
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Unchanged,
                Some(OperationError {
                    kind,
                    message: message.to_owned(),
                    recoverable: true,
                }),
            );
            CommandError::message(message)
        }
        Ok((_, None)) => finish_fetch_recovery_failure(
            registry,
            operation_id,
            "Fetch stopped, but the repository could not be read during recovery".to_owned(),
        ),
        Err(error) => finish_fetch_recovery_failure(
            registry,
            operation_id,
            format!("Fetch stopped, but repository recovery failed: {error}"),
        ),
    }
}

fn finish_fetch_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    message: String,
) -> CommandError {
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: true,
        }),
    );
    CommandError::message(message)
}

/// Reconciles a terminated Push against the remote before releasing its repository lock.
///
/// A local process stop cannot prove that the remote rejected the update: the server may have
/// accepted the pack just before the client disappeared. Branch pushes can therefore be classified
/// as completed only when the remote ref is readable and equals the intended local ref. Tags and
/// any failed lookup remain explicitly unknown.
#[allow(clippy::too_many_arguments)]
async fn reconcile_terminated_push(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    remote: &RemoteSession,
    remote_name: &str,
    remote_branch: &str,
    local_branch: &str,
    tags: &[String],
    reason: git_ops::TerminationReason,
) -> CommandError {
    let (state, kind, verb) = match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "Push was stopped",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "Push timed out after becoming inactive",
        ),
    };

    let local_ref = format!("refs/heads/{local_branch}");
    let reconciliation: Result<Option<bool>, git_ops::GitError> = async {
        let local_sha = git_ops::get_ref_sha(repository_path, &local_ref).await?;
        let remote_sha = git_ops::get_remote_branch_sha(
            repository_path,
            remote_name,
            remote_branch,
            &remote.env,
        )
        .await?;
        let Some(remote_sha) = remote_sha else {
            return Ok(Some(false));
        };
        if remote_sha != local_sha {
            return Ok(Some(false));
        }

        for tag in tags {
            let tag_name = tag.strip_prefix("refs/tags/").unwrap_or(tag);
            let local_tag_ref = format!("refs/tags/{tag_name}");
            let local_tag_sha = git_ops::get_ref_sha(repository_path, &local_tag_ref).await?;
            let remote_tag_sha = git_ops::get_remote_ref_sha(
                repository_path,
                remote_name,
                &local_tag_ref,
                &remote.env,
            )
            .await?;
            if remote_tag_sha != Some(local_tag_sha) {
                return Ok(Some(false));
            }
        }

        Ok(Some(true))
    }
    .await;

    match reconciliation {
        Ok(Some(true)) => {
            let message = format!(
                "{verb}, but the remote accepted {remote_name}/{remote_branch} before it stopped"
            );
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                Some(OperationError {
                    kind,
                    message: message.clone(),
                    recoverable: true,
                }),
            );
            CommandError::message(message)
        }
        Ok(Some(false)) | Ok(None) | Err(_) => {
            let message = format!(
                "{verb}; the remote outcome is unknown. Verify {remote_name}/{remote_branch} before trying again"
            );
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind,
                    message: message.clone(),
                    recoverable: true,
                }),
            );
            CommandError::message(message)
        }
    }
}

/// Pushes a branch to a remote.
///
/// ```js
/// const onProgress = new Channel()
/// onProgress.onmessage = progress => …
/// await invoke('push', {
///   repositoryPath, remoteName: 'origin', localBranch: 'main',
///   remoteBranch: null,          // null sets the upstream
///   tags: [], options: {}, isBackgroundTask: false, onProgress,
/// })
/// ```
///
/// `remoteBranch: null` means the branch has no upstream yet, which adds `--set-upstream` — and takes
/// precedence over `forceWithLease`, since a lease against a ref that doesn't exist would fail.
// A command's parameters *are* its wire API: grouping them into a struct to satisfy the lint would
// change the shape the frontend sends, which is the wrong reason to change an interface.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn push(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    hooks: State<'_, HookRegistry>,
    repository_path: String,
    remote_name: String,
    local_branch: String,
    remote_branch: Option<String>,
    tags: Option<Vec<String>>,
    options: Option<PushOptions>,
    is_background_task: Option<bool>,
    on_progress: Channel<PushProgress>,
    intercept_hooks: Option<bool>,
    on_hook_progress: Channel<HookProgressUpdate>,
    on_hook_failure: Channel<HookFailurePrompt>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Push,
        "Stop waiting",
    )
    .await?;
    let remote = match state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            return Err(command_error);
        }
    };
    let support = match support_for_operation(
        intercept_hooks.unwrap_or(false),
        &hooks,
        on_hook_progress,
        on_hook_failure,
        &registry,
        &operation.id,
    ) {
        Ok(support) => support,
        Err(message) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: message.clone(),
                    recoverable: true,
                }),
            );
            return Err(CommandError::message(message));
        }
    };

    let tags = tags.unwrap_or_default();
    let options = options.unwrap_or_default();
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let watchdog = registry.spawn_watchdog(
        operation.id.clone(),
        crate::operation_registry::WatchdogPolicy::default(),
    );

    let push_result = git_ops::push::push_controlled(
        &repository_path,
        PushTarget {
            remote_name: &remote_name,
            local_branch: &local_branch,
            remote_branch: remote_branch.as_deref(),
            tags: &tags,
        },
        &remote.env,
        options,
        Some(|progress: PushProgress| {
            // A closed webview drops updates rather than cancelling git, which must not be left
            // half-done.
            let _ = on_progress.send(progress);
        }),
        support.as_ref(),
        Some(control.clone()),
    )
    .await;
    let operation_id = operation.id.clone();
    let operation_registry = registry.inner().clone();
    let result = match push_result {
        Ok(_) => {
            git_ops::fetch::fetch_controlled(
                &repository_path,
                &remote_name,
                &remote.env,
                Some(|progress: FetchProgress| {
                    let _ = operation_registry.publish_progress(
                        &operation_id,
                        OperationProgress {
                            value: 0.65 + progress.value * 0.25,
                            title: Some(format!("Fetching {remote_name}")),
                            description: progress.description.clone(),
                        },
                    );
                }),
                Some(control),
            )
            .await
        }
        Err(error) => Err(error),
    };
    watchdog.abort();
    match result {
        Ok(_) => {
            let _ = registry.set_refresh(
                &operation.id,
                OperationRefresh {
                    remote_names: vec![remote_name.clone()],
                    repository_facts: true,
                },
            );
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(git_ops::GitError::OperationTerminated { name, reason, .. }) if name == "fetch" => {
            Err(recover_terminated_fetch(&registry, &operation.id, &repository_path, reason).await)
        }
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            Err(reconcile_terminated_push(
                &registry,
                &operation.id,
                &repository_path,
                &remote,
                &remote_name,
                remote_branch.as_deref().unwrap_or(&local_branch),
                &local_branch,
                &tags,
                reason,
            )
            .await)
        }
        Err(error) => {
            let command_error = remote_error(&remote, error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// Deletes a branch on a remote.
///
/// ```js
/// await invoke('delete_remote_branch', {
///   repositoryPath, remoteName: 'origin', remoteBranchName: 'topic', isBackgroundTask: false,
/// })
/// ```
///
/// No `Channel`: a deletion pushes nothing, so git reports no progress to stream.
///
/// A branch already deleted on the remote resolves rather than failing — the local remote-tracking ref
/// is cleaned up instead, which is the state the caller asked for.
#[tauri::command]
pub async fn delete_remote_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    repository_path: String,
    remote_name: String,
    remote_branch_name: String,
    is_background_task: Option<bool>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Push,
    )
    .await?;
    let remote = match state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            return Err(command_error);
        }
    };

    let result = git_ops::branch::delete_remote_branch(
        &repository_path,
        &remote_name,
        &remote_branch_name,
        &remote.env,
    )
    .await;
    match result {
        Ok(_) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let command_error = remote_error(&remote, error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// Fetches from a remote.
///
/// ```js
/// await invoke('fetch', { repositoryPath, remoteName: 'origin', isBackgroundTask: false, onProgress })
/// ```
#[tauri::command]
pub async fn fetch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    repository_path: String,
    remote_name: String,
    is_background_task: Option<bool>,
    on_progress: Channel<FetchProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Fetch,
        "Cancel fetch",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let remote = match state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            return Err(command_error);
        }
    };
    let operation_id = operation.id.clone();
    let operation_registry = registry.inner().clone();
    // Tauri drops an in-flight command future when its invoking webview is destroyed. Fetch is
    // native-owned, so run the complete process/watchdog/recovery lifecycle in a detached task and
    // merely await its result for a live caller. Dropping this JoinHandle does not abort the task.
    tauri::async_runtime::spawn(async move {
        let watchdog = operation_registry.spawn_watchdog(
            operation_id.clone(),
            crate::operation_registry::WatchdogPolicy::default(),
        );
        let progress_registry = operation_registry.clone();
        let progress_operation_id = operation_id.clone();
        let result = git_ops::fetch::fetch_controlled(
            &repository_path,
            &remote_name,
            &remote.env,
            Some(|progress: FetchProgress| {
                let _ = progress_registry.publish_progress(
                    &progress_operation_id,
                    OperationProgress {
                        value: progress.value,
                        title: Some(progress.title.clone()),
                        description: progress.description.clone(),
                    },
                );
                // The channel belongs to the invoking renderer and may close while native Fetch
                // continues. Registry events remain the durable peer-window transport.
                let _ = on_progress.send(progress);
            }),
            Some(control),
        )
        .await;
        watchdog.abort();
        match result {
            Ok(_) => {
                let _ = operation_registry.finish(
                    &operation_id,
                    OperationState::Completed,
                    OperationOutcome::Completed,
                    None,
                );
                Ok(())
            }
            Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
                Err(recover_terminated_fetch(
                    &operation_registry,
                    &operation_id,
                    &repository_path,
                    reason,
                )
                .await)
            }
            Err(error) => {
                let command_error = remote_error(&remote, error);
                let _ = operation_registry.finish(
                    &operation_id,
                    OperationState::Failed,
                    OperationOutcome::Unknown,
                    Some(OperationError {
                        kind: OperationErrorKind::Failed,
                        message: command_error.message.clone(),
                        recoverable: true,
                    }),
                );
                Err(command_error)
            }
        }
    })
    .await
    .map_err(|error| CommandError::message(format!("Fetch task failed: {error}")))?
}

/// Fetches several remotes under one repository-scoped operation.
///
/// The frontend uses this for the tracked remote plus the default remote. Keeping the transport
/// loop here means another window sees one lock, one cancellation capability and one terminal
/// outcome instead of a sequence of unrelated Fetch records.
#[tauri::command]
pub async fn fetch_workflow(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    repository_path: String,
    remote_names: Vec<String>,
    is_background_task: Option<bool>,
    on_progress: Channel<FetchProgress>,
) -> Result<OperationRecord, CommandError> {
    if remote_names.is_empty() {
        return Err(CommandError::message(
            "Fetch workflow requires at least one remote",
        ));
    }

    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Fetch,
        "Cancel fetch",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let background = is_background_task.unwrap_or(false);
    let mut sessions = Vec::with_capacity(remote_names.len());
    for remote_name in remote_names {
        match state.session_for(&repository_path, background).await {
            Ok(remote) => sessions.push((remote_name, remote)),
            Err(error) => {
                let command_error = bind_error(error);
                let _ = registry.finish(
                    &operation.id,
                    OperationState::Failed,
                    OperationOutcome::Unknown,
                    Some(OperationError {
                        kind: OperationErrorKind::Failed,
                        message: command_error.message.clone(),
                        recoverable: true,
                    }),
                );
                return Err(command_error);
            }
        }
    }

    let operation_id = operation.id.clone();
    let result_operation_id = operation_id.clone();
    let operation_registry = registry.inner().clone();
    let task_registry = operation_registry.clone();
    tauri::async_runtime::spawn(async move {
        let watchdog = task_registry.spawn_watchdog(
            operation_id.clone(),
            crate::operation_registry::WatchdogPolicy::default(),
        );
        let refresh_remote_names = sessions
            .iter()
            .map(|(remote_name, _)| remote_name.clone())
            .collect::<Vec<_>>();
        let total = sessions.len() as f64;
        let mut result = Ok(());
        for (index, (remote_name, remote)) in sessions.into_iter().enumerate() {
            let progress_registry = task_registry.clone();
            let progress_operation_id = operation_id.clone();
            let fetch_result = git_ops::fetch::fetch_controlled(
                &repository_path,
                &remote_name,
                &remote.env,
                Some(|progress: FetchProgress| {
                    let value = ((index as f64 + progress.value) / total) * 0.9;
                    let _ = progress_registry.publish_progress(
                        &progress_operation_id,
                        OperationProgress {
                            value,
                            title: Some(format!("Fetching {remote_name}")),
                            description: progress.description.clone(),
                        },
                    );
                    let _ = on_progress.send(progress);
                }),
                Some(control.clone()),
            )
            .await;

            match fetch_result {
                Ok(_) => {}
                Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
                    result = Err(recover_terminated_fetch(
                        &task_registry,
                        &operation_id,
                        &repository_path,
                        reason,
                    )
                    .await);
                    break;
                }
                Err(error) => {
                    let command_error = remote_error(&remote, error);
                    let _ = task_registry.finish(
                        &operation_id,
                        OperationState::Failed,
                        OperationOutcome::Unknown,
                        Some(OperationError {
                            kind: OperationErrorKind::Failed,
                            message: command_error.message.clone(),
                            recoverable: true,
                        }),
                    );
                    result = Err(command_error);
                    break;
                }
            }
        }
        watchdog.abort();
        if result.is_ok() {
            let _ = task_registry.set_refresh(
                &operation_id,
                OperationRefresh {
                    remote_names: refresh_remote_names,
                    repository_facts: true,
                },
            );
            let _ = task_registry.publish_progress(
                &operation_id,
                OperationProgress {
                    value: 0.9,
                    title: Some("Refreshing repository".to_owned()),
                    description: Some("Remote fetches complete".to_owned()),
                },
            );
            let _ = task_registry.finish(
                &operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
        }
        result
    })
    .await
    .map_err(|error| CommandError::message(format!("Fetch workflow task failed: {error}")))??;

    operation_registry.get(&result_operation_id).ok_or_else(|| {
        CommandError::message("Fetch workflow completed without an operation record")
    })
}

#[cfg(test)]
mod fetch_cancellation_tests {
    use std::process::Command;

    #[cfg(unix)]
    use std::time::Duration;

    use super::{fetch_termination, recover_terminated_fetch};
    use crate::operation::{
        CancellationCapability, GitOperationKind, OperationErrorKind, OperationOutcome,
        OperationProgress, OperationScope, OperationState,
    };
    use crate::operation_registry::{OperationRegistry, WatchdogPolicy};

    #[cfg(unix)]
    use git_ops::test_support::BlockingSshFetch;

    fn start_fetch(
        registry: &OperationRegistry,
        repository_path: &str,
    ) -> (OperationScope, String) {
        let scope = OperationScope::Repository {
            lock_key: repository_path.to_owned(),
            repository_path: repository_path.to_owned(),
        };
        let operation = registry
            .start(
                scope.clone(),
                Some("main".to_owned()),
                GitOperationKind::Fetch,
                CancellationCapability::Available {
                    label: "Cancel fetch".to_owned(),
                },
            )
            .expect("fetch should reserve its repository scope");
        (scope, operation.id)
    }

    fn start_pull(registry: &OperationRegistry, repository_path: &str) -> (OperationScope, String) {
        let scope = OperationScope::Repository {
            lock_key: repository_path.to_owned(),
            repository_path: repository_path.to_owned(),
        };
        let operation = registry
            .start(
                scope.clone(),
                Some("main".to_owned()),
                GitOperationKind::Pull,
                CancellationCapability::Available {
                    label: "Stop waiting".to_owned(),
                },
            )
            .expect("pull should reserve its repository scope");
        (scope, operation.id)
    }

    #[test]
    fn distinguishes_user_cancellation_from_watchdog_timeout() {
        assert_eq!(
            fetch_termination(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "Fetch was cancelled"
            )
        );
        assert_eq!(
            fetch_termination(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "Fetch timed out after becoming inactive"
            )
        );
    }

    #[tokio::test]
    async fn releases_the_repository_lock_only_after_successful_recovery() {
        let repository = tempfile::tempdir().expect("temporary repository");
        let output = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(repository.path())
            .output()
            .expect("git init should run");
        assert!(output.status.success(), "git init failed: {output:?}");

        let registry = OperationRegistry::new();
        let repository_path = repository.path().to_string_lossy().into_owned();
        let (scope, operation_id) = start_fetch(&registry, &repository_path);

        let error = recover_terminated_fetch(
            &registry,
            &operation_id,
            &repository_path,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert_eq!(error.message, "Fetch was cancelled");
        assert!(registry.active_for_scope(&scope).is_none());
        let operation = registry.get(&operation_id).expect("operation record");
        assert_eq!(operation.state, OperationState::Cancelled);
        assert_eq!(operation.outcome, Some(OperationOutcome::Unchanged));
        assert_eq!(
            operation.error.expect("typed cancellation error").kind,
            OperationErrorKind::Cancelled
        );
    }

    #[tokio::test]
    async fn retains_the_repository_lock_when_recovery_cannot_read_the_repository() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let missing_repository = parent.path().join("missing");
        let repository_path = missing_repository.to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let (scope, operation_id) = start_fetch(&registry, &repository_path);

        let error = recover_terminated_fetch(
            &registry,
            &operation_id,
            &repository_path,
            git_ops::TerminationReason::TimedOut,
        )
        .await;

        assert!(error.message.contains("repository recovery failed"));
        assert_eq!(
            registry
                .active_for_scope(&scope)
                .expect("failed recovery must retain the scope lock")
                .id,
            operation_id
        );
        let operation = registry.get(&operation_id).expect("operation record");
        assert_eq!(operation.state, OperationState::Failed);
        assert_eq!(operation.outcome, Some(OperationOutcome::Unknown));
        assert_eq!(
            operation.error.expect("typed recovery error").kind,
            OperationErrorKind::RecoveryFailed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn watchdog_times_out_blocked_fetch_then_recovers_before_releasing_the_lock() {
        let fixture = BlockingSshFetch::new().await;
        let repository = fixture.repository();
        let repository_path = repository.to_string_lossy().into_owned();
        let env = fixture.env();
        let registry = OperationRegistry::new();
        let (scope, operation_id) = start_fetch(&registry, &repository_path);
        let control = registry
            .control(&operation_id)
            .expect("Fetch should expose its process control");
        let progress_registry = registry.clone();
        let progress_operation_id = operation_id.clone();
        let task = tokio::spawn(async move {
            git_ops::fetch::fetch_controlled(
                repository,
                "origin",
                &env,
                Some(move |progress: git_ops::fetch::FetchProgress| {
                    let _ = progress_registry.publish_progress(
                        &progress_operation_id,
                        OperationProgress {
                            value: progress.value,
                            title: Some(progress.title),
                            description: progress.description,
                        },
                    );
                }),
                Some(control),
            )
            .await
        });

        fixture.wait_until_blocked().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let has_activity = registry
                    .get(&operation_id)
                    .and_then(|record| record.progress)
                    .and_then(|progress| progress.description)
                    .is_some_and(|text| text.starts_with("remote: Counting objects"));
                if has_activity {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("blocked Fetch should publish activity before timeout");

        let watchdog = registry.spawn_watchdog(
            operation_id.clone(),
            WatchdogPolicy {
                soft_inactivity: Duration::from_millis(20),
                hard_inactivity: Duration::from_millis(60),
                poll_interval: Duration::from_millis(5),
            },
        );
        tokio::time::timeout(Duration::from_secs(1), watchdog)
            .await
            .expect("short-policy watchdog should request timeout")
            .expect("watchdog should not panic");
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("watchdog should reap the blocked Fetch process tree")
            .expect("Fetch task should not panic");
        assert!(matches!(
            result,
            Err(git_ops::GitError::OperationTerminated {
                reason: git_ops::TerminationReason::TimedOut,
                ..
            })
        ));
        assert!(registry.active_for_scope(&scope).is_some());

        let error = recover_terminated_fetch(
            &registry,
            &operation_id,
            &repository_path,
            git_ops::TerminationReason::TimedOut,
        )
        .await;

        assert_eq!(error.message, "Fetch timed out after becoming inactive");
        assert!(registry.active_for_scope(&scope).is_none());
        let operation = registry.get(&operation_id).expect("terminal Fetch record");
        assert_eq!(operation.state, OperationState::TimedOut);
        assert_eq!(operation.outcome, Some(OperationOutcome::Unchanged));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pull_cancellation_routes_a_blocked_network_phase_to_fetch_recovery() {
        let fixture = BlockingSshFetch::new().await;
        let repository = fixture.repository();
        let repository_path = repository.to_string_lossy().into_owned();
        let env = fixture.env();
        let registry = OperationRegistry::new();
        let (scope, operation_id) = start_pull(&registry, &repository_path);
        let control = registry
            .control(&operation_id)
            .expect("Pull should expose the phase process control");
        let task = tokio::spawn(async move {
            git_ops::pull::pull_phased_controlled(
                repository,
                "origin",
                &env,
                false,
                None::<fn(git_ops::pull::PullProgress)>,
                None,
                Some(control),
            )
            .await
        });

        fixture.wait_until_blocked().await;
        registry
            .request_cancellation(&operation_id)
            .expect("Pull cancellation should reach the Fetch phase");
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled Pull should terminate")
            .expect("Pull task should not panic");
        assert!(matches!(
            result,
            Err(git_ops::GitError::OperationTerminated {
                name,
                reason: git_ops::TerminationReason::Cancelled,
                ..
            }) if name == "fetch"
        ));
        assert!(registry.active_for_scope(&scope).is_some());

        let error = recover_terminated_fetch(
            &registry,
            &operation_id,
            &repository_path,
            git_ops::TerminationReason::Cancelled,
        )
        .await;
        assert_eq!(error.message, "Fetch was cancelled");
        assert!(registry.active_for_scope(&scope).is_none());
        assert_eq!(
            registry.get(&operation_id).expect("Pull record").outcome,
            Some(OperationOutcome::Unchanged)
        );
    }
}

#[cfg(test)]
mod pull_cancellation_tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use crate::commands::git::operation_lifecycle::{
        recover_merge_termination, recover_rebase_termination,
    };
    use crate::operation::{
        CancellationCapability, GitOperationKind, OperationOutcome, OperationScope,
    };
    use crate::operation_registry::OperationRegistry;
    use git_ops::test_support::{commit_file, empty_repository};

    fn run_git(repository: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should run");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pull_cancellation_routes_a_blocked_merge_phase_to_merge_recovery() {
        let upstream = empty_repository().await;
        commit_file(&upstream.path(), "base.txt", "base\n", "base");
        let client = empty_repository().await;
        run_git(
            &client.path(),
            &[
                "remote",
                "add",
                "origin",
                &upstream.path().to_string_lossy(),
            ],
        );
        run_git(&client.path(), &["fetch", "origin"]);
        run_git(&client.path(), &["checkout", "-B", "main", "origin/main"]);
        run_git(
            &client.path(),
            &["branch", "--set-upstream-to=origin/main", "main"],
        );
        commit_file(&upstream.path(), "remote.txt", "remote\n", "remote change");
        commit_file(&client.path(), "local.txt", "local\n", "local change");

        let git_dir = git_ops::resolve_git_dir(client.path())
            .await
            .expect("client git directory should resolve");
        let transport = tempfile::tempdir().expect("test control directory");
        let ready = transport.path().join("ready");
        let release = transport.path().join("release");
        let hook = git_dir.join("hooks/pre-merge-commit");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\n: > '{}'\nwhile [ ! -e '{}' ]; do sleep 0.01; done\n",
                ready.display(),
                release.display()
            ),
        )
        .expect("pre-merge hook should be written");
        let mut permissions = fs::metadata(&hook)
            .expect("hook metadata should exist")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&hook, permissions).expect("hook should be executable");

        let repository_path = client.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let scope = OperationScope::Repository {
            lock_key: repository_path.clone(),
            repository_path: repository_path.clone(),
        };
        let operation = registry
            .start(
                scope.clone(),
                Some("main".to_owned()),
                GitOperationKind::Pull,
                CancellationCapability::Available {
                    label: "Stop waiting".to_owned(),
                },
            )
            .expect("Pull should reserve the repository");
        let pre_operation_head = git_ops::get_head_sha(&repository_path)
            .await
            .expect("HEAD should exist");
        let control = registry
            .control(&operation.id)
            .expect("Pull should expose process control");
        let task = tokio::spawn({
            let repository_path = repository_path.clone();
            async move {
                git_ops::pull::pull_phased_controlled(
                    &repository_path,
                    "origin",
                    &std::collections::HashMap::new(),
                    false,
                    None::<fn(git_ops::pull::PullProgress)>,
                    None,
                    Some(control),
                )
                .await
            }
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("merge hook should reach its deterministic barrier");
        registry
            .request_cancellation(&operation.id)
            .expect("Pull cancellation should reach merge integration");
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled Pull should terminate")
            .expect("Pull task should not panic");
        assert!(matches!(
            result,
            Err(git_ops::GitError::OperationTerminated {
                name,
                reason: git_ops::TerminationReason::Cancelled,
                ..
            }) if name == "pullMerge"
        ));
        assert!(registry.active_for_scope(&scope).is_some());

        let recovered = recover_merge_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            false,
            git_ops::TerminationReason::Cancelled,
        )
        .await;
        assert!(
            recovered.is_err(),
            "cancellation should remain visible to Pull"
        );
        assert!(registry.active_for_scope(&scope).is_none());
        assert!(matches!(
            registry.get(&operation.id).expect("Pull record").outcome,
            Some(OperationOutcome::Unchanged | OperationOutcome::Recovered)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pull_cancellation_routes_a_blocked_rebase_phase_to_rebase_recovery() {
        let upstream = empty_repository().await;
        commit_file(&upstream.path(), "base.txt", "base\n", "base");
        let client = empty_repository().await;
        run_git(
            &client.path(),
            &[
                "remote",
                "add",
                "origin",
                &upstream.path().to_string_lossy(),
            ],
        );
        run_git(&client.path(), &["fetch", "origin"]);
        run_git(&client.path(), &["checkout", "-B", "main", "origin/main"]);
        run_git(
            &client.path(),
            &["branch", "--set-upstream-to=origin/main", "main"],
        );
        commit_file(&upstream.path(), "remote.txt", "remote\n", "remote change");
        commit_file(&client.path(), "local.txt", "local\n", "local change");
        run_git(&client.path(), &["config", "pull.rebase", "true"]);

        let git_dir = git_ops::resolve_git_dir(client.path())
            .await
            .expect("client git directory should resolve");
        let transport = tempfile::tempdir().expect("test control directory");
        let ready = transport.path().join("ready");
        let release = transport.path().join("release");
        let hook = git_dir.join("hooks/pre-rebase");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\n: > '{}'\nwhile [ ! -e '{}' ]; do sleep 0.01; done\n",
                ready.display(),
                release.display()
            ),
        )
        .expect("pre-rebase hook should be written");
        let mut permissions = fs::metadata(&hook)
            .expect("hook metadata should exist")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&hook, permissions).expect("hook should be executable");

        let repository_path = client.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let scope = OperationScope::Repository {
            lock_key: repository_path.clone(),
            repository_path: repository_path.clone(),
        };
        let operation = registry
            .start(
                scope.clone(),
                Some("main".to_owned()),
                GitOperationKind::Pull,
                CancellationCapability::Available {
                    label: "Stop waiting".to_owned(),
                },
            )
            .expect("Pull should reserve the repository");
        let pre_operation_head = git_ops::get_head_sha(&repository_path)
            .await
            .expect("HEAD should exist");
        let control = registry
            .control(&operation.id)
            .expect("Pull should expose process control");
        let task = tokio::spawn({
            let repository_path = repository_path.clone();
            async move {
                git_ops::pull::pull_phased_controlled(
                    &repository_path,
                    "origin",
                    &std::collections::HashMap::new(),
                    false,
                    None::<fn(git_ops::pull::PullProgress)>,
                    None,
                    Some(control),
                )
                .await
            }
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("rebase hook should reach its deterministic barrier");
        registry
            .request_cancellation(&operation.id)
            .expect("Pull cancellation should reach rebase integration");
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled Pull should terminate")
            .expect("Pull task should not panic");
        assert!(matches!(
            result,
            Err(git_ops::GitError::OperationTerminated {
                name,
                reason: git_ops::TerminationReason::Cancelled,
                ..
            }) if name == "pullRebase"
        ));
        assert!(registry.active_for_scope(&scope).is_some());

        let recovered = recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await;
        assert!(
            recovered.is_err(),
            "cancellation should remain visible to Pull"
        );
        assert!(registry.active_for_scope(&scope).is_none());
        assert_eq!(
            registry.get(&operation.id).expect("Pull record").outcome,
            Some(OperationOutcome::Unchanged)
        );
    }

    #[cfg(unix)]
    #[ignore = "Git does not invoke post-commit during pull merge before the process returns"]
    #[tokio::test]
    async fn pull_cancellation_after_merge_commit_is_classified_as_completed() {
        let upstream = empty_repository().await;
        commit_file(&upstream.path(), "base.txt", "base\n", "base");
        let client = empty_repository().await;
        run_git(
            &client.path(),
            &[
                "remote",
                "add",
                "origin",
                &upstream.path().to_string_lossy(),
            ],
        );
        run_git(&client.path(), &["fetch", "origin"]);
        run_git(&client.path(), &["checkout", "-B", "main", "origin/main"]);
        run_git(
            &client.path(),
            &["branch", "--set-upstream-to=origin/main", "main"],
        );
        commit_file(&upstream.path(), "remote.txt", "remote\n", "remote change");
        commit_file(&client.path(), "local.txt", "local\n", "local change");

        let git_dir = git_ops::resolve_git_dir(client.path())
            .await
            .expect("client git directory should resolve");
        let transport = tempfile::tempdir().expect("test control directory");
        let ready = transport.path().join("ready");
        let release = transport.path().join("release");
        let hook = git_dir.join("hooks/post-commit");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\n: > '{}'\nwhile [ ! -e '{}' ]; do sleep 0.01; done\n",
                ready.display(),
                release.display()
            ),
        )
        .expect("post-commit hook should be written");
        let mut permissions = fs::metadata(&hook)
            .expect("hook metadata should exist")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&hook, permissions).expect("hook should be executable");

        let repository_path = client.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let scope = OperationScope::Repository {
            lock_key: repository_path.clone(),
            repository_path: repository_path.clone(),
        };
        let operation = registry
            .start(
                scope.clone(),
                Some("main".to_owned()),
                GitOperationKind::Pull,
                CancellationCapability::Available {
                    label: "Stop waiting".to_owned(),
                },
            )
            .expect("Pull should reserve the repository");
        let pre_operation_head = git_ops::get_head_sha(&repository_path)
            .await
            .expect("HEAD should exist");
        let control = registry
            .control(&operation.id)
            .expect("Pull should expose process control");
        let task = tokio::spawn({
            let repository_path = repository_path.clone();
            async move {
                git_ops::pull::pull_phased_controlled(
                    &repository_path,
                    "origin",
                    &std::collections::HashMap::new(),
                    false,
                    None::<fn(git_ops::pull::PullProgress)>,
                    None,
                    Some(control),
                )
                .await
            }
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("post-commit hook should reach its deterministic barrier");
        registry
            .request_cancellation(&operation.id)
            .expect("Pull cancellation should reach post-commit");
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled Pull should terminate")
            .expect("Pull task should not panic");
        assert!(matches!(
            result,
            Err(git_ops::GitError::OperationTerminated {
                name,
                reason: git_ops::TerminationReason::Cancelled,
                ..
            }) if name == "pullMerge"
        ));
        assert!(registry.active_for_scope(&scope).is_some());

        let recovered = recover_merge_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            false,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("completed merge must not be aborted");
        assert_eq!(recovered, git_ops::merge::MergeResult::Success);
        assert!(registry.active_for_scope(&scope).is_none());
        assert_eq!(
            registry.get(&operation.id).expect("Pull record").outcome,
            Some(OperationOutcome::Completed)
        );
    }
}

/// Fetches a single refspec.
///
/// ```js
/// await invoke('fetch_refspec', {
///   repositoryPath,
///   remoteName: 'origin',
///   refspec: 'refs/pull/1/head:refs/remotes/origin/pr/1',
/// })
/// ```
///
/// No progress channel, unlike [`fetch`]: a single ref is one object graph and usually a small one, and
/// the original passed no callback either.
///
/// **A refspec that doesn't exist on the remote resolves rather than rejecting.** `git_ops` treats exit
/// code 128 as success here, because the common case is a pull request ref that has since been deleted —
/// which is news about the remote, not a failure of the fetch.
#[tauri::command]
pub async fn fetch_refspec(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    repository_path: String,
    remote_name: String,
    refspec: String,
    is_background_task: Option<bool>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Fetch,
    )
    .await?;
    let remote = match state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            return Err(command_error);
        }
    };

    let result =
        git_ops::fetch::fetch_refspec(&repository_path, &remote_name, &refspec, &remote.env).await;
    match result {
        Ok(_) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let command_error = remote_error(&remote, error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// Pulls from a remote.
///
/// ```js
/// await invoke('pull', { repositoryPath, remoteName: 'origin', onProgress })
/// ```
///
/// When the branches have diverged and the user hasn't configured `pull.ff`, this reconciles with
/// `--ff` — fast-forward if possible, otherwise merge — rather than letting git refuse.
#[tauri::command]
// A command's parameters are its wire API, so grouping them to satisfy the lint would change the shape the
// frontend sends — the wrong reason to change an interface.
#[allow(clippy::too_many_arguments)]
pub async fn pull(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    hooks: State<'_, HookRegistry>,
    repository_path: String,
    remote_name: String,
    no_verify: Option<bool>,
    is_background_task: Option<bool>,
    on_progress: Channel<PullProgress>,
    intercept_hooks: Option<bool>,
    on_hook_progress: Channel<HookProgressUpdate>,
    on_hook_failure: Channel<HookFailurePrompt>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Pull,
        "Stop waiting",
    )
    .await?;
    let remote = match state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            return Err(command_error);
        }
    };
    let support = match support_for_operation(
        intercept_hooks.unwrap_or(false),
        &hooks,
        on_hook_progress,
        on_hook_failure,
        &registry,
        &operation.id,
    ) {
        Ok(support) => support,
        Err(message) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: message.clone(),
                    recoverable: true,
                }),
            );
            return Err(CommandError::message(message));
        }
    };

    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let watchdog = registry.spawn_watchdog(
        operation.id.clone(),
        crate::operation_registry::WatchdogPolicy::default(),
    );
    let result = git_ops::pull::pull_phased_controlled(
        &repository_path,
        &remote_name,
        &remote.env,
        no_verify.unwrap_or(false),
        Some(|progress: PullProgress| {
            let _ = on_progress.send(progress);
        }),
        support.as_ref(),
        Some(control),
    )
    .await;
    watchdog.abort();
    match result {
        Ok(_) => {
            let _ = registry.set_refresh(
                &operation.id,
                OperationRefresh {
                    remote_names: vec![remote_name.clone()],
                    repository_facts: true,
                },
            );
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(git_ops::GitError::OperationTerminated { name, reason, .. }) if name == "fetch" => {
            Err(recover_terminated_fetch(&registry, &operation.id, &repository_path, reason).await)
        }
        Err(git_ops::GitError::OperationTerminated { name, reason, .. }) if name == "pullMerge" => {
            match crate::commands::git::operation_lifecycle::recover_merge_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                false,
                reason,
            )
            .await
            {
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            }
        }
        Err(git_ops::GitError::OperationTerminated { name, reason, .. })
            if name == "pullRebase" =>
        {
            match crate::commands::git::operation_lifecycle::recover_rebase_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                reason,
            )
            .await
            {
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            }
        }
        Err(error) => {
            let command_error = remote_error(&remote, error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// Fast-forwards local branches to their upstreams without checking them out.
///
/// ```js
/// await invoke('fast_forward_branches', {
///   repositoryPath,
///   branches: [['refs/remotes/origin/main', 'refs/heads/main']],
/// })
/// ```
///
/// Pairs rather than an object, for the usual reason: a ref name is an arbitrary string. Branches that
/// have diverged are left alone rather than failing the call.
#[tauri::command]
pub async fn fast_forward_branches(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    branches: Vec<(String, String)>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Fetch,
    )
    .await?;
    let result = git_ops::fetch::fast_forward_branches(&repository_path, &branches).await;
    match result {
        Ok(()) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// Clones a repository into `path`.
///
/// ```js
/// await invoke('clone', {
///   url: 'https://github.com/o/r.git',
///   path: '/home/me/r',
///   login: null,          // inserted as userinfo to pick an account
///   options: {}, onProgress,
/// })
/// ```
///
/// The session is keyed on the **destination**, not the source, because that is where the credential
/// helper will look for configuration — and the destination doesn't exist yet, so this is the one
/// operation whose session path is created rather than found.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn clone(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    url: String,
    path: String,
    login: Option<String>,
    options: Option<CloneOptions>,
    is_background_task: Option<bool>,
    on_progress: Channel<CloneProgress>,
) -> Result<(), CommandError> {
    let destination = std::path::PathBuf::from(&path);
    if destination.exists() {
        return Err(CommandError::message(
            "Clone destination already exists; choose a new path",
        ));
    }
    cleanup_stale_clone_destinations(&destination)?;
    let temporary_destination = temporary_clone_destination(&destination, "pending")?;
    let lock_key = git_ops::operation_identity::clone_destination_lock_key(&destination);
    let operation = registry
        .start(
            crate::operation::OperationScope::CloneDestination {
                lock_key: lock_key.to_string_lossy().into_owned(),
                destination_path: lock_key.to_string_lossy().into_owned(),
            },
            Some(window.label().to_owned()),
            GitOperationKind::Clone,
            crate::operation::CancellationCapability::Available {
                label: "Cancel clone".to_owned(),
            },
        )
        .map_err(|error| CommandError::message(error.to_string()))?;
    // Include the native operation ID so concurrent attempts cannot share a staging directory.
    let temporary_destination = temporary_destination.with_file_name(format!(
        ".rdc-clone-{}-{}",
        operation.id,
        destination
            .file_name()
            .expect("destination was validated to include a name")
            .to_string_lossy()
    ));
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let temporary_path = temporary_destination.to_string_lossy().into_owned();
    let remote = state
        .session_for(&temporary_path, is_background_task.unwrap_or(false))
        .await
        .map_err(|error| {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            command_error
        })?;

    let operation_id = operation.id.clone();
    let operation_registry = registry.inner().clone();
    let clone_options = options.unwrap_or_default();
    // Tauri drops an in-flight command future when its invoking webview is destroyed. Keep the
    // staged clone, watchdog and cleanup in a detached native task so owner-window loss cannot
    // strand a partially cloned destination or its operation lock.
    let task = tauri::async_runtime::spawn(async move {
        let watchdog = operation_registry.spawn_watchdog(
            operation_id.clone(),
            crate::operation_registry::WatchdogPolicy::default(),
        );
        let progress_registry = operation_registry.clone();
        let result = git_ops::clone::clone_controlled(
            &url,
            &temporary_destination,
            login.as_deref(),
            &clone_options,
            &remote.env,
            Some(|progress: CloneProgress| {
                let _ = progress_registry.publish_progress(
                    &operation_id,
                    OperationProgress {
                        value: progress.value,
                        title: Some(progress.title.clone()),
                        description: progress.description.clone(),
                    },
                );
                let _ = on_progress.send(progress);
            }),
            Some(control),
        )
        .await;
        watchdog.abort();

        match result {
            Ok(_) => match std::fs::rename(&temporary_destination, &destination) {
                Ok(()) => {
                    let _ = operation_registry.finish(
                        &operation_id,
                        OperationState::Completed,
                        OperationOutcome::Completed,
                        None,
                    );
                    Ok(())
                }
                Err(error) => {
                    let _ = remove_temporary_clone(&temporary_destination);
                    let message = format!(
                        "Clone completed, but the destination could not be installed: {error}"
                    );
                    let _ = operation_registry.finish(
                        &operation_id,
                        OperationState::Failed,
                        OperationOutcome::Unknown,
                        Some(OperationError {
                            kind: OperationErrorKind::Failed,
                            message: message.clone(),
                            recoverable: true,
                        }),
                    );
                    Err(CommandError::message(message))
                }
            },
            Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
                let _ = remove_temporary_clone(&temporary_destination);
                let (state, kind, message) = match reason {
                    git_ops::TerminationReason::Cancelled => (
                        OperationState::Cancelled,
                        OperationErrorKind::Cancelled,
                        "Clone was cancelled",
                    ),
                    git_ops::TerminationReason::TimedOut => (
                        OperationState::TimedOut,
                        OperationErrorKind::TimedOut,
                        "Clone timed out after becoming inactive",
                    ),
                };
                let _ = operation_registry.finish(
                    &operation_id,
                    state,
                    OperationOutcome::Unchanged,
                    Some(OperationError {
                        kind,
                        message: message.to_owned(),
                        recoverable: true,
                    }),
                );
                Err(CommandError::message(message))
            }
            Err(error) => {
                let command_error = remote_error(&remote, error);
                let _ = remove_temporary_clone(&temporary_destination);
                let _ = operation_registry.finish(
                    &operation_id,
                    OperationState::Failed,
                    OperationOutcome::Unknown,
                    Some(OperationError {
                        kind: OperationErrorKind::Failed,
                        message: command_error.message.clone(),
                        recoverable: true,
                    }),
                );
                Err(command_error)
            }
        }
    });
    task.await
        .map_err(|error| CommandError::message(format!("Clone task failed: {error}")))?
}

fn temporary_clone_destination(
    destination: &std::path::Path,
    operation_id: &str,
) -> Result<std::path::PathBuf, CommandError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            CommandError::message("Clone destination must include a parent directory")
        })?;
    let name = destination
        .file_name()
        .ok_or_else(|| CommandError::message("Clone destination must include a directory name"))?
        .to_string_lossy();
    Ok(parent.join(format!(".rdc-clone-{operation_id}-{name}")))
}

fn remove_temporary_clone(path: &std::path::Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        Ok(())
    }
}

/// Removes staging directories left by an earlier process for this exact destination.
///
/// The operation registry is deliberately process-local, so a restarted app cannot know whether
/// an old clone record is still active. The final destination check above and the exact app-owned
/// prefix make it safe to discard only abandoned staging siblings before starting a new clone;
/// unrelated user directories and other destination names are untouched.
fn cleanup_stale_clone_destinations(destination: &std::path::Path) -> Result<(), CommandError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            CommandError::message("Clone destination must include a parent directory")
        })?;
    let name = destination
        .file_name()
        .ok_or_else(|| CommandError::message("Clone destination must include a directory name"))?
        .to_string_lossy();
    let suffix = format!("-{name}");

    let entries = std::fs::read_dir(parent).map_err(|error| {
        CommandError::message(format!(
            "Could not inspect the clone destination directory: {error}"
        ))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            CommandError::message(format!(
                "Could not inspect a clone staging directory: {error}"
            ))
        })?;
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name.starts_with(".rdc-clone-") && file_name.ends_with(&suffix) && path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|error| {
                CommandError::message(format!(
                    "Could not remove stale clone staging directory: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

/// Lists a repository's remotes, alphabetically.
///
/// A path that isn't a repository yields an empty list rather than an error.
#[tauri::command]
pub async fn get_remotes(repository_path: String) -> Result<Vec<Remote>, CommandError> {
    git_ops::remote::get_remotes(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Adds a remote and returns it. Fails if one of that name already exists.
#[tauri::command]
pub async fn add_remote(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
    url: String,
) -> Result<Remote, CommandError> {
    let operation = start_remote_config_operation(&window, &registry, &repository_path).await?;
    finish_remote_config_mutation(
        &registry,
        &operation.id,
        git_ops::remote::add_remote(&repository_path, &name, &url).await,
    )
}

/// Removes a remote. Removing one that doesn't exist succeeds.
#[tauri::command]
pub async fn remove_remote(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
) -> Result<(), CommandError> {
    let operation = start_remote_config_operation(&window, &registry, &repository_path).await?;
    finish_remote_config_mutation(
        &registry,
        &operation.id,
        git_ops::remote::remove_remote(&repository_path, &name).await,
    )
}

/// Points an existing remote at a different URL.
#[tauri::command]
pub async fn set_remote_url(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
    url: String,
) -> Result<(), CommandError> {
    let operation = start_remote_config_operation(&window, &registry, &repository_path).await?;
    finish_remote_config_mutation(
        &registry,
        &operation.id,
        git_ops::remote::set_remote_url(&repository_path, &name, &url).await,
    )
}

async fn start_remote_config_operation(
    window: &WebviewWindow,
    registry: &OperationRegistry,
    repository_path: &str,
) -> Result<crate::operation::OperationRecord, CommandError> {
    crate::commands::operations::start_repository_operation(
        registry,
        repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await
}

fn finish_remote_config_mutation<T>(
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

/// The fetch URL of a remote, or `null` if there is no such remote.
#[tauri::command]
pub async fn get_remote_url(
    repository_path: String,
    name: String,
) -> Result<Option<String>, CommandError> {
    git_ops::remote::get_remote_url(&repository_path, &name)
        .await
        .map_err(CommandError::from)
}

/// Asks the remote which branch its `HEAD` points at and records it locally.
///
/// Contacts the remote, so it needs a session. An unreachable remote does not fail the call.
#[tauri::command]
pub async fn update_remote_head(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    state: State<'_, TrampolineState>,
    repository_path: String,
    name: String,
    is_background_task: Option<bool>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Fetch,
    )
    .await?;
    let remote = match state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let command_error = bind_error(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            return Err(command_error);
        }
    };

    match git_ops::remote::update_remote_head(&repository_path, &name, &remote.env).await {
        Ok(()) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let command_error = remote_error(&remote, error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

/// The branch a remote's `HEAD` points at, read from what was recorded locally. No network.
#[tauri::command]
pub async fn get_remote_head(
    repository_path: String,
    name: String,
) -> Result<Option<String>, CommandError> {
    git_ops::remote::get_remote_head(&repository_path, &name)
        .await
        .map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use super::cleanup_stale_clone_destinations;

    #[test]
    fn removes_only_stale_staging_directories_for_the_requested_destination() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let destination = parent.path().join("project");
        let stale = parent.path().join(".rdc-clone-operation-7-project");
        let other_destination = parent.path().join(".rdc-clone-operation-8-other");
        let unrelated = parent.path().join(".rdc-clone-not-app-owned");
        std::fs::create_dir(&stale).expect("stale staging directory");
        std::fs::create_dir(&other_destination).expect("other staging directory");
        std::fs::create_dir(&unrelated).expect("unrelated directory");

        cleanup_stale_clone_destinations(&destination).expect("cleanup succeeds");

        assert!(!stale.exists());
        assert!(other_destination.exists());
        assert!(unrelated.exists());
    }
}
