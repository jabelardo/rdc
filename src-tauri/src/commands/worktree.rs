//! Linked worktrees, exposed to the frontend.
//!
//! Thin wrappers over `git_ops::worktree`. Its own module because the store treats worktrees as a domain of
//! their own, and because the three listing entry points need explaining together.

use git_ops::worktree::{AddWorktreeOptions, WorktreeEntry};

use super::CommandError;

/// The worktrees a repository has, as git reports them.
///
/// ```js
/// await invoke('list_worktrees', { repositoryPath })
/// ```
///
/// The main worktree is included — git lists it first — so a repository with no linked worktrees still reports
/// one entry.
#[tauri::command]
pub async fn list_worktrees(repository_path: String) -> Result<Vec<WorktreeEntry>, CommandError> {
    git_ops::worktree::list_worktrees(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// The worktrees of a repository named by its **git directory** rather than its working tree.
///
/// ```js
/// await invoke('list_worktrees_from_git_dir', { gitDir })
/// ```
///
/// Needed because a linked worktree's `.git` is a *file* pointing elsewhere, so there are situations — a
/// worktree whose working directory is gone, for instance — where the git directory is the only handle left.
#[tauri::command]
pub async fn list_worktrees_from_git_dir(
    git_dir: String,
) -> Result<Vec<WorktreeEntry>, CommandError> {
    git_ops::worktree::list_worktrees_from_git_dir(&git_dir)
        .await
        .map_err(CommandError::from)
}

/// The same, for a git directory git itself can no longer enumerate.
///
/// Reads the administrative files directly instead of asking git, which is what makes it work where
/// `list_worktrees_from_git_dir` doesn't — see `git_ops::worktree` for exactly when that happens.
#[tauri::command]
pub async fn list_worktrees_from_git_dir_fallback(
    git_dir: String,
) -> Result<Vec<WorktreeEntry>, CommandError> {
    git_ops::worktree::list_worktrees_from_git_dir_fallback(&git_dir)
        .await
        .map_err(CommandError::from)
}

/// Creates a linked worktree.
///
/// ```js
/// await invoke('add_worktree', { repositoryPath, path, commitish: 'main' })
/// // or, checking out a new branch there:
/// await invoke('add_worktree', { repositoryPath, path, createBranch: 'topic' })
/// ```
///
/// `createBranch` and `commitish` are both optional and mean different things: the first checks out a *new*
/// branch in the worktree, the second an existing revision. Neither means git picks `HEAD`.
#[tauri::command]
pub async fn add_worktree(
    repository_path: String,
    path: String,
    create_branch: Option<String>,
    commitish: Option<String>,
) -> Result<(), CommandError> {
    git_ops::worktree::add_worktree(
        &repository_path,
        &path,
        AddWorktreeOptions {
            create_branch: create_branch.as_deref(),
            commitish: commitish.as_deref(),
        },
    )
    .await
    .map_err(CommandError::from)
}

/// Removes a linked worktree.
///
/// `force` removes one with changes in it. Without it git refuses, which is the behaviour to keep unless the
/// user has been asked.
#[tauri::command]
pub async fn remove_worktree(
    repository_path: String,
    worktree: String,
    force: Option<bool>,
) -> Result<(), CommandError> {
    git_ops::worktree::remove_worktree(&repository_path, &worktree, force.unwrap_or(false))
        .await
        .map_err(CommandError::from)
}

/// Moves a linked worktree to a new path.
#[tauri::command]
pub async fn move_worktree(
    repository_path: String,
    old_path: String,
    new_path: String,
) -> Result<(), CommandError> {
    git_ops::worktree::move_worktree(&repository_path, &old_path, &new_path)
        .await
        .map_err(CommandError::from)
}
