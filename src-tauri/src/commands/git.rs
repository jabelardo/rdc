//! Git commands exposed to the frontend.
//!
//! Thin wrappers over `git-ops`: they translate arguments and errors, and hold no logic of their
//! own. Anything worth testing lives in the crate, where it can be tested without a Tauri app.

use git_ops::checkout::CheckoutProgress;
use git_ops::checkout::CheckoutTarget;
use git_ops::commit::CommitOptions;
use git_ops::diff::{Diff, TextDiffData};
use git_ops::diff_index::IndexStatus;
use git_ops::for_each_ref::{Branch, TrackingBranch};
use git_ops::log::ChangesetData;
use git_ops::merge::{MergeOptions, MergeResult};
use git_ops::patch_formatter::LineSelection;
use git_ops::rebase::{
    ManualResolution, MultiCommitOperationProgress, RebaseResult, RebaseSnapshot,
};
use git_ops::reset::ResetMode;
use git_ops::stage::ResolvedConflict;
use git_ops::status::AheadBehind;
use git_ops::status::{AppFileStatus, StatusResult};
use git_ops::update_index::FileToStage;

use super::CommandError;
use crate::blob_protocol::BlobRegistry;
use crate::hook_state::{
    support_for_operation, HookFailurePrompt, HookFailureResolution, HookRegistry,
};
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::OperationRegistry;
use crate::operation_registry::WatchdogPolicy;
use git_ops::hooks::runner::HookProgressUpdate;
use git_ops::MultiOperationTerminalOutput;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

/// Initializes a repository at a new or existing directory.
#[tauri::command]
pub async fn init_repository(
    repository_path: String,
    default_branch: String,
) -> Result<(), CommandError> {
    initialize_repository(&repository_path, &default_branch).await
}

async fn initialize_repository(
    repository_path: &str,
    default_branch: &str,
) -> Result<(), CommandError> {
    tokio::fs::create_dir_all(repository_path)
        .await
        .map_err(|error| {
            CommandError::message(format!(
                "failed to create repository directory '{repository_path}': {error}"
            ))
        })?;
    git_ops::init_repository(repository_path, default_branch)
        .await
        .map_err(CommandError::from)
}

#[cfg(test)]
mod init_repository_tests {
    use super::initialize_repository;

    #[tokio::test]
    async fn creates_a_missing_destination_directory() {
        let parent = tempfile::tempdir().expect("failed to create a temporary directory");
        let destination = parent.path().join("new-repository");

        initialize_repository(
            destination
                .to_str()
                .expect("temporary path should be UTF-8"),
            "main",
        )
        .await
        .expect("init should create its destination directory");

        assert!(destination.join(".git").is_dir(), ".git should exist");
    }
}

/// Reads the status of the repository at `repository_path`.
///
/// Returns `None` when the path isn't a git repository, which is a normal answer rather than an
/// error — see `git_ops::status::get_status`.
///
/// Invoked from the frontend as:
///
/// ```js
/// await invoke('get_status', { repositoryPath, listUntrackedFilesIndividually: true })
/// ```
///
/// Note `listUntrackedFilesIndividually` does **not** mean "include untracked files" — passing
/// `false` still reports them, just collapsing untracked directories. The parameter was renamed from
/// the original's misleading `includeUntracked` for exactly that reason.
#[tauri::command]
pub async fn get_status(
    repository_path: String,
    list_untracked_files_individually: bool,
) -> Result<Option<StatusResult>, CommandError> {
    // Owned `String` rather than `&str`: async commands can't take borrowed arguments.
    git_ops::status::get_status(&repository_path, list_untracked_files_individually)
        .await
        .map_err(CommandError::from)
}

