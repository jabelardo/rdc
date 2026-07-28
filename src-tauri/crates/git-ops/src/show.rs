//! Reading blob contents out of the object database.
//!
//! Ported from `desktop-plus/app/src/lib/git/show.ts`.
//!
//! Two entry points, differing only in how much they read: [`get_blob_contents`] takes the whole blob,
//! [`get_partial_blob_contents`] a bounded prefix. The bound is real rather than a slice after the fact —
//! see [`crate::exec::git_capped`].

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, git_capped, GitOptions};
use crate::git_error_kind::GitErrorKind;

/// Reads the full contents of a blob at `commitish`.
///
/// Returns raw bytes: a blob can be anything, and the callers that want text decode it themselves.
///
/// A path that isn't in the given revision is an **error**, not empty output. git exits 128 for both
/// "does not exist in" and "exists on disk, but not in" — verified against real git.
///
/// The original also accepted exit code 1 as success. Nothing observed produces it here, so it looks
/// defensive; it is kept so a git version that does exit 1 behaves as it did before rather than
/// suddenly failing.
pub async fn get_blob_contents(
    repository: impl AsRef<Path>,
    commitish: &str,
    path: &str,
) -> Result<Vec<u8>, GitError> {
    let revision = format!("{commitish}:{path}");

    let output = git(
        &["show", &revision],
        repository,
        "getBlobContents",
        GitOptions::default().with_success_exit_codes([1]),
    )
    .await?;

    Ok(output.stdout)
}

