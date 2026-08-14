//! Merging branches.
//!
//! Ported from `desktop-plus/app/src/lib/git/merge.ts`.
//!
//! # Hooks
//!
//! [`merge`] takes the hook machinery. A merge and the commit that concludes a **squash** merge reach
//! different hooks, and upstream lists them separately for a reason: a plain merge commits as part of the
//! merge, while `--squash` leaves a second invocation that is a commit in every way that matters. See
//! [`crate::hooks`].
//!
//! Upstream also accepts an optional terminal-output callback here, but no production caller supplies
//! one. The backend aggregation remains available in [`crate::multi_operation_terminal_output`];
//! Phase 7 may add a command Channel if it ports a real consumer.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, git_streaming_controlled, ExecutionControl, GitOptions};
use crate::git_error_kind::GitErrorKind;
use crate::hooks::with_env::{with_hooks_env, HookSupport};

/// The app-specific result of attempting a merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MergeResult {
    /// The merge completed and changed the current branch.
    Success,
    /// The current branch already contained the target branch.
    AlreadyUpToDate,
    /// Git left a conflicted merge for the user to resolve.
    Failed,
}

/// Options which change how a merge is performed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeOptions {
    pub squash: bool,
    pub no_verify: bool,
}

/// Merges `branch` into the current branch.
pub async fn merge(
    repository: impl AsRef<Path>,
    branch: &str,
    options: MergeOptions,
    hooks: Option<&HookSupport>,
) -> Result<MergeResult, GitError> {
    merge_controlled(repository, branch, options, hooks, None).await
}

/// Merges `branch` while allowing the owning operation to terminate Git and its descendants.
///
/// A squash merge has two Git phases (`merge --squash`, then `commit`), so the same control is
/// passed to both. The command layer must inspect which phase left state before choosing recovery.
pub async fn merge_controlled(
    repository: impl AsRef<Path>,
    branch: &str,
    options: MergeOptions,
    hooks: Option<&HookSupport>,
    control: Option<ExecutionControl>,
) -> Result<MergeResult, GitError> {
    let repository = repository.as_ref();
    let mut args = vec!["merge"];
    if options.squash {
        args.push("--squash");
    }
    if options.no_verify {
        args.push("--no-verify");
    }
    args.push(branch);

    // The merge itself and the commit that concludes a squash merge reach **different** hooks, and
    // upstream lists them separately for that reason: a plain merge commits as part of the merge, while
    // `--squash` leaves the commit to a second invocation which is a commit in every way that matters.
    let merge_hooks =
        hooks.map(|support| support.intercepting(["pre-merge-commit", "post-merge", "commit-msg"]));
    let merge_control = control.clone();

    let output = with_hooks_env(
        repository,
        merge_hooks.as_ref(),
        HashMap::new(),
        |env| async move {
            let mut git_options =
                GitOptions::default().with_expected_errors([GitErrorKind::MergeConflicts]);
            for (name, value) in env {
                git_options = git_options.with_env(name, value);
            }

            git_streaming_controlled(
                &args,
                repository,
                "merge",
                git_options,
                merge_control,
                |_| {},
                |_| {},
            )
            .await
        },
    )
    .await??;

    if output.exit_code != 0 {
        return Ok(MergeResult::Failed);
    }

    if options.squash {
        let commit_hooks = hooks.map(|support| {
            support.intercepting([
                "pre-merge-commit",
                "prepare-commit-msg",
                "commit-msg",
                "post-commit",
                "pre-auto-gc",
            ])
        });

        let commit = with_hooks_env(
            repository,
            commit_hooks.as_ref(),
            HashMap::new(),
            |env| async move {
                let mut git_options = GitOptions::default();
                for (name, value) in env {
                    git_options = git_options.with_env(name, value);
                }

                git_streaming_controlled(
                    &["commit", "--no-edit"],
                    repository,
                    "createSquashMergeCommit",
                    git_options,
                    control.clone(),
                    |_| {},
                    |_| {},
                )
                .await
            },
        )
        .await??;

        if commit.exit_code != 0 {
            return Ok(MergeResult::Failed);
        }
    }

    // This exact output check is inherited from the original. `git merge` has no machine-readable
    // "noop" result, so the command's stable C-locale message is the only distinction it exposed.
    Ok(if output.stdout_lossy() == "Already up to date.\n" {
        MergeResult::AlreadyUpToDate
    } else {
        MergeResult::Success
    })
}