/// Creates a commit containing exactly `files`, and returns its full SHA.
///
/// ```js
/// await invoke('create_commit', {
///   repositoryPath,
///   message: 'Fix the thing',
///   files: [{ path: 'src/thing.ts' }],
///   options: { amend: false, noVerify: false, signOff: false, allowEmpty: false },
/// })
/// ```
///
/// A file the user only partly ticked carries a `partial` selection instead of the index fields, and is
/// staged by applying a patch rather than by reading the working tree — see
/// `git_ops::update_index::PartialSelection`.
///
/// The SHA is the full 40-character one. The original returned git's abbreviation, and returned the
/// literal string `"(root-commit)"` for a repository's first commit; see `git_ops::commit`.
///
/// `interceptHooks` decides whether the repository's hooks run with the **user's shell environment** rather
/// than the app's — see `git_ops::hooks`. Which hooks that covers is not the caller's to choose: a commit
/// reaches `pre-commit`, `commit-msg` and friends, and `--amend` also reaches `post-rewrite`, so the list
/// belongs with the operation. `onHookProgress` reports each of them starting and finishing, with an id
/// `abort_hook` accepts. `onTerminalOutput` streams the combined stdout and stderr of the commit process;
/// it is always present on the wire so the Phase 7 store can attach its bounded buffer without changing
/// the command contract.
// A command's parameters are its wire API, so grouping them to satisfy the lint would change the shape the
// frontend sends — the wrong reason to change an interface.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_commit(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    hooks: State<'_, HookRegistry>,
    repository_path: String,
    message: String,
    files: Vec<FileToStage>,
    options: Option<CommitOptions>,
    intercept_hooks: Option<bool>,
    on_hook_progress: Channel<HookProgressUpdate>,
    on_hook_failure: Channel<HookFailurePrompt>,
    on_terminal_output: Channel<String>,
) -> Result<String, CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Commit,
    )
    .await?;
    let support = match support_for_operation(
        intercept_hooks.unwrap_or(false),
        &hooks,
        on_hook_progress,
        on_hook_failure,
        &registry,
        &operation.id,
    ) {
        Ok(support) => support,
        Err(error) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: error.clone(),
                    recoverable: true,
                }),
            );
            return Err(CommandError::message(error));
        }
    };
    let terminal_output = MultiOperationTerminalOutput::default();
    let _terminal_subscription = terminal_output.subscribe(move |chunk| {
        // Losing the webview must not cancel a commit and leave the index in an unexpected state.
        let _ = on_terminal_output.send(chunk.to_owned());
    });

    // `options` is optional so the frontend can omit it entirely, matching the original's
    // `options?: { … }`. Absent means every flag off.
    let result = git_ops::commit::create_commit_with_terminal_output(
        &repository_path,
        &message,
        &files,
        options.unwrap_or_default(),
        support.as_ref(),
        &terminal_output,
    )
    .await;
    match result {
        Ok(sha) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(sha)
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

/// Stops a hook that is still running.
///
/// ```js
/// await invoke('abort_hook', { id })   // an id from an onHookProgress update
/// ```
///
/// `false` means the hook had already ended, which is not an error: the user cancelled a moment too late
/// and the operation carried on. Kills the `git hook run` process; a hook that spawned children of its own
/// may leave them running, as upstream's `AbortController` also did.
#[tauri::command]
pub fn abort_hook(hooks: State<'_, HookRegistry>, id: u64) -> bool {
    hooks.abort(id)
}

/// Answers the prompt for a failed hook. A stale id is harmless and returns `false`.
#[tauri::command]
pub fn resolve_hook_failure(
    hooks: State<'_, HookRegistry>,
    id: u64,
    resolution: HookFailureResolution,
) -> bool {
    hooks.resolve_failure(id, resolution)
}

/// Creates the commit that concludes an in-progress merge, and returns its full SHA.
///
/// ```js
/// await invoke('create_merge_commit', {
///   repositoryPath,
///   files: [{ path: 'conflicted.txt' }],
///   manualResolutions: [['conflicted.txt', 'theirs']],
/// })
/// ```
///
/// `manualResolutions` is a list of pairs rather than an object because it maps paths to a choice and
/// a path is not a safe object key — it can be any byte string, including one that collides with
/// `Object.prototype` members. The original used a `Map` for the same reason.
#[tauri::command]
pub async fn create_merge_commit(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    files: Vec<FileToStage>,
    manual_resolutions: Vec<ManualResolution>,
) -> Result<String, CommandError> {
    let operation =
        crate::commands::operation::active_repository_operation(&registry, &repository_path)
            .await?
            .ok_or_else(|| {
                CommandError::message("no active merge operation owns this repository")
            })?;
    let result =
        git_ops::commit::create_merge_commit(&repository_path, &files, &manual_resolutions).await;
    match result {
        Ok(sha) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Recovered,
                None,
            );
            Ok(sha)
        }
        Err(error) => {
            let command_error = CommandError::from(error);
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
            Err(command_error)
        }
    }
}

/// Checks out a local branch.
///
/// ```js
/// const onProgress = new Channel()
/// onProgress.onmessage = update => renderProgress(update)
/// await invoke('checkout_branch', { repositoryPath, name: 'topic', onProgress })
/// ```
#[tauri::command]
pub async fn checkout_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    // Snapshot before reserving the cancellable operation: an unavailable snapshot must not expose
    // a stop button that cannot restore the repository. The command remains locked by the normal
    // operation start immediately after this read; a later increment will close this small setup
    // race by making snapshot acquisition part of reservation.
    let snapshot = git_ops::checkout::get_checkout_snapshot(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let operation = crate::commands::operation::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
        "Cancel checkout",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::checkout::checkout_branch_with_progress_controlled(
        &repository_path,
        CheckoutTarget::Local(&name),
        move |progress| {
            let _ = on_progress.send(progress);
        },
        Some(control),
    )
    .await;
    watchdog.abort();
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
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            recover_checkout_termination(
                &registry,
                &operation.id,
                &repository_path,
                &snapshot,
                reason,
            )
            .await
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

async fn recover_checkout_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    snapshot: &git_ops::checkout::CheckoutSnapshot,
    reason: git_ops::TerminationReason,
) -> Result<(), CommandError> {
    let (state, kind, verb) = match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    };
    let _ = registry.enter_recovery(operation_id);
    match git_ops::checkout::restore_checkout_snapshot(repository_path, snapshot).await {
        Ok(()) => {
            let message = format!("Checkout {verb} and recovered");
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Recovered,
                Some(OperationError {
                    kind,
                    message: message.clone(),
                    recoverable: true,
                }),
            );
            Err(CommandError::message(message))
        }
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::RecoveryFailed,
                    message: command_error.message.clone(),
                    recoverable: false,
                }),
            );
            Err(command_error)
        }
    }
}

