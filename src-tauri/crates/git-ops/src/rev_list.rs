//! Commit ranges from `git rev-list`.
//!
//! Ported from `desktop-plus/app/src/lib/git/rev-list.ts`.
//!
//! Two of its exports are deliberately elsewhere. The **range helpers** — `revRange`,
//! `revRangeInclusive`, `revSymmetricDifference` — are string concatenation, so they live in
//! `src/lib/rev-range.ts` as TypeScript rather than as a round trip to Rust. And
//! `doMergeCommitsExistAfterCommit` has no consumer outside `ui/history/**`, so it lands with those
//! components in Phase 7.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_error_kind::GitErrorKind;
// The same `IAheadBehind` the status result already reports — one type, since `git status --branch` and
// `rev-list --count` answer the same question about different ranges.
pub use crate::status::AheadBehind;

/// How many commits each side of `range` has that the other does not.
///
/// `--left-right --count` is what does the work: `--left-right` marks which side of the range each commit came
/// from, and with `--count` git reports the two totals instead of the commits.
///
/// # `None` is an answer, not a failure
///
/// It means the question cannot be asked: a ref in the range no longer exists — most often an upstream branch
/// that was deleted — so there is no "ahead" or "behind" to report. The original treated `BadRevision` that
/// way, and also returned `null` for output it could not parse rather than raising; both are preserved,
/// because a caller showing "3 ahead, 1 behind" has nothing to say either way and the alternative is a failed
/// operation over a number in a label.
pub async fn get_ahead_behind(
    repository: impl AsRef<Path>,
    range: &str,
) -> Result<Option<AheadBehind>, GitError> {
    let output = git(
        &["rev-list", "--left-right", "--count", range, "--"],
        repository,
        "getAheadBehind",
        GitOptions::default().with_expected_errors([GitErrorKind::BadRevision]),
    )
    .await?;

    if output.git_error == Some(GitErrorKind::BadRevision) {
        return Ok(None);
    }

    // `<ahead>\t<behind>`, and anything else is unparseable rather than wrong.
    let stdout = output.stdout_trimmed();
    let mut counts = stdout.split('\t');
    let (Some(ahead), Some(behind), None) = (counts.next(), counts.next(), counts.next()) else {
        return Ok(None);
    };

    match (ahead.trim().parse(), behind.trim().parse()) {
        (Ok(ahead), Ok(behind)) => Ok(Some(AheadBehind { ahead, behind })),
        _ => Ok(None),
    }
}

/// The minimal commit shape used by progress and operation dialogs.
///
/// Mirrors `CommitOneLine` in `src/models/commit.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitOneLine {
    pub sha: String,
    pub summary: String,
}

/// Commits reachable from `target` but not `base`, in the order rebase will replay them.
pub async fn get_commits_between_commits(
    repository: impl AsRef<Path>,
    base: &str,
    target: &str,
) -> Result<Option<Vec<CommitOneLine>>, GitError> {
    get_commits_in_range(repository, &format!("{base}..{target}")).await
}

/// Gets commits in a revision range, oldest first.
///
/// Returns `None` when a ref cannot be resolved, matching the original's `BadRevision` handling.
pub async fn get_commits_in_range(
    repository: impl AsRef<Path>,
    range: &str,
) -> Result<Option<Vec<CommitOneLine>>, GitError> {
    let output = git(
        &[
            "rev-list",
            range,
            "--reverse",
            "--oneline",
            "--no-abbrev-commit",
            "--",
        ],
        repository,
        "getCommitsInRange",
        GitOptions::default().with_expected_errors([GitErrorKind::BadRevision]),
    )
    .await?;

    if output.git_error == Some(GitErrorKind::BadRevision) {
        return Ok(None);
    }

    let commits = output
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let (sha, summary) = line.split_once(' ')?;
            (sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| {
                CommitOneLine {
                    sha: sha.to_owned(),
                    summary: summary.to_owned(),
                }
            })
        })
        .collect();

    Ok(Some(commits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn returns_commits_in_replay_order_with_full_shas() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file", "base\n", "Base");
        let base = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        commit_file(&repo.path(), "file", "one\n", "First replayed commit");
        commit_file(&repo.path(), "file", "two\n", "Second replayed commit");

        let commits = get_commits_between_commits(repo.path(), &base, "HEAD")
            .await
            .expect("rev-list should succeed")
            .expect("the refs exist");

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["First replayed commit", "Second replayed commit"]
        );
        assert!(commits.iter().all(|commit| commit.sha.len() == 40));
    }

    #[tokio::test]
    async fn an_empty_range_returns_an_empty_list() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file", "base\n", "Base");

        assert_eq!(
            get_commits_between_commits(repo.path(), "HEAD", "HEAD")
                .await
                .expect("rev-list should succeed"),
            Some(Vec::new())
        );
    }
    // --- ahead/behind ---

    #[tokio::test]
    async fn counts_both_sides_of_a_range() {
        // Two commits on the branch, one on main after they diverged.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "base");
        git(
            &["checkout", "-q", "-b", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "a.txt", "two\n", "topic one");
        commit_file(&repo.path(), "a.txt", "three\n", "topic two");
        git(
            &["checkout", "-q", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "b.txt", "main\n", "main one");

        let counts = get_ahead_behind(repo.path(), "main...topic")
            .await
            .expect("the query should succeed")
            .expect("both refs exist");

        // The symmetric difference reads left-to-right: `main` has one the other lacks, `topic` has two.
        assert_eq!(counts.ahead, 1);
        assert_eq!(counts.behind, 2);
    }

    #[tokio::test]
    async fn reports_zeroes_for_two_refs_at_the_same_commit() {
        // Distinct from `None`: the question was asked and the answer is "level".
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let counts = get_ahead_behind(repo.path(), "HEAD...HEAD")
            .await
            .expect("the query should succeed")
            .expect("HEAD exists");

        assert_eq!(
            counts,
            AheadBehind {
                ahead: 0,
                behind: 0
            }
        );
    }

    #[tokio::test]
    async fn reports_none_when_a_ref_in_the_range_is_gone() {
        // The case that matters: an upstream branch was deleted, so there is nothing to be ahead *of*. A
        // failure here would turn a missing number in a label into a failed operation.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let counts = get_ahead_behind(repo.path(), "main...origin/gone")
            .await
            .expect("a missing ref is an answer, not an error");

        assert_eq!(counts, None);
    }

    #[tokio::test]
    async fn counts_a_two_dot_range_one_way_only() {
        // `..` asks "what does the right side have that the left does not", so the other count is zero.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        let counts = get_ahead_behind(repo.path(), "HEAD~1..HEAD")
            .await
            .expect("the query should succeed")
            .expect("both refs exist");

        assert_eq!(
            counts,
            AheadBehind {
                ahead: 0,
                behind: 1
            }
        );
    }
}
