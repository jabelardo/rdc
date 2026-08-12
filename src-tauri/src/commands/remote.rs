//! Remote operations exposed to the frontend.
//!
//! These are the first commands that need both halves of the backend: `git_ops` to run git, and the
//! trampoline to answer the credential requests git makes while it runs.
//!
//! # `isBackgroundTask` is not optional in spirit
//!
//! Every command here takes it, and passing `true` for anything the user didn't initiate is what
//! stops a credential prompt appearing unbidden. It can't be inferred from the call.

use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use git_ops::clone::{CloneOptions, CloneProgress};
use git_ops::fetch::FetchProgress;
use git_ops::pull::PullProgress;
use git_ops::push::{PushOptions, PushProgress, PushTarget};
use git_ops::remote::Remote;

use super::CommandError;
use crate::hook_state::{support_for, HookFailurePrompt, HookRegistry};
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::OperationRegistry;
use crate::trampoline_state::{RemoteSession, TrampolineState};
use git_ops::hooks::runner::HookProgressUpdate;

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
    let operation = crate::commands::operation::start_repository_operation(
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
    let support = match support_for(
        intercept_hooks.unwrap_or(false),
        &hooks,
        on_hook_progress,
        on_hook_failure,
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

    let result = git_ops::push::push(
        &repository_path,
        PushTarget {
            remote_name: &remote_name,
            local_branch: &local_branch,
            remote_branch: remote_branch.as_deref(),
            tags: &tags,
        },
        &remote.env,
        options.unwrap_or_default(),
        Some(|progress: PushProgress| {
            // A closed webview drops updates rather than cancelling git, which must not be left
            // half-done.
            let _ = on_progress.send(progress);
        }),
        support.as_ref(),
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
    let operation = crate::commands::operation::start_repository_operation(
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
    let operation = crate::commands::operation::start_repository_operation(
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

    let result = git_ops::fetch::fetch(
        &repository_path,
        &remote_name,
        &remote.env,
        Some(|progress: FetchProgress| {
            let _ = on_progress.send(progress);
        }),
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
    let operation = crate::commands::operation::start_repository_operation(
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
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Pull,
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
    let support = match support_for(
        intercept_hooks.unwrap_or(false),
        &hooks,
        on_hook_progress,
        on_hook_failure,
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

    let result = git_ops::pull::pull(
        &repository_path,
        &remote_name,
        &remote.env,
        no_verify.unwrap_or(false),
        Some(|progress: PullProgress| {
            let _ = on_progress.send(progress);
        }),
        support.as_ref(),
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
    let operation = crate::commands::operation::start_repository_operation(
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
pub async fn clone(
    state: State<'_, TrampolineState>,
    url: String,
    path: String,
    login: Option<String>,
    options: Option<CloneOptions>,
    is_background_task: Option<bool>,
    on_progress: Channel<CloneProgress>,
) -> Result<(), CommandError> {
    let remote = state
        .session_for(&path, is_background_task.unwrap_or(false))
        .await
        .map_err(bind_error)?;

    git_ops::clone::clone(
        &url,
        &path,
        login.as_deref(),
        &options.unwrap_or_default(),
        &remote.env,
        Some(|progress: CloneProgress| {
            let _ = on_progress.send(progress);
        }),
    )
    .await
    .map_err(|error| remote_error(&remote, error))?;

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
    crate::commands::operation::start_repository_operation(
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
    let operation = crate::commands::operation::start_repository_operation(
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