/// Checks out a remote-tracking branch by creating a local branch from it.
///
/// ```js
/// await invoke('checkout_remote_branch', {
///   repositoryPath,
///   remoteRef: 'origin/topic',
///   localName: 'topic',
/// })
/// ```
///
/// Separate from [`checkout_branch`] rather than taking an optional `localName`, because the two are
/// genuinely different operations — this one creates a ref — and because a single command with an
/// optional field would make "which of these did I mean?" a runtime question.
///
/// Fails if `localName` already exists; git refuses to repoint an existing branch, and the UI needs
/// that failure to prompt.
#[tauri::command]
pub async fn checkout_remote_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    remote_ref: String,
    local_name: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    let result = git_ops::checkout::checkout_branch_with_progress(
        &repository_path,
        CheckoutTarget::Remote {
            remote_ref: &remote_ref,
            local_name: &local_name,
        },
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await;
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

/// Checks out a commit, leaving `HEAD` detached.
///
/// ```js
/// await invoke('checkout_commit', { repositoryPath, commit: sha })
/// ```
#[tauri::command]
pub async fn checkout_commit(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    commit: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    let result = git_ops::checkout::checkout_commit_with_progress(
        &repository_path,
        &commit,
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await;
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

/// Restores the given paths from `HEAD`, discarding working-tree changes to them.
///
/// ```js
/// await invoke('checkout_paths', { repositoryPath, paths: ['src/thing.ts'] })
/// ```
///
/// **This discards the user's edits to those paths.** An empty list is a no-op, not "everything".
#[tauri::command]
pub async fn checkout_paths(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    let result = git_ops::checkout::checkout_paths(&repository_path, &paths).await;
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

/// Merges a branch into the current branch.
///
/// `interceptHooks` runs the repository's hooks with the user's shell environment. A merge reaches
/// `pre-merge-commit`, `post-merge` and `commit-msg`; a **squash** merge additionally commits, which reaches
/// the commit hooks — so the operation names both sets rather than the caller.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn merge_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    hooks: State<'_, HookRegistry>,
    repository_path: String,
    branch: String,
    options: Option<MergeOptions>,
    intercept_hooks: Option<bool>,
    on_hook_progress: Channel<HookProgressUpdate>,
    on_hook_failure: Channel<HookFailurePrompt>,
) -> Result<MergeResult, CommandError> {
    let operation = crate::commands::operation::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Merge,
        "Cancel merge",
    )
    .await?;
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

    let options = options.unwrap_or_default();
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::merge::merge_controlled(
        &repository_path,
        &branch,
        options,
        support.as_ref(),
        Some(control),
    )
    .await;
    watchdog.abort();
    match result {
        Ok(MergeResult::Failed) => {
            let _ = registry.enter_recovery(&operation.id);
            Ok(MergeResult::Failed)
        }
        Ok(result) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
        }
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            recover_merge_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                options.squash,
                reason,
            )
            .await
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

pub(crate) async fn recover_merge_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    squash: bool,
    reason: git_ops::TerminationReason,
) -> Result<MergeResult, CommandError> {
    // Plain merges expose MERGE_HEAD; squash merges intentionally do not, and leave SQUASH_MSG
    // plus index/worktree state instead. Only recover inside the marker belonging to this phase.
    let in_progress = if squash {
        git_ops::merge::is_squash_merge_in_progress(repository_path).await
    } else {
        let git_dir = git_ops::rev_parse::resolve_git_dir(repository_path)
            .await
            .map_err(|error| finish_merge_recovery_failure(registry, operation_id, error))?;
        Ok(git_ops::operation_state::is_merge_head_set(git_dir).await)
    }
    .map_err(|error| finish_merge_recovery_failure(registry, operation_id, error))?;

    // Git can advance HEAD before a late stop reaches a post-merge hook while leaving merge
    // metadata visible until that hook returns. A moved HEAD is therefore authoritative even when
    // a marker still exists; aborting in that state would undo an already completed merge.
    let current_head = git_ops::get_head_sha(repository_path)
        .await
        .map_err(|error| finish_merge_recovery_failure(registry, operation_id, error))?;
    if current_head != pre_operation_head {
        let _ = registry.finish(
            operation_id,
            OperationState::Completed,
            OperationOutcome::Completed,
            None,
        );
        return Ok(MergeResult::Success);
    }

    if !in_progress {
        let (state, kind, verb) = merge_termination_details(reason);
        let message = format!("Merge {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    let recovery = if squash {
        git_ops::merge::abort_squash_merge(repository_path).await
    } else {
        git_ops::merge::abort_merge(repository_path).await
    };
    match recovery {
        Ok(()) => {
            let (state, _, verb) = merge_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!("Merge {verb} and recovered")))
        }
        Err(error) => Err(finish_merge_recovery_failure(registry, operation_id, error)),
    }
}

