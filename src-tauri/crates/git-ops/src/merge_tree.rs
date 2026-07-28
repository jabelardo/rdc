//! Computing whether two branch tips merge cleanly without touching the worktree.
//!
//! Ported from `desktop-plus/app/src/lib/git/merge-tree.ts`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_error_kind::GitErrorKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MergeTreeResult {
    Clean,
    Conflicts {
        #[serde(rename = "conflictedFiles")]
        conflicted_files: usize,
    },
    Invalid,
}

pub async fn determine_mergeability(
    repository: impl AsRef<Path>,
    ours: &str,
    theirs: &str,
) -> Result<MergeTreeResult, GitError> {
    let output = git(
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "-z",
            ours,
            theirs,
        ],
        repository,
        "determineMergeability",
        GitOptions::default()
            .with_success_exit_codes([1])
            .with_expected_errors([GitErrorKind::CannotMergeUnrelatedHistories]),
    )
    .await?;

    if output.git_error == Some(GitErrorKind::CannotMergeUnrelatedHistories) {
        return Ok(MergeTreeResult::Invalid);
    }

    let conflicted_files = output
        .stdout
        .iter()
        .filter(|byte| **byte == b'\0')
        .count()
        .saturating_sub(1);
    Ok(if conflicted_files == 0 {
        MergeTreeResult::Clean
    } else {
        MergeTreeResult::Conflicts { conflicted_files }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    async fn run(repo: &Path, args: &[&str]) {
        git(args, repo, "test", GitOptions::default())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn reports_a_clean_merge() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "base.txt", "base\n", "base");
        run(&repo.path(), &["branch", "feature"]).await;
        run(&repo.path(), &["checkout", "feature"]).await;
        commit_file(&repo.path(), "feature.txt", "feature\n", "feature");
        run(&repo.path(), &["checkout", "main"]).await;

        assert_eq!(
            determine_mergeability(repo.path(), "main", "feature")
                .await
                .unwrap(),
            MergeTreeResult::Clean
        );
    }

    #[tokio::test]
    async fn counts_conflicted_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "one.txt", "base\n", "base one");
        commit_file(&repo.path(), "two.txt", "base\n", "base two");
        run(&repo.path(), &["branch", "feature"]).await;
        commit_file(&repo.path(), "one.txt", "ours\n", "ours one");
        commit_file(&repo.path(), "two.txt", "ours\n", "ours two");
        run(&repo.path(), &["checkout", "feature"]).await;
        commit_file(&repo.path(), "one.txt", "theirs\n", "theirs one");
        commit_file(&repo.path(), "two.txt", "theirs\n", "theirs two");

        assert_eq!(
            determine_mergeability(repo.path(), "main", "feature")
                .await
                .unwrap(),
            MergeTreeResult::Conflicts {
                conflicted_files: 2
            }
        );
    }

    #[tokio::test]
    async fn unrelated_histories_are_invalid() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "main.txt", "main\n", "main");
        run(&repo.path(), &["checkout", "--orphan", "unrelated"]).await;
        run(&repo.path(), &["rm", "-rf", "."]).await;
        commit_file(&repo.path(), "other.txt", "other\n", "other");

        assert_eq!(
            determine_mergeability(repo.path(), "main", "unrelated")
                .await
                .unwrap(),
            MergeTreeResult::Invalid
        );
    }

    #[test]
    fn conflict_result_matches_the_frontend_wire_shape() {
        assert_eq!(
            serde_json::to_value(MergeTreeResult::Conflicts {
                conflicted_files: 2
            })
            .unwrap(),
            serde_json::json!({"kind": "conflicts", "conflictedFiles": 2})
        );
    }
}
