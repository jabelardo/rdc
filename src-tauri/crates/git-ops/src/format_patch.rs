//! Generating mailbox patches for commit ranges.
//!
//! Ported from `desktop-plus/app/src/lib/git/format-patch.ts`.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

pub async fn format_commit_range_patch(
    repository: impl AsRef<Path>,
    base: &str,
    head: &str,
) -> Result<String, GitError> {
    let range = format!("{base}..{head}");
    let output = git(
        &[
            "format-patch",
            "--unified=1",
            "--minimal",
            "--stdout",
            &range,
        ],
        repository,
        "formatPatch",
        GitOptions::default(),
    )
    .await?;
    Ok(output.stdout_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    async fn three_commit_repository() -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file.txt", "base\n", "Base");
        commit_file(&repo.path(), "file.txt", "second\n", "Second");
        commit_file(&repo.path(), "other.txt", "third\n", "Third");
        repo
    }

    #[tokio::test]
    async fn emits_one_mail_patch_per_commit_in_the_exclusive_range() {
        let repo = three_commit_repository().await;
        let patch = format_commit_range_patch(repo.path(), "HEAD~2", "HEAD")
            .await
            .unwrap();

        assert_eq!(patch.matches("From ").count(), 2);
        assert!(patch.contains("Subject: [PATCH 1/2] Second"));
        assert!(patch.contains("Subject: [PATCH 2/2] Third"));
    }

    #[tokio::test]
    async fn an_empty_range_emits_an_empty_string() {
        let repo = three_commit_repository().await;
        assert_eq!(
            format_commit_range_patch(repo.path(), "HEAD", "HEAD")
                .await
                .unwrap(),
            ""
        );
    }

    #[tokio::test]
    async fn the_generated_patch_applies_cleanly_to_the_base() {
        let repo = three_commit_repository().await;
        let patch = format_commit_range_patch(repo.path(), "HEAD~", "HEAD")
            .await
            .unwrap();
        git(
            &["reset", "--hard", "HEAD~"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .unwrap();

        git(
            &["apply", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin(patch),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.path().join("other.txt")).unwrap(),
            "third\n"
        );
    }
}
