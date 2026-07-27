//! Staging files.
//!
//! Ported from `desktop-plus/app/src/lib/git/add.ts`.

use std::ffi::OsStr;
use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Adds a conflicted file to the index.
///
/// Typically done after resolving conflicts, either manually or via
/// `checkout --theirs`/`--ours`.
///
/// The original took the app's `Repository` and `WorkingDirectoryFileChange` models; this takes
/// plain paths, since those models are frontend concerns that shouldn't reach into the git layer.
/// `file` is relative to the repository root, and is passed after `--` so a path that looks like
/// a revision or an option can't be misinterpreted.
pub async fn add_conflicted_file(
    repository: impl AsRef<Path>,
    file: impl AsRef<Path>,
) -> Result<(), GitError> {
    // Built as OsStr rather than String: paths on Unix are arbitrary bytes and need not be UTF-8.
    let args: [&OsStr; 3] = [
        OsStr::new("add"),
        OsStr::new("--"),
        file.as_ref().as_os_str(),
    ];

    git(
        &args,
        repository,
        "addConflictedFile",
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
    async fn stages_a_conflicted_file_after_manual_resolution() {
        let repo = conflicted_repository().await;

        // Precondition: the merge left an unmerged entry in the index.
        let before = unmerged_paths(&repo.path()).await;
        assert!(
            before.contains(&"foo".to_owned()),
            "expected 'foo' to be conflicted, got {before:?}"
        );

        // Resolve it the way a user would, then stage.
        std::fs::write(repo.path().join("foo"), "resolved content\n")
            .expect("failed to write the resolved file");
        add_conflicted_file(repo.path(), "foo")
            .await
            .expect("staging a resolved file should succeed");

        // The original asserted through the app's status parser (`getStatusOrThrow`), which isn't
        // ported yet. Asking git directly is the same behavioural claim — the file is no longer
        // an unmerged index entry — and uses git itself as the oracle rather than another
        // unported module.
        let after = unmerged_paths(&repo.path()).await;
        assert!(
            !after.contains(&"foo".to_owned()),
            "'foo' should no longer be conflicted, got {after:?}"
        );
    }

    #[tokio::test]
    async fn stages_the_resolved_content() {
        let repo = conflicted_repository().await;
        std::fs::write(repo.path().join("foo"), "resolved content\n")
            .expect("failed to write the resolved file");
        add_conflicted_file(repo.path(), "foo")
            .await
            .expect("staging should succeed");

        // What landed in the index should be what we wrote, not a conflict-marked version.
        let staged = git(
            &["show", ":foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the staged blob should be readable")
        .stdout_lossy()
        .into_owned();

        assert_eq!(staged, "resolved content\n");
    }

    #[tokio::test]
    async fn fails_for_a_path_that_does_not_exist() {
        let repo = conflicted_repository().await;
        let error = add_conflicted_file(repo.path(), "no-such-file")
            .await
            .expect_err("adding a missing path should fail");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }
}
