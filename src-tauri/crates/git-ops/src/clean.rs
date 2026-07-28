//! Removing untracked files.
//!
//! Ported from `desktop-plus/app/src/lib/git/clean.ts`.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Deletes untracked files and directories.
///
/// **Irreversible** — these files are not in git, so nothing can restore them. `-d` includes
/// directories; `--force` is required because git refuses to clean without it.
///
/// Ignored files are *not* removed: that needs `-x`, which the original didn't pass, so a build output
/// directory listed in `.gitignore` survives.
pub async fn clean_untracked_files(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["clean", "-d", "--force"],
        repository,
        "cleanUntrackedFiles",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn removes_untracked_files_and_directories() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "keep\n", "first");
        std::fs::write(repo.path().join("loose.txt"), "go\n").expect("failed to write");
        std::fs::create_dir_all(repo.path().join("nested")).expect("failed to create");
        std::fs::write(repo.path().join("nested/inner.txt"), "go\n").expect("failed to write");

        clean_untracked_files(repo.path())
            .await
            .expect("cleaning should succeed");

        assert!(
            repo.path().join("tracked.txt").exists(),
            "tracked files stay"
        );
        assert!(!repo.path().join("loose.txt").exists());
        assert!(
            !repo.path().join("nested").exists(),
            "-d removes directories"
        );
    }

    #[tokio::test]
    async fn leaves_ignored_files_alone() {
        // `-x` would remove them and the original didn't pass it, so a gitignored build directory
        // survives a clean.
        let repo = empty_repository().await;
        commit_file(&repo.path(), ".gitignore", "ignored.txt\n", "first");
        std::fs::write(repo.path().join("ignored.txt"), "keep\n").expect("failed to write");
        std::fs::write(repo.path().join("loose.txt"), "go\n").expect("failed to write");

        clean_untracked_files(repo.path())
            .await
            .expect("cleaning should succeed");

        assert!(repo.path().join("ignored.txt").exists());
        assert!(!repo.path().join("loose.txt").exists());
    }

    #[tokio::test]
    async fn leaves_a_modified_tracked_file_alone() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "one\n", "first");
        std::fs::write(repo.path().join("tracked.txt"), "changed\n").expect("failed to write");

        clean_untracked_files(repo.path())
            .await
            .expect("cleaning should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("tracked.txt")).expect("failed to read"),
            "changed\n",
            "clean only touches untracked files"
        );
    }
}
