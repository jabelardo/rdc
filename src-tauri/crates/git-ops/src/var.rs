//! Asking git what identity it would use.
//!
//! Ported from `desktop-plus/app/src/lib/git/var.ts`.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::log::CommitIdentity;

/// The author identity a commit made now would carry.
///
/// Different from reading `user.name` and `user.email`: git synthesises an identity from the system
/// user and hostname when those aren't set, and this reports what git would *actually* use.
///
/// `None` means git declined to invent one — `user.useConfigOnly` is set with no name or email
/// configured. Any commit attempted afterwards will fail for the same reason, so a caller seeing `None`
/// should prompt rather than proceed.
pub async fn get_author_identity(
    repository: impl AsRef<Path>,
) -> Result<Option<CommitIdentity>, GitError> {
    let output = git(
        &["var", "GIT_AUTHOR_IDENT"],
        repository,
        "getAuthorIdentity",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    if output.exit_code == 128 {
        return Ok(None);
    }

    // A malformed identity is reported as absent rather than as an error, matching the original's
    // `catch`: the caller's next move is the same either way.
    Ok(CommitIdentity::parse(&output.stdout_lossy()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::empty_repository;

    #[tokio::test]
    async fn reads_the_configured_identity() {
        // `empty_repository` sets a deterministic name and email.
        let repo = empty_repository().await;

        let identity = get_author_identity(repo.path())
            .await
            .expect("should succeed")
            .expect("an identity is configured");

        assert!(!identity.name.is_empty());
        assert!(identity.email.contains('@'));
        assert!(identity.date > 0, "git reports the current time");
    }

    #[tokio::test]
    async fn falls_back_past_the_repository_config() {
        // The reason this exists rather than reading user.name/user.email: with no *local* identity git
        // still produces one, from global config or by synthesising it from the system user. Reading the
        // local config would report nothing here, which is the wrong answer.
        let repo = empty_repository().await;
        for args in [
            ["config", "--unset", "user.name"],
            ["config", "--unset", "user.email"],
        ] {
            git(&args, repo.path(), "test", GitOptions::default())
                .await
                .expect("config should succeed");
        }

        let identity = get_author_identity(repo.path())
            .await
            .expect("should succeed")
            .expect("git still supplies an identity");

        assert!(!identity.name.is_empty());
    }

    // The `None` path — `user.useConfigOnly` set with no name or email *anywhere* — is deliberately not
    // covered. Reaching it needs the global and system config isolated from the machine running the
    // tests, which `get_author_identity` has no way to accept: in the app it runs in the user's real
    // environment, so adding an env parameter purely for a test would be inventing API. Setting
    // `useConfigOnly` locally is not enough, because a global `user.name` still satisfies it — that is
    // what `useConfigOnly` means. Recorded here rather than asserted misleadingly.
}
