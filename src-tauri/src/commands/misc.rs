//! The smaller git commands: tags, revert, reflog, description, identity and clean.
//!
//! Grouped because each is one or two functions; splitting them per original file would give a dozen
//! modules of five lines. The `git-ops` side keeps the per-file mapping.

use tauri::ipc::Channel;
use tauri::State;

use git_ops::log::CommitIdentity;
use git_ops::revert::RevertProgress;

use super::CommandError;
use crate::trampoline_state::TrampolineState;

/// Creates an annotated tag on a commit.
#[tauri::command]
pub async fn create_tag(
    repository_path: String,
    name: String,
    target_commit: String,
) -> Result<(), CommandError> {
    git_ops::tag::create_tag(&repository_path, &name, &target_commit)
        .await
        .map_err(CommandError::from)
}

/// Deletes a local tag.
#[tauri::command]
pub async fn delete_tag(repository_path: String, name: String) -> Result<(), CommandError> {
    git_ops::tag::delete_tag(&repository_path, &name)
        .await
        .map_err(CommandError::from)
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

/// The tags a push would send, without sending them.
///
/// Contacts the remote, so it needs a credential session.
#[tauri::command]
pub async fn fetch_tags_to_push(
    state: State<'_, TrampolineState>,
    repository_path: String,
    remote_name: String,
    branch_name: String,
    is_background_task: Option<bool>,
) -> Result<Vec<String>, CommandError> {
    let remote = state
        .session_for(&repository_path, is_background_task.unwrap_or(false))
        .await
        .map_err(|error| CommandError {
            message: format!("could not start the credential server: {error}"),
            kind: None,
            is_auth_failure: false,
        })?;

    git_ops::tag::fetch_tags_to_push(&repository_path, &remote_name, &branch_name, &remote.env)
        .await
        .map_err(CommandError::from)
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
    repository_path: String,
    commit: String,
    parent_count: usize,
    on_progress: Channel<RevertProgress>,
) -> Result<(), CommandError> {
    git_ops::revert::revert_commit(
        &repository_path,
        &commit,
        parent_count,
        Some(|progress: RevertProgress| {
            let _ = on_progress.send(progress);
        }),
    )
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
    repository_path: String,
    description: String,
) -> Result<(), CommandError> {
    git_ops::description::write_description(&repository_path, &description)
        .await
        .map_err(CommandError::from)
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
pub async fn clean_untracked_files(repository_path: String) -> Result<(), CommandError> {
    git_ops::clean::clean_untracked_files(&repository_path)
        .await
        .map_err(CommandError::from)
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