fn merge_termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

fn finish_merge_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

/// Returns the common ancestor of two refs, or `None` when there isn't one or a ref is missing.
#[tauri::command]
pub async fn get_merge_base(
    repository_path: String,
    first_commitish: String,
    second_commitish: String,
) -> Result<Option<String>, CommandError> {
    git_ops::merge::get_merge_base(&repository_path, &first_commitish, &second_commitish)
        .await
        .map_err(CommandError::from)
}

/// Aborts an in-progress merge.
#[tauri::command]
pub async fn abort_merge(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation =
        crate::commands::operation::active_repository_operation(&registry, &repository_path)
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

/// Rebases `targetBranch` onto `baseBranch`.
#[tauri::command]
pub async fn rebase_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    base_branch: String,
    target_branch: String,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<RebaseResult, CommandError> {
    let operation = crate::commands::operation::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Rebase,
        "Cancel rebase",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::rebase::rebase_with_progress_controlled(
        &repository_path,
        &base_branch,
        &target_branch,
        move |progress| {
            let _ = on_progress.send(progress);
        },
        Some(control),
    )
    .await;
    watchdog.abort();
    match result {
        Ok(
            result @ (RebaseResult::ConflictsEncountered | RebaseResult::OutstandingFilesNotStaged),
        ) => {
            let _ = registry.enter_recovery(&operation.id);
            Ok(result)
        }
        Ok(result) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
        }
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            recover_rebase_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                reason,
            )
            .await
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

pub(crate) async fn recover_rebase_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    reason: git_ops::TerminationReason,
) -> Result<RebaseResult, CommandError> {
    // A stop request may arrive after Git has finished the last commit. Only abort while rebase
    // metadata remains; otherwise the abort would undo a completed rebase.
    let snapshot = git_ops::rebase::get_rebase_snapshot(repository_path)
        .await
        .map_err(|error| finish_rebase_recovery_failure(registry, operation_id, error))?;
    if snapshot.is_none() {
        let current_head = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_rebase_recovery_failure(registry, operation_id, error))?;
        if current_head != pre_operation_head {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(RebaseResult::CompletedWithoutError);
        }

        let (state, kind, verb) = rebase_termination_details(reason);
        let message = format!("Rebase {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    match git_ops::rebase::abort_rebase(repository_path).await {
        Ok(()) => {
            let (state, _, verb) = rebase_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!(
                "Rebase {verb} and recovered"
            )))
        }
        Err(error) => Err(finish_rebase_recovery_failure(
            registry,
            operation_id,
            error,
        )),
    }
}

fn rebase_termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

fn finish_rebase_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

