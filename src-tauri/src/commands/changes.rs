//! Working-tree and index commands — the Changes view's backend.
//!
//! Staging, unstaging, discarding and committing. Reading the diff of what is uncommitted lives in
//! [`super::diffs`] with the other diff queries.

use crate::commands::operation_lifecycle::{finish_checkout_mutation, finish_commit_termination};
use crate::commands::CommandError;
use crate::hook_state::{support_for_operation, HookFailurePrompt, HookRegistry};
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::OperationRegistry;
use git_ops::commit::CommitOptions;
use git_ops::diff::TextDiffData;
use git_ops::diff_index::IndexStatus;
use git_ops::hooks::runner::HookProgressUpdate;
use git_ops::patch_formatter::LineSelection;
use git_ops::rebase::ManualResolution;
use git_ops::reset::ResetMode;
use git_ops::status::StatusResult;
use git_ops::update_index::FileToStage;
use git_ops::MultiOperationTerminalOutput;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

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
    let operation = crate::commands::operation::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Commit,
        "Cancel commit",
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
    let snapshot = match git_ops::commit::get_commit_snapshot(&repository_path).await {
        Ok(snapshot) => snapshot,
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
            return Err(command_error);
        }
    };
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let watchdog = registry.spawn_watchdog(
        operation.id.clone(),
        crate::operation_registry::WatchdogPolicy::default(),
    );

    // `options` is optional so the frontend can omit it entirely, matching the original's
    // `options?: { … }`. Absent means every flag off.
    let result = git_ops::commit::create_commit_with_terminal_output_controlled(
        &repository_path,
        &message,
        &files,
        options.unwrap_or_default(),
        support.as_ref(),
        &terminal_output,
        control,
    )
    .await;
    watchdog.abort();
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
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            finish_commit_termination(
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
