//! Creating repositories.
//!
//! Ported from `desktop-plus/app/src/lib/git/init.ts`.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Initializes a new git repository at `path`.
///
/// `default_branch` is the branch name the new repository starts on.
///
/// # Why this is a parameter
///
/// The original `initGitRepository(path)` took no branch, calling
/// `getDefaultBranch()` internally — which reads the user's **global**
/// `init.defaultBranch` git config and falls back to the app's own preference (`"main"`). That
/// fallback is application policy, not a git primitive, and reaching for ambient user
/// configuration from inside a low-level git call makes the function untestable and its result
/// dependent on the developer's machine.
///
/// So resolution is the caller's job. The global-config lookup and `"main"` fallback will land
/// with `config.rs` (`getGlobalConfigValue`) and be wired up above this layer.
pub async fn init_repository(path: impl AsRef<Path>, default_branch: &str) -> Result<(), GitError> {
    // Passing the branch via `-c init.defaultBranch=` rather than `init -b` mirrors the
    // original; both require git >= 2.28 and behave identically here.
    git(
        &[
            "-c".to_owned(),
            format!("init.defaultBranch={default_branch}"),
            "init".to_owned(),
        ],
        path,
        "initGitRepository",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::git;

    async fn symbolic_head(path: &Path) -> String {
        git(
            &["symbolic-ref", "--short", "HEAD"],
            path,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("symbolic-ref should resolve HEAD, even unborn")
        .stdout_trimmed()
    }

    #[tokio::test]
    async fn creates_a_new_git_repository() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        init_repository(dir.path(), "main")
            .await
            .expect("init should succeed in an empty directory");

        assert!(dir.path().join(".git").is_dir(), ".git should exist");

        let output = git(
            &["rev-parse", "--is-inside-work-tree"],
            dir.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the new directory should be a working tree");
        assert_eq!(output.stdout_trimmed(), "true");
    }

    #[tokio::test]
    async fn starts_on_the_requested_default_branch() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        init_repository(dir.path(), "main")
            .await
            .expect("init should succeed");

        assert_eq!(symbolic_head(dir.path()).await, "main");
    }

    #[tokio::test]
    async fn honours_a_branch_name_that_is_nobody_else_s_default() {
        // Two things at once: that the argument isn't ignored, and that the result doesn't depend
        // on the developer's or CI machine's global `init.defaultBranch`. The name is chosen so
        // that no ambient configuration could produce it by coincidence.
        //
        // The original's test couldn't catch either, because it compared the result against the
        // same `getDefaultBranch()` that the code under test called.
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        init_repository(dir.path(), "not-a-default-anywhere")
            .await
            .expect("init should succeed");

        assert_eq!(symbolic_head(dir.path()).await, "not-a-default-anywhere");
    }
}
