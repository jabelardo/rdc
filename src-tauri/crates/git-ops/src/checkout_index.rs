//! Restoring working-tree paths directly from the index.
//!
//! Ported from `desktop-plus/app/src/lib/git/checkout-index.ts`.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

pub async fn checkout_index(
    repository: impl AsRef<Path>,
    paths: &[String],
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }

    let stdin = paths.join("\0");
    git(
        &["checkout-index", "-f", "-u", "-q", "--stdin", "-z"],
        repository,
        "checkoutIndex",
        GitOptions::default()
            .with_success_exit_codes([1])
            .with_stdin(stdin),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn an_empty_path_list_is_a_noop_even_outside_a_repository() {
        let directory = tempfile::tempdir().unwrap();
        checkout_index(directory.path(), &[]).await.unwrap();
    }

    #[tokio::test]
    async fn restores_only_the_requested_paths_from_the_index() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "one.txt", "one\n", "base");
        commit_file(&repo.path(), "two.txt", "two\n", "second");
        std::fs::write(repo.path().join("one.txt"), "changed one\n").unwrap();
        std::fs::write(repo.path().join("two.txt"), "changed two\n").unwrap();

        checkout_index(repo.path(), &["one.txt".to_owned()])
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.path().join("one.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("two.txt")).unwrap(),
            "changed two\n"
        );
    }

    #[tokio::test]
    async fn accepts_a_path_containing_a_newline_and_ignores_a_missing_path() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "line\nbreak.txt", "before\n", "base");
        std::fs::write(repo.path().join("line\nbreak.txt"), "after\n").unwrap();

        checkout_index(
            repo.path(),
            &["missing.txt".to_owned(), "line\nbreak.txt".to_owned()],
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.path().join("line\nbreak.txt")).unwrap(),
            "before\n"
        );
    }
}
