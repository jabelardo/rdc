//! Reverting a commit.
//!
//! Ported from `desktop-plus/app/src/lib/git/revert.ts`.
//!
//! # The upstream progress parser is a no-op, by construction
//!
//! `RevertProgressParser` was `GitProgressParser` with a single step: `{ title: '', weight: 0 }`. Both
//! halves of that are inert.
//!
//! An empty title can never match, because the line parser requires a non-empty title before the last
//! `": "` — so no line is ever recognised as belonging to that step. And a total weight of zero makes the
//! normalisation `weight / totalWeight` a `0/0` NaN, so even a match would compute nothing. Every line
//! therefore came back as *context* carrying the unchanged `lastPercent`, which is zero.
//!
//! So a revert's progress was always `value: 0` with an empty title, and the parser existed only to put
//! git's output text into the description. Reproducing it literally isn't possible here —
//! [`crate::progress::GitProgressParser::new`] asserts a non-zero total weight rather than silently
//! producing NaN — so this streams the lines and reports the same thing directly, which is both faithful
//! and honest about what the number means.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, git_with_stderr_and_lfs_controlled, ExecutionControl, GitOptions};
use crate::progress::{GitLfsProgressParser, GitProgress, ProgressLineSplitter};

/// Returns whether Git left a conflicted revert in progress.
pub async fn is_revert_in_progress(repository: impl AsRef<Path>) -> Result<bool, GitError> {
    let git_dir = crate::rev_parse::resolve_git_dir(repository).await?;
    Ok(tokio::fs::metadata(git_dir.join("REVERT_HEAD"))
        .await
        .is_ok())
}

/// A revert progress update.
///
/// Matches `IRevertProgress` in the ported `src/models/progress.ts`. `value` is always zero — see the
/// module docs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertProgress {
    pub kind: RevertProgressKind,
    pub value: f64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertProgressKind {
    Revert,
}

/// Creates a commit undoing `commit`.
///
/// `parent_count` is how many parents the commit has, which the caller already knows from its `Commit`.
/// A **merge commit needs `-m 1`**: reverting a merge is ambiguous without saying which side to treat as
/// the mainline, and git refuses rather than guessing. Passing it for a non-merge commit would make git
/// refuse instead, which is why it depends on the count rather than always being sent.
pub async fn revert_commit<F>(
    repository: impl AsRef<Path>,
    commit: &str,
    parent_count: usize,
    on_progress: Option<F>,
) -> Result<(), GitError>
where
    F: FnMut(RevertProgress) + Send,
{
    revert_commit_controlled(repository, commit, parent_count, on_progress, None).await
}

/// Reverts with operation-owned process control. Termination is returned to the command layer
/// before `revert --abort` is attempted.
pub async fn revert_commit_controlled<F>(
    repository: impl AsRef<Path>,
    commit: &str,
    parent_count: usize,
    on_progress: Option<F>,
    control: Option<ExecutionControl>,
) -> Result<(), GitError>
where
    F: FnMut(RevertProgress) + Send,
{
    let mut args = vec!["revert".to_owned()];
    if parent_count > 1 {
        args.extend(["-m".to_owned(), "1".to_owned()]);
    }
    args.push(commit.to_owned());

    let Some(on_progress) = on_progress else {
        git_with_stderr_and_lfs_controlled(
            &args,
            repository,
            "revert",
            GitOptions::default(),
            control,
            |_| {},
            |_| {},
        )
        .await?;
        return Ok(());
    };

    let mut splitter = ProgressLineSplitter::new();
    let mut lfs_parser = GitLfsProgressParser::default();
    let progress = Arc::new(Mutex::new(on_progress));
    let regular_progress = Arc::clone(&progress);
    let lfs_progress = Arc::clone(&progress);

    git_with_stderr_and_lfs_controlled(
        &args,
        repository,
        "revert",
        GitOptions::default(),
        control,
        |chunk| {
            for line in splitter.push(chunk) {
                with_progress_callback(&regular_progress, |callback| {
                    callback(RevertProgress {
                        kind: RevertProgressKind::Revert,
                        // Always zero, as upstream — there is nothing to compute it from.
                        value: 0.0,
                        title: String::new(),
                        description: Some(line),
                    });
                });
            }
        },
        |line| {
            if let GitProgress::Progress { percent, details } = lfs_parser.parse(line) {
                with_progress_callback(&lfs_progress, |callback| {
                    callback(RevertProgress {
                        kind: RevertProgressKind::Revert,
                        value: percent,
                        title: details.title,
                        description: Some(details.text),
                    });
                });
            }
        },
    )
    .await?;

    Ok(())
}

/// Abandons an interrupted revert and restores the pre-revert index and worktree state.
pub async fn abort_revert(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["revert".to_owned(), "--abort".to_owned()],
        repository,
        "revert abort",
        GitOptions::default(),
    )
    .await
    .map(|_| ())
}

