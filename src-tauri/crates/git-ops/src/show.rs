//! Reading blob contents out of the object database.
//!
//! Ported from `desktop-plus/app/src/lib/git/show.ts`.
//!
//! # Deferred: `getPartialBlobContents`
//!
//! The original had a second entry point that read at most N bytes, implemented with Node's
//! `maxBuffer` — which *errors* once the limit is passed, so the caller recovered the partial output
//! from the rejected error's `stdout`. Reproducing that needs a capped-read primitive in
//! [`crate::exec`] that stops reading and kills the child, and killing mid-read has to be done
//! carefully to avoid deadlocking against an undrained stderr pipe.
//!
//! It is deferred rather than approximated because **its only consumer is
//! `ui/diff/syntax-highlighting/index.ts`**, which is Phase 7 work. Nothing in the Rust layer wants
//! it yet, and a bounded-memory-but-unbounded-I/O stand-in would quietly lose the property the
//! original was written for. Recorded in `MIGRATION_MAP.md` §9.
//!
//! When it does land, note `git cat-file -s <rev>:<path>` answers "how big is this blob?" without
//! reading it at all, which is a better guard for the size checks than reading a prefix.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

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
}
