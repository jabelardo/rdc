//! The smaller git commands: tags, revert, reflog, description, identity and clean.
//!
//! Grouped because each is one or two functions; splitting them per original file would give a dozen
//! modules of five lines. The `git-ops` side keeps the per-file mapping.

use tauri::ipc::Channel;

use git_ops::interpret_trailers::Trailer;
use git_ops::log::CommitIdentity;
use git_ops::merge_tree::MergeTreeResult;
use git_ops::operation_state::RebaseInternalState;
use git_ops::rev_parse::RepositoryType;
use git_ops::revert::RevertProgress;

use super::CommandError;
use crate::operation::{
    GitOperationKind, OperationError, OperationErrorKind, OperationOutcome, OperationState,
};
use crate::operation_registry::{OperationRegistry, WatchdogPolicy};
use tauri::{State, WebviewWindow};

/// Creates an annotated tag on a commit.
#[tauri::command]
pub async fn create_tag(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
    target_commit: String,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::tag::create_tag(&repository_path, &name, &target_commit).await,
    )
}

/// Deletes a local tag.
#[tauri::command]
pub async fn delete_tag(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    name: String,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::tag::delete_tag(&repository_path, &name).await,
    )
}

/// Every local tag, as `[name, commit]` pairs.
///
/// Pairs rather than an object, because a tag name is an arbitrary string. An **annotated** tag maps to
/// the commit it points at, not to its tag object — see `git_ops::tag`.
#[tauri::command]
pub async fn get_all_tags(repository_path: String) -> Result<Vec<(String, String)>, CommandError> {
    let tags = git_ops::tag::get_all_tags(&repository_path)
        .await
        .map_err(CommandError::from)?;

    let mut pairs: Vec<(String, String)> = tags.into_iter().collect();
    // git's own order isn't meaningful once it's a map, so sort for a stable result.
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(pairs)
}

/// Creates a commit undoing another.
///
/// ```js
/// await invoke('revert_commit', { repositoryPath, commit: sha, parentCount: 1, onProgress })
/// ```
///
/// `parentCount` comes from the commit's `parentSHAs`. A merge commit needs it: reverting one is
/// ambiguous without saying which side is the mainline, and git refuses rather than guessing.
///
/// Progress `value` is always `0` — see `git_ops::revert` for why.
#[tauri::command]
pub async fn revert_commit(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    commit: String,
    parent_count: usize,
    on_progress: Channel<RevertProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operation::start_cancellable_repository_operation(
        &registry,
        &repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Revert,
        "Cancel revert",
    )
    .await?;
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let pre_operation_head = git_ops::get_head_sha(&repository_path)
        .await
        .map_err(CommandError::from)?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::revert::revert_commit_controlled(
        &repository_path,
        &commit,
        parent_count,
        Some(|progress: RevertProgress| {
            let _ = on_progress.send(progress);
        }),
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
            finish_revert_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                reason,
            )
            .await
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
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

async fn finish_revert_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    reason: git_ops::TerminationReason,
) -> Result<(), CommandError> {
    // REVERT_HEAD is the only safe abort boundary. Without it, a late stop may have followed a
    // completed revert, and `revert --abort` would incorrectly undo that completed commit.
    let in_progress = git_ops::revert::is_revert_in_progress(repository_path)
        .await
        .map_err(|error| finish_revert_recovery_failure(registry, operation_id, error))?;
    if !in_progress {
        let current_head = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_revert_recovery_failure(registry, operation_id, error))?;
        if current_head != pre_operation_head {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(());
        }

        let (state, kind, verb) = revert_termination_details(reason);
        let message = format!("Revert {verb} before it changed the repository");
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

    match git_ops::revert::abort_revert(repository_path).await {
        Ok(()) => {
            let (state, _, verb) = revert_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!(
                "Revert {verb} and recovered"
            )))
        }
        Err(error) => Err(finish_revert_recovery_failure(
            registry,
            operation_id,
            error,
        )),
    }
}

