//! Low-level ref manipulation.
//!
//! Ported from `desktop-plus/app/src/lib/git/update-ref.ts` (the `deleteRef` half; the
//! `updateRef` counterpart lands when a caller needs it).

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Deletes a ref.
///
/// Deletion is **idempotent**: git exits 0 for a ref that doesn't exist, so this succeeds either
/// way rather than reporting a missing ref as a failure.
///
/// `reason` is passed through as `-m` for parity with the original, but note it has no observable
/// effect on a deletion — git would record it in the ref's own reflog, which is removed along with
/// the ref.
pub async fn delete_ref(
    repository: impl AsRef<Path>,
    ref_name: &str,
    reason: Option<&str>,
) -> Result<(), GitError> {
    let mut args = vec![
        "update-ref".to_owned(),
        "-d".to_owned(),
        ref_name.to_owned(),
    ];
    if let Some(reason) = reason {
        args.push("-m".to_owned());
        args.push(reason.to_owned());
    }

    git(&args, repository, "deleteRef", GitOptions::default()).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    async fn ref_exists(repo: &Path, ref_name: &str) -> bool {
        git(
            &["rev-parse", "--verify", "--quiet", ref_name],
            repo,
            "test",
            GitOptions::default().with_success_exit_codes([1]),
        )
        .await
        .expect("rev-parse --verify should not error")
        .exit_code
            == 0
    }

    #[tokio::test]
    async fn deletes_a_ref() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");
        git(
            &["branch", "doomed"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("creating the branch should succeed");
        assert!(ref_exists(&repo.path(), "refs/heads/doomed").await);

        delete_ref(repo.path(), "refs/heads/doomed", None)
            .await
            .expect("deleting the ref should succeed");

        assert!(!ref_exists(&repo.path(), "refs/heads/doomed").await);
    }

    #[tokio::test]
    async fn accepts_a_reason() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");
        git(
            &["branch", "doomed"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("creating the branch should succeed");

        // The reason can't be asserted on after the fact: git records it in the ref's own reflog,
        // which is removed along with the ref. This checks the flag is accepted and the deletion
        // still happens, which is all that's observable.
        delete_ref(repo.path(), "refs/heads/doomed", Some("because reasons"))
            .await
            .expect("deleting with a reason should succeed");

        assert!(!ref_exists(&repo.path(), "refs/heads/doomed").await);
    }

    #[tokio::test]
    async fn deleting_a_missing_ref_succeeds() {
        // git treats `update-ref -d` on an absent ref as a no-op success, so deletion is
        // idempotent. Worth pinning down: callers can delete without checking existence first.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");

        delete_ref(repo.path(), "refs/heads/never-existed", None)
            .await
            .expect("deleting a ref that does not exist is not an error");
    }
}
