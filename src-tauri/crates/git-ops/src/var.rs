//! Asking git what identity it would use.
//!
//! Ported from `desktop-plus/app/src/lib/git/var.ts`.

use std::path::Path;

#[cfg(test)]
use std::collections::HashMap;

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
    get_author_identity_with_options(repository, GitOptions::default()).await
}

/// [`get_author_identity`] with the environment supplied.
///
/// Exists for tests, following [`crate::rev_parse::get_repository_type_with_env`]: what git answers here
/// depends on the *global* config, so a test that doesn't isolate `HOME` is really asserting something
/// about the machine it runs on. That is how `falls_back_past_the_repository_config` came to pass on macOS
/// — where git can synthesise an email from a hostname carrying a domain — and fail on CI, where it
/// cannot, and where there is no global identity to fall back to either.
#[cfg(test)]
async fn get_author_identity_with_env(
    repository: impl AsRef<Path>,
    env: HashMap<String, String>,
) -> Result<Option<CommitIdentity>, GitError> {
    // These outrank every config layer. This helper exists to make config-dependent tests
    // deterministic, so inheriting any of them would put the machine's identity back in play even
    // after GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM have pinned the config itself. `EMAIL` is git's
    // documented fallback when GIT_AUTHOR_EMAIL is absent.
    let options = GitOptions {
        env,
        ..GitOptions::default()
    }
    .without_env("GIT_AUTHOR_NAME")
    .without_env("GIT_AUTHOR_EMAIL")
    .without_env("GIT_AUTHOR_DATE")
    .without_env("EMAIL");

    get_author_identity_with_options(repository, options).await
}

async fn get_author_identity_with_options(
    repository: impl AsRef<Path>,
    options: GitOptions,
) -> Result<Option<CommitIdentity>, GitError> {
    let output = git(
        &["var", "GIT_AUTHOR_IDENT"],
        repository,
        "getAuthorIdentity",
        options.with_success_exit_codes([128]),
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

    /// An environment where `contents` is the *only* config git reads.
    ///
    /// `GIT_CONFIG_GLOBAL` rather than `HOME`, because it pins the file directly: an ambient
    /// `GIT_CONFIG_GLOBAL` would outrank a stub `HOME` and put the machine's config back in play.
    /// `GIT_CONFIG_NOSYSTEM` closes the other layer, so exactly one file decides the answer.
    ///
    /// `get_author_identity_with_env` also removes the ambient author variables and `EMAIL`, which
    /// outrank config and would otherwise defeat this isolation.
    ///
    /// Returned with its guard: the directory has to outlive the git invocation that reads it.
    fn isolated_config(contents: &str) -> (HashMap<String, String>, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("failed to create a temporary directory");
        let path = directory.path().join("gitconfig");
        std::fs::write(&path, contents).expect("failed to write the stub config");

        let env = HashMap::from([
            (
                "GIT_CONFIG_GLOBAL".to_owned(),
                path.to_string_lossy().into_owned(),
            ),
            ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
        ]);
        (env, directory)
    }

    /// Removes the repository's own identity, leaving nothing local to find.
    async fn unset_local_identity(repo: &Path) {
        for args in [
            ["config", "--unset", "user.name"],
            ["config", "--unset", "user.email"],
        ] {
            git(&args, repo, "test", GitOptions::default())
                .await
                .expect("config should succeed");
        }
    }

    #[tokio::test]
    async fn falls_back_past_the_repository_config() {
        // The reason this asks git rather than reading `user.name`/`user.email`: with no *local* identity
        // git still produces one, and reading the local config would report nothing — the wrong answer.
        //
        // The global config is a stub rather than the machine's. Relying on the ambient one made this pass
        // on macOS, where git can synthesise an email from a hostname that carries a domain, and fail on CI
        // where it cannot and where no global identity exists either.
        let repo = empty_repository().await;
        unset_local_identity(&repo.path()).await;
        let (mut env, _guard) =
            isolated_config("[user]\n\tname = Global Person\n\temail = global@example.invalid\n");
        // Every one of these outranks config. Supplying them explicitly exercises the same
        // `env_remove` path as inheriting them from the test runner.
        env.extend([
            ("GIT_AUTHOR_NAME".to_owned(), "Ambient Person".to_owned()),
            (
                "GIT_AUTHOR_EMAIL".to_owned(),
                "ambient@example.invalid".to_owned(),
            ),
            ("GIT_AUTHOR_DATE".to_owned(), "946684800 +0000".to_owned()),
            ("EMAIL".to_owned(), "fallback@example.invalid".to_owned()),
        ]);

        let identity = get_author_identity_with_env(repo.path(), env)
            .await
            .expect("should succeed")
            .expect("git falls back to the global identity");

        assert_eq!(identity.name, "Global Person");
        assert_eq!(identity.email, "global@example.invalid");
        assert!(identity.date > 0, "git reports the current time");
    }

    #[tokio::test]
    async fn reports_none_when_git_refuses_to_invent_an_identity() {
        // Previously left uncovered, because reaching it needs the global config isolated from the machine
        // — which `get_author_identity_with_env` now allows. `useConfigOnly` is what stops git synthesising
        // one from the system user, and the isolated config is what leaves it nothing to be satisfied *by*.
        // The `None` is meaningful rather than merely absent: a commit will fail the same way, so the
        // caller should prompt.
        let repo = empty_repository().await;
        unset_local_identity(&repo.path()).await;
        git(
            &["config", "user.useConfigOnly", "true"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("config should succeed");

        let (env, _guard) = isolated_config("");

        assert_eq!(
            get_author_identity_with_env(repo.path(), env)
                .await
                .expect("git declining is not an error"),
            None
        );
    }

    // Both halves of `useConfigOnly` are now covered: satisfied by a global identity
    // (`falls_back_past_the_repository_config`) and unsatisfiable
    // (`reports_none_when_git_refuses_to_invent_an_identity`). Neither depends on the machine's own git
    // configuration, which is what made the first of them fail on CI and pass locally.
}
