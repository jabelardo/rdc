//! Removing files from the index.
//!
//! Ported from `desktop-plus/app/src/lib/git/rm.ts`.

use std::ffi::OsStr;
use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Removes a conflicted file, recording the deletion in the index.
///
/// Used when resolving a conflict in favour of a side that deleted the file: staging "the file is
/// gone" is what tells git the conflict is settled.
///
/// As in [`crate::add::add_conflicted_file`], the path is passed after `--` and kept as an `OsStr`
/// rather than a `String`, because a Unix path is arbitrary bytes and need not be UTF-8.
/// Empties the index, leaving the working tree alone.
///
/// Distinct from [`crate::reset::unstage_all`] despite the similar name, and upstream keeps them in different
/// files for that reason: this is `rm --cached`, which removes *every* path from the index — including ones
/// that only exist there — while a reset restores the index to a commit. The store uses this before an
/// operation that needs a genuinely empty index.
///
/// The three flags are all load bearing, and the original spelled out why:
///
/// - `--cached` touches the index only, so nothing is deleted from disk.
/// - `-r` recurses, since paths live in directories.
/// - `-f` ignores a difference between the working tree and the index, which would otherwise block the
///   removal — and that difference is exactly the state this is called in.
pub async fn unstage_all_files(repository: impl AsRef<Path>) -> Result<(), GitError> {
    let args: [&OsStr; 5] = [
        OsStr::new("rm"),
        OsStr::new("--cached"),
        OsStr::new("-r"),
        OsStr::new("-f"),
        OsStr::new("."),
    ];

    git(&args, repository, "unstageAllFiles", GitOptions::default()).await?;

    Ok(())
}

pub async fn remove_conflicted_file(
    repository: impl AsRef<Path>,
    file: impl AsRef<Path>,
) -> Result<(), GitError> {
    let args: [&OsStr; 3] = [
        OsStr::new("rm"),
        OsStr::new("--"),
        file.as_ref().as_os_str(),
    ];

    git(
        &args,
        repository,
        "removeConflictedFile",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        commit_file, conflicted_repository, empty_repository, unmerged_paths,
    };

    #[tokio::test]
    async fn resolves_a_conflict_by_removing_the_file() {
        let repo = conflicted_repository().await;

        let before = unmerged_paths(&repo.path()).await;
        assert!(
            before.contains(&"foo".to_owned()),
            "expected 'foo' to be conflicted, got {before:?}"
        );

        remove_conflicted_file(repo.path(), "foo")
            .await
            .expect("removing a conflicted file should succeed");

        let after = unmerged_paths(&repo.path()).await;
        assert!(
            !after.contains(&"foo".to_owned()),
            "'foo' should no longer be conflicted, got {after:?}"
        );
        assert!(
            !repo.path().join("foo").exists(),
            "git rm deletes the working-tree file too"
        );
    }

    #[tokio::test]
    async fn fails_for_a_path_that_does_not_exist() {
        let repo = conflicted_repository().await;
        let error = remove_conflicted_file(repo.path(), "no-such-file")
            .await
            .expect_err("removing a missing path should fail");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }
    #[tokio::test]
    async fn empties_the_index_without_touching_the_working_tree() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "one\n", "first");
        std::fs::write(repo.path().join("added.txt"), "two\n").expect("failed to write");
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");

        unstage_all_files(repo.path())
            .await
            .expect("it should succeed");

        let listed = git(&["ls-files"], repo.path(), "test", GitOptions::default())
            .await
            .expect("ls-files should succeed");
        assert!(
            listed.stdout_lossy().trim().is_empty(),
            "the index is empty: {:?}",
            listed.stdout_lossy()
        );

        // And nothing left the disk, which `--cached` is what guarantees.
        assert!(repo.path().join("tracked.txt").is_file());
        assert!(repo.path().join("added.txt").is_file());
    }

    #[tokio::test]
    async fn empties_the_index_even_when_the_working_tree_differs() {
        // What `-f` is for: a file modified since it was staged would otherwise block the removal, and that
        // is exactly the state this gets called in.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");

        unstage_all_files(repo.path())
            .await
            .expect("a differing working tree must not block it");

        assert!(repo.path().join("a.txt").is_file());
    }

    #[tokio::test]
    async fn empties_the_index_of_a_nested_path() {
        // What `-r` is for.
        let repo = empty_repository().await;
        std::fs::create_dir_all(repo.path().join("deep/dir")).expect("failed to create");
        std::fs::write(repo.path().join("deep/dir/a.txt"), "one\n").expect("failed to write");
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");

        unstage_all_files(repo.path())
            .await
            .expect("it should succeed");

        let listed = git(&["ls-files"], repo.path(), "test", GitOptions::default())
            .await
            .expect("ls-files should succeed");
        assert!(listed.stdout_lossy().trim().is_empty());
    }
}
