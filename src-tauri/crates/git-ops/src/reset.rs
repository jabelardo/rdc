//! Resetting the index.
//!
//! Ported from `desktop-plus/app/src/lib/git/reset.ts` — only `unstageAll` so far, which is what
//! `create_commit` needs. The `reset --hard`/`--soft` entry points come with the operations that
//! use them.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Clears the staging area.
///
/// `create_commit` runs this first so the commit reflects exactly what the user selected, rather
/// than whatever happened to be staged beforehand.
///
/// Note this is `reset -- .`, not a bare `reset`: the pathspec keeps it scoped to the working tree
/// and, more importantly, makes it work in a repository with no commits yet, where `HEAD` doesn't
/// resolve. The original relied on the same trick.
pub async fn unstage_all(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["reset", "--", "."],
        repository,
        "unstageAll",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    /// Paths git currently reports as staged.
    async fn staged_paths(repo: &Path) -> Vec<String> {
        git(
            &["diff", "--cached", "--name-only"],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("diff --cached should succeed")
        .stdout_lossy()
        .lines()
        .map(str::to_owned)
        .collect()
    }

    #[tokio::test]
    async fn clears_the_staging_area() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");

        std::fs::write(repo.path().join("tracked"), "changed\n").expect("failed to write");
        git(
            &["add", "--", "tracked"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        assert_eq!(staged_paths(&repo.path()).await, vec!["tracked".to_owned()]);

        unstage_all(repo.path())
            .await
            .expect("reset should succeed");

        assert!(
            staged_paths(&repo.path()).await.is_empty(),
            "nothing should be staged after a reset"
        );
    }

    #[tokio::test]
    async fn leaves_the_working_tree_alone() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");
        std::fs::write(repo.path().join("tracked"), "changed\n").expect("failed to write");

        unstage_all(repo.path())
            .await
            .expect("reset should succeed");

        let contents =
            std::fs::read_to_string(repo.path().join("tracked")).expect("failed to read back");
        assert_eq!(
            contents, "changed\n",
            "unstaging must not discard the user's edits"
        );
    }

    #[tokio::test]
    async fn succeeds_in_a_repository_with_no_commits() {
        // This is why the pathspec is there: a bare `git reset` needs HEAD to resolve, and in an
        // unborn repository it doesn't. `create_commit` calls this unconditionally, so it has to
        // work before the first commit exists.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("foo"), "foo\n").expect("failed to write");
        git(
            &["add", "--", "foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");

        unstage_all(repo.path())
            .await
            .expect("resetting an unborn repository should succeed");

        assert!(staged_paths(&repo.path()).await.is_empty());
    }
}
