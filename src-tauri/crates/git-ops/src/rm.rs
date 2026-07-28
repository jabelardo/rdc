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
    use crate::test_support::{conflicted_repository, unmerged_paths};

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
}
