//! Linked worktrees, exposed to the frontend.
//!
//! Thin wrappers over `git_ops::worktree`. Its own module because the store treats worktrees as a domain of
//! their own, and because the three listing entry points need explaining together.

use super::CommandError;
use crate::operation::GitOperationKind;
use crate::operation::OperationError;
use crate::operation::OperationErrorKind;
use crate::operation::OperationOutcome;
use crate::operation::OperationState;
use crate::operation_registry::OperationRegistry;
use git_ops::worktree::AddWorktreeOptions;
use git_ops::worktree::WorktreeEntry;
use tauri::State;
use tauri::WebviewWindow;

/// Worktree administration writes the *common* git directory — `worktrees/<name>`, and a ref when
/// `createBranch` is used — so it takes the source repository's lock, not the new worktree's. The
/// Checkout category is the one the plan already uses for ref and worktree writes that are not one
/// of the named history operations.
async fn start_worktree_operation(
    registry: &OperationRegistry,
    repository_path: &str,
    owner_window: Option<String>,
) -> Result<crate::operation::OperationRecord, CommandError> {
    crate::commands::operations::start_repository_operation(
        registry,
        repository_path,
        owner_window,
        GitOperationKind::Checkout,
    )
    .await
}

fn finish_worktree_mutation(
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
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    path: String,
    create_branch: Option<String>,
    commitish: Option<String>,
) -> Result<(), CommandError> {
    let operation =
        start_worktree_operation(&registry, &repository_path, Some(window.label().to_owned()))
            .await?;
    finish_worktree_mutation(
        &registry,
        &operation.id,
        git_ops::worktree::add_worktree(
            &repository_path,
            &path,
            AddWorktreeOptions {
                create_branch: create_branch.as_deref(),
                commitish: commitish.as_deref(),
            },
        )
        .await,
    )
}

/// Removes a linked worktree.
///
/// `force` removes one with changes in it. Without it git refuses, which is the behaviour to keep unless the
/// user has been asked.
#[tauri::command]
pub async fn remove_worktree(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    worktree: String,
    force: Option<bool>,
) -> Result<(), CommandError> {
    let operation =
        start_worktree_operation(&registry, &repository_path, Some(window.label().to_owned()))
            .await?;
    finish_worktree_mutation(
        &registry,
        &operation.id,
        git_ops::worktree::remove_worktree(&repository_path, &worktree, force.unwrap_or(false))
            .await,
    )
}

/// Moves a linked worktree to a new path.
#[tauri::command]
pub async fn move_worktree(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    old_path: String,
    new_path: String,
) -> Result<(), CommandError> {
    let operation =
        start_worktree_operation(&registry, &repository_path, Some(window.label().to_owned()))
            .await?;
    finish_worktree_mutation(
        &registry,
        &operation.id,
        git_ops::worktree::move_worktree(&repository_path, &old_path, &new_path).await,
    )
}

#[cfg(test)]
mod lock_tests {
    use super::*;
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

    fn repository() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Worktree Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "worktree@example.test"],
        );
        std::fs::write(directory.path().join("a.txt"), "one\n").expect("file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        directory
    }

    /// Worktree administration writes `worktrees/<name>` in the *common* git directory, so it has
    /// to be exclusive against the checkouts and commits that read it.
    #[tokio::test]
    async fn worktree_administration_excludes_a_second_repository_writer() {
        let directory = repository();
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();

        let operation = start_worktree_operation(&registry, &repository_path, None)
            .await
            .expect("the worktree operation should reserve the repository");

        let conflict = crate::commands::operations::start_repository_operation(
            &registry,
            &repository_path,
            Some("peer-window".to_owned()),
            GitOperationKind::Commit,
        )
        .await;
        assert!(
            conflict.is_err(),
            "a peer commit must not run while worktree administration holds the lock"
        );

        finish_worktree_mutation(&registry, &operation.id, Ok(()))
            .expect("a successful worktree mutation reports completion");

        crate::commands::operations::start_repository_operation(
            &registry,
            &repository_path,
            Some("peer-window".to_owned()),
            GitOperationKind::Commit,
        )
        .await
        .expect("the lock is released once the worktree mutation finishes");
    }

    #[tokio::test]
    async fn a_failed_worktree_mutation_still_releases_the_lock() {
        let directory = repository();
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();

        // A real failure: the destination path already exists, which git refuses.
        let existing = directory
            .path()
            .join("a.txt")
            .to_string_lossy()
            .into_owned();
        let operation = start_worktree_operation(&registry, &repository_path, None)
            .await
            .expect("the worktree operation should reserve the repository");
        let result = finish_worktree_mutation(
            &registry,
            &operation.id,
            git_ops::worktree::add_worktree(
                &repository_path,
                &existing,
                AddWorktreeOptions {
                    create_branch: None,
                    commitish: None,
                },
            )
            .await,
        );

        assert!(result.is_err(), "adding onto an existing path should fail");
        // The scope comes from the record rather than the path, because the lock key is
        // canonicalized internally while the displayed path is not.
        assert!(
            registry.active_for_scope(&operation.scope).is_none(),
            "a failed worktree mutation must not keep the repository locked"
        );
    }
}
