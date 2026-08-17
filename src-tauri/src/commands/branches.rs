//! Branch commands: listing, creating, renaming, deleting, checking out, merging and rebasing.
//!
//! Thin wrappers over `git-ops`, like the rest of `commands`.
//!
//! This module previously carried a note explaining that branch commands were split across three
//! files — listing in `git.rs`, mutation here, remote deletion in `remote.rs`. Two of those are
//! fixed: everything a branch does locally is now here. Deleting a *remote* branch is still
//! [`super::remote`], because it pushes and so needs a credential session.
//!
//! Merge and rebase live here rather than in [`super::conflicts`]: starting one is a branch
//! operation, and only what happens after it stops with conflicts belongs to that module.

use crate::commands::operation_lifecycle::{finish_short_mutation, start_short_mutation};
use crate::commands::operation_lifecycle::{
    recover_merge_termination, recover_rebase_termination, run_cancellable_branch_checkout,
};
use crate::commands::CommandError;
use crate::hook_state::{support_for_operation, HookFailurePrompt, HookRegistry};
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::OperationRegistry;
use crate::operation_registry::WatchdogPolicy;
use git_ops::checkout::CheckoutProgress;
use git_ops::checkout::CheckoutTarget;
use git_ops::for_each_ref::{Branch, TrackingBranch};
use git_ops::hooks::runner::HookProgressUpdate;
use git_ops::merge::{MergeOptions, MergeResult};
use git_ops::merge_tree::MergeTreeResult;
use git_ops::operation_state::RebaseInternalState;
use git_ops::rebase::{
    ManualResolution, MultiCommitOperationProgress, RebaseResult, RebaseSnapshot,
};
use git_ops::update_index::FileToStage;
use std::collections::HashMap;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

/// Creates a branch, without checking it out.
///
/// ```js
/// await invoke('create_branch', { repositoryPath, name: 'topic', startPoint: 'main', noTrack: false })
/// ```
///
/// `startPoint` defaults to `HEAD`. `noTrack` matters when branching from a *remote* branch: without it git
/// would set that remote branch as the upstream, which makes the rest of the app treat it as the push target
/// — likely a fork's upstream rather than the user's own.
#[tauri::command]
pub async fn create_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
    start_point: Option<String>,
    no_track: Option<bool>,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::branch::create_branch(
            &repository_path,
            &name,
            start_point.as_deref(),
            no_track.unwrap_or(false),
        )
        .await,
    )
}

/// Renames a branch.
///
/// ```js
/// await invoke('rename_branch', { repositoryPath, currentName: 'topic', newName: 'feature' })
/// ```
///
/// `force` omitted is not the same as `false`: omitted lets a **case-only** rename through by retrying with
/// `-M`, which is what a user asking to change `Topic` to `topic` means on a case-insensitive filesystem.
/// Passing `false` refuses any collision, and `true` forces every one — see `git_ops::branch`.
#[tauri::command]
pub async fn rename_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    current_name: String,
    new_name: String,
    force: Option<bool>,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::branch::rename_branch(&repository_path, &current_name, &new_name, force).await,
    )
}

/// Deletes a local branch, whether or not it has been merged.
///
/// ```js
/// await invoke('delete_local_branch', { repositoryPath, branchName: 'topic' })
/// ```
///
/// Uses `-D`, so an unmerged branch goes too: the app asks the user first, and git's own refusal would arrive
/// as a failure the UI has already ruled out.
#[tauri::command]
pub async fn delete_local_branch(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    branch_name: String,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::branch::delete_local_branch(&repository_path, &branch_name).await,
    )
}

/// Branch names whose tip is `committish`.
///
/// ```js
/// await invoke('get_branches_pointed_at', { repositoryPath, committish: 'HEAD' })
/// // -> ['main', 'topic']
/// ```
///
/// `null` means the committish didn't resolve, which is different from an empty array — no branch points at a
/// commit that exists is an answer, and asking about a commit that doesn't is a mistake.
#[tauri::command]
pub async fn get_branches_pointed_at(
    repository_path: String,
    committish: String,
) -> Result<Option<Vec<String>>, CommandError> {
    git_ops::branch::get_branches_pointed_at(&repository_path, &committish)
        .await
        .map_err(CommandError::from)
}