/// Stages the selected resolutions and continues an in-progress rebase.
#[tauri::command]
pub async fn continue_rebase(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    files: Vec<FileToStage>,
    manual_resolutions: Vec<ManualResolution>,
    no_verify: bool,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<RebaseResult, CommandError> {
    let operation =
        crate::commands::operation::active_repository_operation(&registry, &repository_path)
            .await?
            .ok_or_else(|| {
                CommandError::message("no active rebase operation owns this repository")
            })?;
    let result = git_ops::rebase::continue_rebase_with_progress(
        &repository_path,
        &files,
        &manual_resolutions,
        no_verify,
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await;
    match result {
        Ok(
            result @ (RebaseResult::ConflictsEncountered | RebaseResult::OutstandingFilesNotStaged),
        ) => {
            let _ = registry.enter_recovery(&operation.id);
            Ok(result)
        }
        Ok(result) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
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

/// Aborts an in-progress rebase.
#[tauri::command]
pub async fn abort_rebase(
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation =
        crate::commands::operation::active_repository_operation(&registry, &repository_path)
            .await?;
    let result = git_ops::rebase::abort_rebase(&repository_path).await;
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

/// Returns recoverable progress for an in-progress rebase.
#[tauri::command]
pub async fn get_rebase_snapshot(
    repository_path: String,
) -> Result<Option<RebaseSnapshot>, CommandError> {
    git_ops::rebase::get_rebase_snapshot(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Lists branches, local and remote, in the order git reports them.
///
/// ```js
/// await invoke('get_branches', { repositoryPath, prefixes: [] })
/// // -> [{ name: 'main', upstream: 'origin/main', tip: { sha, author: { date } }, type: 0, ref: 'refs/heads/main', isGone: false }]
/// ```
///
/// `prefixes` narrows the ref namespaces; an empty list means `refs/heads` and `refs/remotes`.
///
/// The result is the **arguments `Branch`'s constructor takes**, not a `Branch` — its derived getters
/// (`remoteName`, `nameWithoutRemote`, …) stay in TypeScript. `type` is a number, since `BranchType`
/// is a numeric enum whose values also decide sort order.
///
/// A path that isn't a repository yields an empty list rather than an error.
#[tauri::command]
pub async fn get_branches(
    repository_path: String,
    prefixes: Vec<String>,
) -> Result<Vec<Branch>, CommandError> {
    git_ops::for_each_ref::get_branches(&repository_path, &prefixes)
        .await
        .map_err(CommandError::from)
}

/// Lists local branches whose tip differs from their upstream's.
///
/// ```js
/// await invoke('get_branches_differing_from_upstream', { repositoryPath })
/// ```
///
/// Feeds `fast_forward_branches`, which takes `(upstreamRef, ref)` pairs built from these. The current
/// branch and branches checked out in other worktrees are excluded — neither can be moved by a ref
/// update alone.
#[tauri::command]
pub async fn get_branches_differing_from_upstream(
    repository_path: String,
) -> Result<Vec<TrackingBranch>, CommandError> {
    git_ops::for_each_ref::get_branches_differing_from_upstream(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Resets `refName`, moving `HEAD` and optionally the index and working tree.
///
/// ```js
/// await invoke('reset', { repositoryPath, mode: GitResetMode.Mixed, refName: 'HEAD~1' })
/// ```
///
/// `mode` is a **number** — `GitResetMode` is a numeric enum, and note `Hard` is **0**, so a missing or
/// zeroed field selects the destructive mode. **`Hard` discards work**: everything different from `refName`
/// in the working tree is gone, with no reflog of the file contents, so the caller is expected to have asked
/// the user first.
#[tauri::command]
pub async fn reset(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    mode: ResetMode,
    ref_name: String,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_checkout_mutation(
        &registry,
        &operation.id,
        git_ops::reset::reset(&repository_path, mode, &ref_name).await,
    )
}

/// Updates the index for `paths` from the tree at `refName`.
///
/// ```js
/// await invoke('reset_paths', {
///   repositoryPath, mode: GitResetMode.Mixed, refName: 'HEAD', paths: ['src/thing.ts'],
/// })
/// ```
///
/// An empty `paths` is a **no-op**, not "reset everything" — which is what the same arguments would mean to
/// git without a pathspec, and the opposite of what an empty selection means.
#[tauri::command]
pub async fn reset_paths(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    mode: ResetMode,
    ref_name: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_checkout_mutation(
        &registry,
        &operation.id,
        git_ops::reset::reset_paths(&repository_path, mode, &ref_name, &paths).await,
    )
}

/// Clears the staging area.
///
/// ```js
/// await invoke('unstage_all', { repositoryPath })
/// ```
///
/// `reset -- .` rather than a bare `reset`, which also makes it work in a repository with no commits, where
/// `HEAD` doesn't resolve.
#[tauri::command]
pub async fn unstage_all(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_checkout_mutation(
        &registry,
        &operation.id,
        git_ops::reset::unstage_all(&repository_path).await,
    )
}

/// Removes every path from the index, leaving the working tree alone.
///
/// ```js
/// await invoke('unstage_all_files', { repositoryPath })
/// ```
///
/// Different from `unstage_all` despite the name: this is `rm --cached`, which empties the index — including
/// paths that exist only there — while a reset restores it to a commit.
#[tauri::command]
pub async fn unstage_all_files(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_checkout_mutation(
        &registry,
        &operation.id,
        git_ops::rm::unstage_all_files(&repository_path).await,
    )
}

fn finish_checkout_mutation(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<(), git_ops::GitError>,
) -> Result<(), CommandError> {
    match result {
        Ok(()) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
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
    let operation = crate::commands::operation::start_repository_operation(
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

/// How many commits each side of `range` has that the other does not.
///
/// ```js
/// await invoke('get_ahead_behind', { repositoryPath, range: 'main...origin/main' })
/// // -> { ahead: 1, behind: 2 }
/// ```
///
/// The range is built by the caller — `revRange`, `revSymmetricDifference` in `src/lib/rev-range.ts` — because
/// it is string concatenation and needs no round trip.
///
/// `null` means the question cannot be asked: a ref in the range no longer exists, most often a deleted
/// upstream. That is an answer rather than a failure, since a caller with nothing to put in a label should not
/// be handling an error.
#[tauri::command]
pub async fn get_ahead_behind(
    repository_path: String,
    range: String,
) -> Result<Option<AheadBehind>, CommandError> {
    git_ops::rev_list::get_ahead_behind(&repository_path, &range)
        .await
        .map_err(CommandError::from)
}

/// Diffs a file between two branches, from where they diverged.
///
/// ```js
/// await invoke('get_branch_merge_base_diff', {
///   repositoryPath, path, status, baseBranch: 'main', comparisonBranch: 'topic',
///   latestCommit: sha, hideWhitespace: false,
/// })
/// ```
///
/// `--merge-base` is what makes this a comparison rather than a difference: commits the base branch gained
/// after the two diverged would otherwise read as though the comparison branch removed them.
///
/// `latestCommit` labels the result — it names the version of the file being shown, which the diff itself does
/// not carry.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_branch_merge_base_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    base_branch: String,
    comparison_branch: String,
    latest_commit: String,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_branch_merge_base_diff(
        &repository_path,
        &path,
        &status,
        &base_branch,
        &comparison_branch,
        hide_whitespace.unwrap_or(false),
        &latest_commit,
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

/// What changed between two branches, from where they diverged.
///
/// ```js
/// await invoke('get_branch_merge_base_changed_files', {
///   repositoryPath, baseBranch: 'main', comparisonBranch: 'topic', latestComparisonCommit: sha,
/// })
/// ```
///
/// `null` means the branches have **no common ancestor** — unrelated histories, which is a real state rather
/// than a failure, and there is no point to compare from.
#[tauri::command]
pub async fn get_branch_merge_base_changed_files(
    repository_path: String,
    base_branch: String,
    comparison_branch: String,
    latest_comparison_commit: String,
) -> Result<Option<ChangesetData>, CommandError> {
    git_ops::diff::get_branch_merge_base_changed_files(
        &repository_path,
        &base_branch,
        &comparison_branch,
        &latest_comparison_commit,
    )
    .await
    .map_err(CommandError::from)
}

/// What changed across a range of commits, oldest first.
///
/// ```js
/// await invoke('get_commit_range_changed_files', { repositoryPath, shas: [oldest, newest] })
/// ```
///
/// The oldest commit's **parent** is the starting point, so the range includes its own change. A branch's first
/// commit works without the caller doing anything: `<sha>^` doesn't resolve there, and the Rust side retries
/// against git's empty tree.
#[tauri::command]
pub async fn get_commit_range_changed_files(
    repository_path: String,
    shas: Vec<String>,
) -> Result<ChangesetData, CommandError> {
    git_ops::diff::get_commit_range_changed_files(&repository_path, &shas)
        .await
        .map_err(CommandError::from)
}

/// Lists what the index holds that `HEAD` does not, and how each path differs.
///
/// ```js
/// await invoke('get_index_changes', { repositoryPath })
/// // -> [['src/thing.ts', 4], ['added.ts', 1]]
/// ```
///
/// Pairs rather than an object, because a repository path is an arbitrary string and so is not a safe
/// JavaScript object key — the same reasoning as `manualResolutions` on `create_merge_commit`.
///
/// The status is a **number**: `IndexStatus` is a numeric enum in `src/models/index-status.ts`, and
/// the discriminant is the wire value.
///
/// A repository with no commits is handled, not rejected — the Rust side falls back to diffing
/// against the null tree, so everything staged reads as an addition.
#[tauri::command]
pub async fn get_index_changes(
    repository_path: String,
) -> Result<Vec<(String, IndexStatus)>, CommandError> {
    git_ops::diff_index::get_index_changes(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Diffs a file in the working directory.
///
/// ```js
/// await invoke('get_working_directory_diff', {
///   repositoryPath,
///   path: 'src/thing.ts',
///   status: file.status,     // the AppFileStatus from getStatus()
///   hideWhitespace: false,
/// })
/// ```
///
/// `status` is passed straight back from `get_status`, because how a file is diffed depends on it: a
/// new or untracked file has nothing to compare against, a rename needs its source path, and a
/// submodule is described rather than diffed.
///
/// `kind` in the result is a **number** — `DiffType` is a numeric enum in `src/models/diff`.
#[tauri::command]
pub async fn get_working_directory_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_working_directory_diff(
        &repository_path,
        &path,
        &status,
        hide_whitespace.unwrap_or(false),
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

/// Diffs a file in a commit against that commit's first parent.
///
/// ```js
/// await invoke('get_commit_diff', { repositoryPath, path, status, commitish: sha })
/// ```
#[tauri::command]
pub async fn get_commit_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    commitish: String,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_commit_diff(
        &repository_path,
        &path,
        &status,
        &commitish,
        hide_whitespace.unwrap_or(false),
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

/// Discards the selected lines of a file from the working tree.
///
/// ```js
/// await invoke('discard_changes_from_selection', {
///   repositoryPath,
///   filePath: 'src/thing.ts',
///   diff: dehydrateTextDiff(diff),   // the diff the user was looking at
///   selectedLines: [4, 5, 9],
/// })
/// ```
///
/// The diff is a **parameter rather than something the backend re-reads**, because `selectedLines`
/// indexes into the diff the user was shown. Re-reading could discard different lines; passing it means
/// a file that changed underneath makes git reject the patch instead.
///
/// An empty `selectedLines` is a no-op, not an error — nothing was asked for.
#[tauri::command]
pub async fn discard_changes_from_selection(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    file_path: String,
    diff: TextDiffData,
    selected_lines: Vec<u32>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await?;
    finish_checkout_mutation(
        &registry,
        &operation.id,
        git_ops::apply::discard_changes_from_selection(
            &repository_path,
            &file_path,
            &diff,
            &LineSelection::new(selected_lines),
        )
        .await,
    )
}

/// Diffs a file across a range of commits.
///
/// ```js
/// await invoke('get_commit_range_diff', { repositoryPath, path, status, commits: [oldest, newest] })
/// ```
///
/// `commits` must be non-empty and ordered oldest first. When the oldest has no parent the Rust side
/// retries against git's empty tree, so a branch's first commit works without the caller knowing.
#[tauri::command]
pub async fn get_commit_range_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    commits: Vec<String>,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_commit_range_diff(
        &repository_path,
        &path,
        &status,
        &commits,
        hide_whitespace.unwrap_or(false),
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

#[cfg(test)]
mod termination_tests {
    use super::*;

    #[test]
    fn classifies_rebase_cancellation_and_timeout() {
        assert_eq!(
            rebase_termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            rebase_termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }

    #[test]
    fn classifies_merge_cancellation_and_timeout() {
        assert_eq!(
            merge_termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            merge_termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }
}

#[cfg(test)]
mod rebase_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use crate::operation_registry::OperationRegistry;
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn conflicted_rebase_repository() -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("conflict.txt"), "base\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        run_git(directory.path(), &["branch", "feature"]);
        run_git(directory.path(), &["checkout", "-q", "feature"]);
        std::fs::write(directory.path().join("conflict.txt"), "feature\n")
            .expect("feature file should be written");
        run_git(directory.path(), &["commit", "-qam", "feature change"]);
        run_git(directory.path(), &["checkout", "-q", "main"]);
        std::fs::write(directory.path().join("conflict.txt"), "main\n")
            .expect("main file should be written");
        run_git(directory.path(), &["commit", "-qam", "main change"]);
        let feature_head = run_git(directory.path(), &["rev-parse", "feature"]);
        let rebase = Command::new("git")
            .args(["rebase", "main", "feature"])
            .current_dir(directory.path())
            .output()
            .expect("rebase should start");
        assert!(
            !rebase.status.success(),
            "rebase should stop with a conflict"
        );
        (directory, feature_head)
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_rebase_and_releases_the_lock() {
        let (directory, original_head) = conflicted_rebase_repository();
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Rebase,
                CancellationCapability::Available {
                    label: "Cancel rebase".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &original_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should be reported to the caller"
        );
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("conflict.txt"))
                .expect("worktree file should be readable"),
            "feature\n"
        );
        assert_eq!(
            run_git(directory.path(), &["diff", "--cached", "--quiet"]),
            ""
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_late_rebase_stop_as_completed() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "one\n")
            .expect("first file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "first"]);
        let pre_operation_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("file.txt"), "two\n")
            .expect("second file should be written");
        run_git(directory.path(), &["commit", "-qam", "second"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Rebase,
                CancellationCapability::Available {
                    label: "Cancel rebase".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        assert_eq!(result, RebaseResult::CompletedWithoutError);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }
}

#[cfg(test)]
mod merge_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use crate::operation_registry::OperationRegistry;
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn run_git_allowing_failure(repository: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start")
    }

    fn base_repository() -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 14 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice14@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "base\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        run_git(directory.path(), &["branch", "feature"]);
        run_git(directory.path(), &["checkout", "-q", "feature"]);
        std::fs::write(directory.path().join("file.txt"), "feature\n")
            .expect("feature file should be written");
        run_git(directory.path(), &["commit", "-qam", "feature change"]);
        run_git(directory.path(), &["checkout", "-q", "main"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        (directory, original_head)
    }

    fn conflicted_merge_repository() -> (tempfile::TempDir, String) {
        let (directory, _) = base_repository();
        std::fs::write(directory.path().join("file.txt"), "main\n")
            .expect("main file should be written");
        run_git(directory.path(), &["commit", "-qam", "main change"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        let merge = run_git_allowing_failure(directory.path(), &["merge", "feature"]);
        assert!(!merge.status.success(), "merge should stop with a conflict");
        (directory, original_head)
    }

    fn start_merge_operation(registry: &OperationRegistry, repository_path: &str) -> String {
        registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.to_owned(),
                    repository_path: repository_path.to_owned(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Merge,
                CancellationCapability::Available {
                    label: "Cancel merge".to_owned(),
                },
            )
            .expect("merge operation should reserve the repository")
            .id
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_merge_and_restores_the_worktree() {
        let (directory, original_head) = conflicted_merge_repository();
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        let result = recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            &original_head,
            false,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(result.is_err(), "cancellation should be reported");
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt"))
                .expect("worktree file should be readable"),
            "main\n"
        );
        assert!(
            run_git_allowing_failure(directory.path(), &["diff", "--quiet"])
                .status
                .success()
        );
        assert!(
            run_git_allowing_failure(directory.path(), &["diff", "--cached", "--quiet"])
                .status
                .success()
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_squash_merge_without_moving_head() {
        let (directory, original_head) = base_repository();
        run_git(directory.path(), &["merge", "--squash", "feature"]);
        assert!(
            git_ops::merge::is_squash_merge_in_progress(directory.path())
                .await
                .expect("squash state should be readable")
        );
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        let result = recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            &original_head,
            true,
            git_ops::TerminationReason::TimedOut,
        )
        .await;

        assert!(result.is_err(), "timeout should be reported");
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt"))
                .expect("worktree file should be readable"),
            "base\n"
        );
        assert!(
            run_git_allowing_failure(directory.path(), &["status", "--porcelain"])
                .stdout
                .is_empty()
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_fast_forward_race_as_completed() {
        let (directory, original_head) = base_repository();
        run_git(directory.path(), &["merge", "--ff-only", "feature"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        let result = recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            &original_head,
            false,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        assert_eq!(result, MergeResult::Success);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_retains_the_lock_when_state_cannot_be_read() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let repository_path = directory.path().join("missing");
        let repository_path = repository_path.to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        assert!(recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            "0000000000000000000000000000000000000000",
            false,
            git_ops::TerminationReason::TimedOut,
        )
        .await
        .is_err());
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_some());
    }
}

#[cfg(test)]
mod checkout_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn start_checkout_operation(registry: &OperationRegistry, repository_path: &str) -> String {
        let scope = OperationScope::Repository {
            lock_key: repository_path.to_owned(),
            repository_path: repository_path.to_owned(),
        };
        registry
            .start(
                scope,
                Some("checkout-test".to_owned()),
                GitOperationKind::Checkout,
                CancellationCapability::Available {
                    label: "Cancel checkout".to_owned(),
                },
            )
            .expect("checkout should reserve the repository")
            .id
    }

    #[tokio::test]
    async fn command_recovery_restores_checkout_snapshot_and_releases_the_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Checkout Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "checkout@example.com"],
        );
        std::fs::write(directory.path().join("tracked.txt"), "base\n")
            .expect("tracked fixture should be written");
        run_git(directory.path(), &["add", "tracked.txt"]);
        run_git(directory.path(), &["commit", "-m", "base"]);
        run_git(directory.path(), &["checkout", "-b", "topic"]);
        std::fs::write(directory.path().join("extra.txt"), "topic\n")
            .expect("topic fixture should be written");
        run_git(directory.path(), &["add", "extra.txt"]);
        run_git(directory.path(), &["commit", "-m", "topic"]);
        run_git(directory.path(), &["checkout", "main"]);
        std::fs::write(directory.path().join("extra.txt"), "local\n")
            .expect("local untracked fixture should be written");

        let repository_path = directory.path().to_string_lossy().into_owned();
        let snapshot = git_ops::checkout::get_checkout_snapshot(&repository_path)
            .await
            .expect("checkout snapshot should be captured");
        run_git(directory.path(), &["checkout", "--force", "topic"]);
        let registry = OperationRegistry::new();
        let operation_id = start_checkout_operation(&registry, &repository_path);

        let result = recover_checkout_termination(
            &registry,
            &operation_id,
            &repository_path,
            &snapshot,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should remain visible to Checkout"
        );
        assert_eq!(
            git_ops::refs::get_symbolic_ref(&repository_path, "HEAD")
                .await
                .expect("HEAD should resolve")
                .as_deref(),
            Some("refs/heads/main")
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("extra.txt"))
                .expect("untracked file should be restored"),
            "local\n"
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
        assert_eq!(
            registry
                .get(&operation_id)
                .expect("checkout record")
                .outcome,
            Some(OperationOutcome::Recovered)
        );
    }
}