/// Reads at most `length` bytes of a blob at `commitish`.
///
/// `None` means the path exists on disk but not in that revision — a normal answer for a file the user
/// added since, and the reason the caller asks at all.
///
/// The result may be **shorter** than `length` for two different reasons, which the caller does not need
/// to distinguish: the blob was smaller, or the cap cut it off.
///
/// Its consumer is syntax highlighting, which wants enough of a file to tokenize the part being shown and
/// has no use for the rest of a large one. If the question is instead how big the blob *is*,
/// `git cat-file -s <rev>:<path>` answers that without reading it.
///
/// The original had two identical functions here — `getPartialBlobContents` delegating to
/// `getPartialBlobContentsCatchPathNotInRef` with the same arguments — so this is the one of them.
pub async fn get_partial_blob_contents(
    repository: impl AsRef<Path>,
    commitish: &str,
    path: &str,
    length: usize,
) -> Result<Option<Vec<u8>>, GitError> {
    let output = git_capped(
        &["show".to_owned(), format!("{commitish}:{path}")],
        repository,
        "getPartialBlobContentsCatchPathNotInRef",
        GitOptions::default().with_expected_errors([GitErrorKind::PathExistsButNotInRef]),
        length,
    )
    .await?;

    if output.git_error == Some(GitErrorKind::PathExistsButNotInRef) {
        return Ok(None);
    }

    Ok(Some(output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn reads_a_blob_from_a_commit() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");

        let contents = get_blob_contents(repo.path(), "HEAD", "a.txt")
            .await
            .expect("should read the blob");

        assert_eq!(contents, b"hello\n");
    }

    #[tokio::test]
    async fn reads_the_committed_version_not_the_working_tree() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "committed\n", "first");
        std::fs::write(repo.path().join("a.txt"), "scribbled\n").expect("failed to write");

        let contents = get_blob_contents(repo.path(), "HEAD", "a.txt")
            .await
            .expect("should read the blob");

        assert_eq!(contents, b"committed\n");
    }

    #[tokio::test]
    async fn reads_a_blob_from_an_older_commit() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        let contents = get_blob_contents(repo.path(), "HEAD~1", "a.txt")
            .await
            .expect("should read the blob");

        assert_eq!(contents, b"one\n");
    }

    #[tokio::test]
    async fn reads_bytes_that_are_not_valid_utf8() {
        // Why this returns `Vec<u8>` rather than `String`: a blob is arbitrary bytes, and decoding
        // here would corrupt binary files.
        let repo = empty_repository().await;
        let bytes = [0x00_u8, 0xff, 0xfe, 0x80, b'\n'];
        std::fs::write(repo.path().join("binary"), bytes).expect("failed to write");
        crate::exec::git(
            &["add", "--", "binary"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        crate::exec::git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("binary\n"),
        )
        .await
        .expect("commit should succeed");

        let contents = get_blob_contents(repo.path(), "HEAD", "binary")
            .await
            .expect("should read the blob");

        assert_eq!(contents, bytes);
    }

    #[tokio::test]
    async fn fails_for_a_path_not_in_the_revision() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");

        let error = get_blob_contents(repo.path(), "HEAD", "missing.txt")
            .await
            .expect_err("a missing path should fail");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { exit_code: 128, .. }),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn fails_for_a_path_that_exists_on_disk_but_not_in_the_revision() {
        // git distinguishes this case in its message but uses the same exit code, so it is an error
        // here too rather than empty output.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");
        std::fs::write(repo.path().join("untracked.txt"), "x\n").expect("failed to write");

        let error = get_blob_contents(repo.path(), "HEAD", "untracked.txt")
            .await
            .expect_err("a path outside the revision should fail");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { exit_code: 128, .. }),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn fails_for_a_revision_that_does_not_resolve() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");

        assert!(get_blob_contents(repo.path(), "nosuchref", "a.txt")
            .await
            .is_err());
    }
    // --- partial reads ---

    #[tokio::test]
    async fn reads_a_prefix_of_a_blob() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "big.txt", &"x".repeat(4096), "first");

        let contents = get_partial_blob_contents(repo.path(), "HEAD", "big.txt", 64)
            .await
            .expect("reading should succeed")
            .expect("the path is in the revision");

        assert_eq!(contents.len(), 64);
        assert!(contents.iter().all(|byte| *byte == b'x'));
    }

    #[tokio::test]
    async fn reads_the_whole_blob_when_it_is_smaller_than_the_limit() {
        // The caller can't tell a short blob from a truncated one, and shouldn't have to.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "small.txt", "hello", "first");

        let contents = get_partial_blob_contents(repo.path(), "HEAD", "small.txt", 4096)
            .await
            .expect("reading should succeed")
            .expect("the path is in the revision");

        assert_eq!(contents, b"hello");
    }

    #[tokio::test]
    async fn reads_a_prefix_of_binary_content() {
        // Bytes, not text: the consumer is syntax highlighting, and a prefix can end mid-character.
        let repo = empty_repository().await;
        let path = repo.path().join("blob.bin");
        std::fs::write(&path, [0_u8, 159, 146, 150, 1, 2, 3]).expect("failed to write");
        git(
            &["add", "--", "blob.bin"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        git(
            &["commit", "-m", "binary"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("commit should succeed");

        let contents = get_partial_blob_contents(repo.path(), "HEAD", "blob.bin", 4)
            .await
            .expect("reading should succeed")
            .expect("the path is in the revision");

        assert_eq!(contents, vec![0, 159, 146, 150]);
    }

    #[tokio::test]
    async fn reports_a_path_that_exists_but_is_not_in_the_revision_as_none() {
        // The reason the caller asks: a file added since the revision it is looking at.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "one\n", "first");
        std::fs::write(repo.path().join("added-since.txt"), "two\n").expect("failed to write");

        let contents = get_partial_blob_contents(repo.path(), "HEAD", "added-since.txt", 1024)
            .await
            .expect("this is a normal answer, not an error");

        assert_eq!(contents, None);
    }

    #[tokio::test]
    async fn a_path_in_no_revision_at_all_is_an_error() {
        // The contrast with the case above: nothing knows about this path, so there is nothing to report.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "one\n", "first");

        assert!(
            get_partial_blob_contents(repo.path(), "HEAD", "never-existed.txt", 1024)
                .await
                .is_err()
        );
    }
}