/// Branches merged into `branchName`, as `[canonicalRef, tipSha]` pairs.
///
/// ```js
/// await invoke('get_merged_branches', { repositoryPath, branchName: 'main' })
/// // -> [['refs/heads/topic', 'a1b2c3…']]
/// ```
///
/// Pairs rather than an object, because a ref name is an arbitrary string and so isn't a safe JavaScript
/// object key — the same reasoning as `manualResolutions` and the tag list.
///
/// `branchName` itself is excluded: it is trivially merged into itself, and including it would make every
/// caller filter it out.
#[tauri::command]
pub async fn get_merged_branches(
    repository_path: String,
    branch_name: String,
) -> Result<Vec<(String, String)>, CommandError> {
    let merged: HashMap<String, String> =
        git_ops::branch::get_merged_branches(&repository_path, &branch_name)
            .await
            .map_err(CommandError::from)?;

    // Sorted, because a HashMap's order is arbitrary and a list that reshuffles between calls would make the
    // UI re-render for no reason.
    let mut pairs: Vec<(String, String)> = merged.into_iter().collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));

    Ok(pairs)
}

/// Deletes a ref.
///
/// ```js
/// await invoke('delete_ref', { repositoryPath, refName: 'refs/remotes/origin/topic' })
/// ```
///
/// Deleting a ref that doesn't exist **succeeds**: git treats it as idempotent, so a caller needn't check
/// first. `reason` goes into the reflog of the ref being deleted, which is removed along with it — so it has
/// no observable effect and exists only because the original passed one; see `git_ops::update_ref`.
#[tauri::command]
pub async fn delete_ref(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    ref_name: String,
    reason: Option<String>,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::update_ref::delete_ref(&repository_path, &ref_name, reason.as_deref()).await,
    )
}

/// What a symbolic ref points at, or `null` if it isn't one.
///
/// ```js
/// await invoke('get_symbolic_ref', { repositoryPath, refName: 'HEAD' })
/// // -> 'refs/heads/main'
/// ```
#[tauri::command]
pub async fn get_symbolic_ref(
    repository_path: String,
    ref_name: String,
) -> Result<Option<String>, CommandError> {
    git_ops::refs::get_symbolic_ref(&repository_path, &ref_name)
        .await
        .map_err(CommandError::from)
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
    run_cancellable_branch_checkout(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        CheckoutTarget::Local(&name),
        on_progress,
    )
    .await
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
    run_cancellable_branch_checkout(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        CheckoutTarget::Remote {
            remote_ref: &remote_ref,
            local_name: &local_name,
        },
        on_progress,
    )
    .await
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

/// The most recently checked-out branches, newest first.
#[tauri::command]
pub async fn get_recent_branches(
    repository_path: String,
    limit: usize,
) -> Result<Vec<String>, CommandError> {
    git_ops::reflog::get_recent_branches(&repository_path, limit)
        .await
        .map_err(CommandError::from)
}

/// When each branch was last checked out, for checkouts at or after `after`.
///
/// `after` is epoch **seconds**, and the results are `[branch, epochSeconds]` pairs.
#[tauri::command]
pub async fn get_branch_checkouts(
    repository_path: String,
    after: i64,
) -> Result<Vec<(String, i64)>, CommandError> {
    git_ops::reflog::get_branch_checkouts(&repository_path, after)
        .await
        .map_err(CommandError::from)
}

/// The branch and tip a rebase is replaying, or `null` when none is in progress.
#[tauri::command]
pub async fn get_rebase_internal_state(
    repository_path: String,
) -> Result<Option<RebaseInternalState>, CommandError> {
    let git_dir = git_ops::rev_parse::resolve_git_dir(&repository_path)
        .await
        .map_err(CommandError::from)?;

    Ok(git_ops::operation_state::get_rebase_internal_state(git_dir).await)
}

/// Whether two revisions would merge cleanly, without touching the index or the working tree.
///
/// ```js
/// await invoke('determine_mergeability', { repositoryPath, ours: 'main', theirs: 'topic' })
/// // -> { kind: 'clean' } | { kind: 'conflicts', conflictedFiles: 3 } | { kind: 'invalid' }
/// ```
///
/// `merge-tree --write-tree` answers this in the object database, so asking is free of side effects — the
/// user's checkout is untouched. `invalid` covers unrelated histories, which have no merge to describe.
#[tauri::command]
pub async fn determine_mergeability(
    repository_path: String,
    ours: String,
    theirs: String,
) -> Result<MergeTreeResult, CommandError> {
    git_ops::merge_tree::determine_mergeability(&repository_path, &ours, &theirs)
        .await
        .map_err(CommandError::from)
}