fn revert_termination_details(
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

fn finish_revert_recovery_failure(
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

/// Aborts an interrupted revert, restoring the branch, index and worktree when Git has revert state.
#[tauri::command]
pub async fn abort_revert(repository_path: String) -> Result<(), CommandError> {
    git_ops::revert::abort_revert(&repository_path)
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

/// The repository's description, or an empty string if it has none.
#[tauri::command]
pub async fn get_description(repository_path: String) -> Result<String, CommandError> {
    git_ops::description::get_description(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Writes the repository's description.
#[tauri::command]
pub async fn write_description(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    description: String,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::description::write_description(&repository_path, &description).await,
    )
}

/// The identity a commit made now would carry, or `null` if git would refuse to invent one.
///
/// `null` means a commit will fail for the same reason, so the caller should prompt rather than proceed.
#[tauri::command]
pub async fn get_author_identity(
    repository_path: String,
) -> Result<Option<CommitIdentity>, CommandError> {
    git_ops::var::get_author_identity(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Deletes untracked files and directories.
///
/// **Irreversible** — these files are not in git. Ignored files are left alone.
#[tauri::command]
pub async fn clean_untracked_files(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::clean::clean_untracked_files(&repository_path).await,
    )
}

async fn start_misc_operation(
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

fn finish_misc_mutation(
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

/// Vouches for a repository git refuses as owned by someone else.
///
/// ```js
/// await invoke('add_safe_directory', { path: '/repos/borrowed' })
/// ```
///
/// Takes a **path, not a repository**: git won't read the repository's own config until it trusts the
/// path, so this necessarily writes the user's *global* config. That is also why it is the only remedy
/// for git's "dubious ownership" refusal.
///
/// Calling it repeatedly is harmless — an identical entry is never added twice.
#[tauri::command]
pub async fn add_safe_directory(path: String) -> Result<(), CommandError> {
    git_ops::config::GlobalConfig::new()
        .add_safe_directory(&path)
        .await
        .map_err(CommandError::from)
}

// --- configuration ---

/// Reads a config value, or `null` when the key isn't set.
///
/// ```js
/// await invoke('get_config_value', { repositoryPath, name: 'core.autocrlf', onlyLocal: false })
/// ```
///
/// `onlyLocal` restricts the lookup to the repository's own config, ignoring the global and system files.
/// Absent means the full cascade, which is what git itself answers with.
///
/// `null` for an unset key is not an error: git exits 1 for that, and "not configured" is an answer.
#[tauri::command]
pub async fn get_config_value(
    repository_path: String,
    name: String,
    only_local: Option<bool>,
) -> Result<Option<String>, CommandError> {
    git_ops::config::get_config_value(&repository_path, &name, only_local.unwrap_or(false))
        .await
        .map_err(CommandError::from)
}

/// Returns the user's global git config path, creating the file if necessary.
///
/// Git resolves the real path before invoking its editor, so this respects its platform and
/// environment rules instead of assuming the file is always `~/.gitconfig`.
#[tauri::command]
pub async fn get_global_config_path() -> Result<std::path::PathBuf, CommandError> {
    git_ops::config::GlobalConfig::new()
        .path()
        .await
        .map_err(CommandError::from)
}

// --- .gitignore ---

/// Reads the repository's root `.gitignore`, or `null` if there isn't one.
#[tauri::command]
pub async fn read_gitignore_at_root(
    repository_path: String,
) -> Result<Option<String>, CommandError> {
    git_ops::gitignore::read_gitignore_at_root(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Writes the repository's root `.gitignore`.
///
/// Empty text **removes the file** rather than leaving an empty one, which is what the original did — an
/// empty `.gitignore` and no `.gitignore` mean the same thing to git, and leaving one behind shows up as a
/// change the user didn't make.
///
/// The line endings written follow `core.autocrlf` and `core.safecrlf`, so the file matches what the rest of
/// the repository uses.
#[tauri::command]
pub async fn save_gitignore(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    text: String,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::gitignore::save_gitignore(&repository_path, &text).await,
    )
}

/// Appends ignore patterns to the root `.gitignore`, as written.
///
/// ```js
/// await invoke('append_ignore_rules', { repositoryPath, patterns: ['*.log', 'build/'] })
/// ```
///
/// For patterns the user typed, so nothing is escaped: `*` and `?` are what make a pattern a pattern.
#[tauri::command]
pub async fn append_ignore_rules(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    patterns: Vec<String>,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::gitignore::append_ignore_rules(&repository_path, &patterns).await,
    )
}

/// Appends *file names* to the root `.gitignore`, escaping them.
///
/// ```js
/// await invoke('append_ignore_files', { repositoryPath, paths: ['weird[1].txt'] })
/// ```
///
/// The counterpart to `append_ignore_rules`: these are names, not patterns, so glob characters in them are
/// escaped — otherwise ignoring `weird[1].txt` would quietly ignore something else.
#[tauri::command]
pub async fn append_ignore_files(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::gitignore::append_ignore_files(&repository_path, &paths).await,
    )
}

// --- Git LFS ---

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
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
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

// --- mergeability and operation state ---

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

/// What kind of repository — if any — is at `path`.
///
/// ```js
/// await invoke('get_repository_type', { path })
/// // -> { kind: 'regular', topLevelWorkingDirectory } | { kind: 'bare' } | { kind: 'missing' }
/// //  | { kind: 'unsafe', path }
/// ```
///
/// A path that isn't a repository is an **answer**, not an error — the caller is usually asking exactly that.
/// `unsafe` means git refused it for dubious ownership; `add_safe_directory` is the way out.
#[tauri::command]
pub async fn get_repository_type(path: String) -> Result<RepositoryType, CommandError> {
    git_ops::rev_parse::get_repository_type(&path)
        .await
        .map_err(CommandError::from)
}

/// Whether a cherry-pick is in progress.
///
/// Takes the repository path and resolves the git directory itself, because a linked worktree's `.git` is a
/// file rather than a directory — the naive join is wrong exactly where it matters.
#[tauri::command]
pub async fn is_cherry_pick_head_found(repository_path: String) -> Result<bool, CommandError> {
    let git_dir = git_ops::rev_parse::resolve_git_dir(&repository_path)
        .await
        .map_err(CommandError::from)?;

    Ok(git_ops::operation_state::is_cherry_pick_head_found(git_dir).await)
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

/// Copies the given paths out of the index into the working tree.
///
/// An empty `paths` is a no-op rather than "check out everything", which is what the bare command would do.
#[tauri::command]
pub async fn checkout_index(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    let operation = start_misc_operation(&window, &registry, &repository_path).await?;
    finish_misc_mutation(
        &registry,
        &operation.id,
        git_ops::checkout_index::checkout_index(&repository_path, &paths).await,
    )
}

// --- commit message trailers ---

/// The characters this repository accepts between a trailer's token and its value.
///
/// `trailer.separators` config, defaulting to `:`. Needed before a message can be parsed, since the separator
/// decides what counts as a trailer at all.
#[tauri::command]
pub async fn get_trailer_separator_characters(
    repository_path: String,
) -> Result<String, CommandError> {
    git_ops::interpret_trailers::get_trailer_separator_characters(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// The trailers in a commit message.
///
/// ```js
/// await invoke('parse_trailers', { repositoryPath, commitMessage })
/// // -> [{ token: 'Co-Authored-By', value: 'Someone <someone@example.com>' }]
/// ```
#[tauri::command]
pub async fn parse_trailers(
    repository_path: String,
    commit_message: String,
) -> Result<Vec<Trailer>, CommandError> {
    git_ops::interpret_trailers::parse_trailers(&repository_path, &commit_message)
        .await
        .map_err(CommandError::from)
}

/// A commit message with `trailers` merged into it, as git would write them.
///
/// Asking git rather than concatenating is what gets the blank line, the ordering and the existing trailers
/// right — `interpret-trailers` owns those rules.
#[tauri::command]
pub async fn merge_trailers(
    repository_path: String,
    commit_message: String,
    trailers: Vec<Trailer>,
    unfold: Option<bool>,
) -> Result<String, CommandError> {
    git_ops::interpret_trailers::merge_trailers(
        &repository_path,
        &commit_message,
        &trailers,
        unfold.unwrap_or(false),
    )
    .await
    .map_err(CommandError::from)
}