fn with_progress_callback<F, R>(callback: &Mutex<F>, invoke: impl FnOnce(&mut F) -> R) -> R {
    let mut callback = callback
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    invoke(&mut callback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    async fn head(repo: &Path) -> String {
        git(&["rev-parse", "HEAD"], repo, "test", GitOptions::default())
            .await
            .expect("rev-parse should succeed")
            .stdout_trimmed()
    }

    #[tokio::test]
    async fn reverts_a_commit() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        revert_commit(
            repo.path(),
            &head(&repo.path()).await,
            1,
            None::<fn(RevertProgress)>,
        )
        .await
        .expect("reverting should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "one\n",
            "the change is undone"
        );
    }

    #[tokio::test]
    async fn cancelled_revert_does_not_change_head() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");
        let original_head = head(&repo.path()).await;
        let control = ExecutionControl::new();
        control.cancel(crate::error::TerminationReason::Cancelled);

        let result = revert_commit_controlled(
            repo.path(),
            &original_head,
            1,
            None::<fn(RevertProgress)>,
            Some(control),
        )
        .await;

        assert!(matches!(result, Err(GitError::OperationTerminated { .. })));
        assert_eq!(head(&repo.path()).await, original_head);
    }

    #[tokio::test]
    async fn aborting_a_conflicted_revert_restores_head_and_worktree() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");
        let reverted_commit = head(&repo.path()).await;
        commit_file(&repo.path(), "a.txt", "three\n", "third");
        let original_head = head(&repo.path()).await;

        let result =
            revert_commit(repo.path(), &reverted_commit, 1, None::<fn(RevertProgress)>).await;
        assert!(result.is_err(), "the revert should stop on the conflict");
        assert!(is_revert_in_progress(repo.path())
            .await
            .expect("repository should resolve"));

        abort_revert(repo.path())
            .await
            .expect("abort should restore the repository");
        assert_eq!(head(&repo.path()).await, original_head);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("file should be readable"),
            "three\n"
        );
        assert!(!is_revert_in_progress(repo.path())
            .await
            .expect("repository should resolve"));
    }

    #[tokio::test]
    async fn adds_a_commit_rather_than_rewriting_history() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        revert_commit(repo.path(), "HEAD", 1, None::<fn(RevertProgress)>)
            .await
            .expect("reverting should succeed");

        let count = git(
            &["rev-list", "--count", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-list should succeed")
        .stdout_trimmed();
        assert_eq!(count, "3", "a revert is a new commit");
    }

    #[tokio::test]
    async fn detects_a_revert_marker_only_while_recovery_state_exists() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert!(!is_revert_in_progress(repo.path())
            .await
            .expect("repository should resolve"));
        std::fs::write(repo.path().join(".git/REVERT_HEAD"), "deadbeef\n")
            .expect("revert marker should be writable");
        assert!(is_revert_in_progress(repo.path())
            .await
            .expect("repository should resolve"));
    }

    #[tokio::test]
    async fn reverts_a_merge_commit_against_its_first_parent() {
        // Without `-m 1` git refuses a merge commit outright, since which side to undo is ambiguous.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "base.txt", "base\n", "base");

        git(
            &["checkout", "-b", "feature", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "feature.txt", "feature\n", "feature work");

        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "main.txt", "main\n", "main work");
        git(
            &["merge", "--no-ff", "feature", "-m", "merge feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("merge should succeed");

        assert!(repo.path().join("feature.txt").exists());

        revert_commit(repo.path(), "HEAD", 2, None::<fn(RevertProgress)>)
            .await
            .expect("reverting a merge should succeed");

        assert!(
            !repo.path().join("feature.txt").exists(),
            "the merged side is undone"
        );
        assert!(
            repo.path().join("main.txt").exists(),
            "the mainline is untouched"
        );
    }

    #[tokio::test]
    async fn reverting_a_merge_without_the_parent_count_fails() {
        // Proves the `-m 1` is load-bearing rather than decorative: claiming one parent for a merge
        // commit makes git refuse.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "base.txt", "base\n", "base");
        git(
            &["checkout", "-b", "feature", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "feature.txt", "feature\n", "feature work");
        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "main.txt", "main\n", "main work");
        git(
            &["merge", "--no-ff", "feature", "-m", "merge feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("merge should succeed");

        assert!(
            revert_commit(repo.path(), "HEAD", 1, None::<fn(RevertProgress)>)
                .await
                .is_err(),
            "git needs to be told which parent is the mainline"
        );
    }

    #[tokio::test]
    async fn reports_progress_as_text_with_a_zero_value() {
        // Documented in the module docs: upstream's parser could never compute a percentage, so the
        // value is always zero and the description carries git's output.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        let mut updates: Vec<RevertProgress> = Vec::new();
        revert_commit(
            repo.path(),
            "HEAD",
            1,
            Some(|progress: RevertProgress| updates.push(progress)),
        )
        .await
        .expect("reverting should succeed");

        for update in &updates {
            assert_eq!(update.value, 0.0);
            assert_eq!(update.kind, RevertProgressKind::Revert);
        }
    }

    #[test]
    fn progress_omits_an_absent_description() {
        let value = serde_json::to_value(RevertProgress {
            kind: RevertProgressKind::Revert,
            value: 0.0,
            title: String::new(),
            description: None,
        })
        .expect("serializes");

        assert!(value.get("description").is_none());
        assert_eq!(value["kind"], "revert");
    }
}
