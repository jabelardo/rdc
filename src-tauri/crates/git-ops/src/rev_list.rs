//! Commit ranges from `git rev-list`.
//!
//! This is the subset of `desktop-plus/app/src/lib/git/rev-list.ts` needed by rebase progress.
//! Ahead/behind and merge-commit queries land with their own consumers.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_error_kind::GitErrorKind;

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
}