/// Finds the best common ancestor of two commit-ish identifiers.
///
/// `None` means either there is no common ancestor (exit 1) or one of the refs cannot be resolved
/// (exit 128), matching the original.
pub async fn get_merge_base(
    repository: impl AsRef<Path>,
    first_commitish: &str,
    second_commitish: &str,
) -> Result<Option<String>, GitError> {
    let output = git(
        &["merge-base", first_commitish, second_commitish],
        repository,
        "merge-base",
        GitOptions::default().with_success_exit_codes([1, 128]),
    )
    .await?;

    Ok((output.exit_code == 0).then(|| output.stdout_trimmed()))
}

/// Aborts an in-progress conflicted merge.
pub async fn abort_merge(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["merge", "--abort"],
        repository,
        "abortMerge",
        GitOptions::default(),
    )
    .await?;
    Ok(())
}

/// Returns whether a squash merge left its temporary message and index/worktree state behind.
pub async fn is_squash_merge_in_progress(repository: impl AsRef<Path>) -> Result<bool, GitError> {
    let git_dir = crate::rev_parse::resolve_git_dir(repository).await?;
    Ok(tokio::fs::metadata(git_dir.join("SQUASH_MSG"))
        .await
        .is_ok())
}

/// Restores the pre-squash index and worktree without resetting an unrelated branch tip.
pub async fn abort_squash_merge(repository: impl AsRef<Path>) -> Result<(), GitError> {
    if !is_squash_merge_in_progress(&repository).await? {
        return Err(GitError::UnexpectedExitCode {
            name: "abortSquashMerge".to_owned(),
            path: repository.as_ref().to_owned(),
            exit_code: 1,
            kind: Some(GitErrorKind::NoMergeToAbort),
            stderr: "There is no squash merge to abort".to_owned(),
        });
    }
    git(
        &["reset", "--merge", "HEAD"],
        repository,
        "abortSquashMerge",
        GitOptions::default(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

    async fn divergent_repository() -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        let path = repo.path();
        commit_file(&path, "base", "base", "base");
        git(&["branch", "dev"], &path, "test", GitOptions::default())
            .await
            .expect("branch should succeed");
        commit_file(&path, "main", "main", "main");
        git(&["checkout", "dev"], &path, "test", GitOptions::default())
            .await
            .expect("checkout should succeed");
        commit_file(&path, "dev", "dev", "dev");
        git(&["checkout", "main"], &path, "test", GitOptions::default())
            .await
            .expect("checkout should succeed");
        repo
    }

    #[tokio::test]
    async fn merges_a_branch_and_detects_the_following_noop() {
        let repo = divergent_repository().await;
        assert_eq!(
            merge(repo.path(), "dev", MergeOptions::default(), None)
                .await
                .expect("merge should succeed"),
            MergeResult::Success
        );
        assert_eq!(
            merge(repo.path(), "dev", MergeOptions::default(), None)
                .await
                .expect("second merge should succeed"),
            MergeResult::AlreadyUpToDate
        );
    }

    #[tokio::test]
    async fn reports_conflicts_without_turning_them_into_an_error() {
        let repo = conflicted_repository().await;
        // The helper already has an in-progress conflict, so abort and reproduce it through this
        // module in the opposite direction.
        abort_merge(repo.path())
            .await
            .expect("setup merge should abort");
        let result = merge(repo.path(), "main", MergeOptions::default(), None)
            .await
            .expect("a declared conflict should be a result");
        assert_eq!(result, MergeResult::Failed);
    }

    #[tokio::test]
    async fn finds_a_merge_base() {
        let repo = divergent_repository().await;
        let expected = git(
            &["rev-parse", "dev~1"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        assert_eq!(
            get_merge_base(repo.path(), "main", "dev")
                .await
                .expect("merge-base should succeed"),
            Some(expected)
        );
    }

    #[tokio::test]
    async fn returns_none_for_a_missing_ref() {
        let repo = divergent_repository().await;
        assert_eq!(
            get_merge_base(repo.path(), "main", "does-not-exist")
                .await
                .expect("a missing ref is a normal answer"),
            None
        );
    }

    #[tokio::test]
    async fn aborts_a_conflicted_merge() {
        let repo = conflicted_repository().await;
        abort_merge(repo.path())
            .await
            .expect("abort should succeed");
        let git_dir = crate::rev_parse::resolve_git_dir(repo.path())
            .await
            .expect("git dir should resolve");
        assert!(!crate::operation_state::is_merge_head_set(git_dir).await);
    }

    #[tokio::test]
    async fn abort_without_a_merge_preserves_the_classified_error() {
        let repo = empty_repository().await;
        let error = abort_merge(repo.path())
            .await
            .expect_err("there is no merge to abort");
        assert!(matches!(
            error,
            GitError::UnexpectedExitCode {
                kind: Some(GitErrorKind::NoMergeToAbort),
                ..
            }
        ));
    }
}
