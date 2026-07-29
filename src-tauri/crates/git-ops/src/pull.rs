//! Pulling from a remote.
//!
//! Ported from `desktop-plus/app/src/lib/git/pull.ts`.
//!
//! # Hooks
//!
//! [`pull`] takes the hook machinery. A pull merges *or* rebases depending on configuration, so rather than
//! reading `pull.rebase` and friends it intercepts every hook either path can reach — upstream's reasoning,
//! and its list. See [`crate::hooks`].
//!
//! Upstream declares a terminal-output callback but does not pass it into Git execution, so it is a
//! no-op there. Phase 3 preserves that behavior; Phase 7 may add transport if it introduces a consumer.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::get_config_value;
use crate::error::GitError;
use crate::exec::GitOutput;
use crate::hooks::with_env::{with_hooks_env, HookSupport};
use crate::progress::GitProgressParser;
use crate::remote_progress::{run_with_progress, ContextLines, RemoteRun};

/// A pull progress update.
///
/// Matches `IPullProgress` in the ported `src/models/progress.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub kind: PullProgressKind,
    pub value: f64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub remote: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullProgressKind {
    Pull,
}

/// The arguments that decide what happens when the branches have diverged.
///
/// git refuses to pull a diverged branch unless told how to reconcile, so the app supplies `--ff`
/// (fast-forward if possible, otherwise merge) as a default. **Only when the user hasn't configured
/// `pull.ff` themselves** — overriding a deliberate setting would be worse than the error.
///
/// A failure reading the config yields no arguments, matching the original: git will then produce its
/// own message about needing a reconciliation strategy, which is more useful than rdc silently
/// choosing one on the back of a failed lookup.
async fn default_divergent_branch_arguments(repository: &Path) -> Vec<String> {
    match get_config_value(repository, "pull.ff", false).await {
        Ok(None) => vec!["--ff".to_owned()],
        Ok(Some(_)) | Err(_) => Vec::new(),
    }
}

/// Pulls from `remote_name`.
///
/// `rebase.backend=merge` is pinned for the same reason as in [`crate::rebase`]: a pull may rebase, and
/// the state files the rest of the app reads are the merge backend's. Relying on a user's
/// `rebase.backend=apply` would silently produce a different layout.
///
/// Authentication failures come back as [`GitOutput::git_error`] rather than an `Err`.
/// Runs the operation with the repository's hooks intercepted, when the caller asked for it.
///
/// A pull may merge *or* rebase depending on configuration, so rather than reading `pull.rebase` and friends
/// it intercepts every hook either path can reach — upstream's reasoning, and its list.
///
/// `hooks` is the machinery only — the list above belongs to the operation, since which hooks git can reach
/// is a property of the command being run rather than of the caller. See
/// [`HookSupport`](crate::hooks::with_env::HookSupport).
pub async fn pull<F>(
    repository: impl AsRef<Path>,
    remote_name: &str,
    env: &HashMap<String, String>,
    no_verify: bool,
    on_progress: Option<F>,
    hooks: Option<&HookSupport>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(PullProgress) + Send,
{
    let repository = repository.as_ref();
    let interception = hooks.map(|support| {
        support.intercepting([
            "pre-merge-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-merge",
            "pre-rebase",
            "pre-commit",
            "post-rewrite",
        ])
    });

    // Wrapped rather than threaded: the hooks server has to stay alive for the whole invocation, and this
    // operation has more than one way out of it.
    with_hooks_env(
        repository,
        interception.as_ref(),
        env.clone(),
        |env| async move { pull_impl(repository, remote_name, &env, no_verify, on_progress).await },
    )
    .await?
}

async fn pull_impl<F>(
    repository: impl AsRef<Path>,
    remote_name: &str,
    env: &HashMap<String, String>,
    no_verify: bool,
    on_progress: Option<F>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(PullProgress) + Send,
{
    let repository = repository.as_ref();

    let mut args = vec![
        "-c".to_owned(),
        "rebase.backend=merge".to_owned(),
        "pull".to_owned(),
    ];
    args.extend(default_divergent_branch_arguments(repository).await);
    args.push("--recurse-submodules".to_owned());

    let title = format!("Pulling {remote_name}");

    let Some(mut on_progress) = on_progress else {
        if no_verify {
            args.push("--no-verify".to_owned());
        }
        args.push(remote_name.to_owned());

        return run_with_progress(
            repository,
            RemoteRun {
                args: &args,
                name: "pull",
                env,
                success_exit_codes: &[],
                parser: GitProgressParser::pull(),
                context: ContextLines::OnlyCountingObjects,
            },
            |_, _| {},
        )
        .await;
    };

    args.push("--progress".to_owned());
    if no_verify {
        args.push("--no-verify".to_owned());
    }
    args.push(remote_name.to_owned());

    on_progress(PullProgress {
        kind: PullProgressKind::Pull,
        value: 0.0,
        title: title.clone(),
        description: None,
        remote: remote_name.to_owned(),
    });

    run_with_progress(
        repository,
        RemoteRun {
            args: &args,
            name: "pull",
            env,
            success_exit_codes: &[],
            parser: GitProgressParser::pull(),
            context: ContextLines::OnlyCountingObjects,
        },
        |value, description| {
            on_progress(PullProgress {
                kind: PullProgressKind::Pull,
                value,
                title: title.clone(),
                description: Some(description),
                remote: remote_name.to_owned(),
            });
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::set_config_value;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    /// An upstream repository and a clone tracking its `main`.
    async fn upstream_and_tracking_clone() -> (TempRepository, TempRepository) {
        let upstream = empty_repository().await;
        commit_file(&upstream.path(), "a.txt", "one\n", "first");

        let clone = empty_repository().await;
        git(
            &[
                "remote",
                "add",
                "origin",
                &upstream.path().to_string_lossy(),
            ],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("remote add should succeed");
        git(
            &["fetch", "origin"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("fetch should succeed");
        git(
            &["checkout", "-B", "main", "origin/main", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        git(
            &["branch", "--set-upstream-to=origin/main", "main"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("set-upstream should succeed");

        (upstream, clone)
    }

    #[tokio::test]
    async fn pulls_new_commits_into_the_working_tree() {
        let (upstream, clone) = upstream_and_tracking_clone().await;
        commit_file(&upstream.path(), "a.txt", "two\n", "second");

        pull(
            clone.path(),
            "origin",
            &HashMap::new(),
            false,
            None::<fn(PullProgress)>,
            None,
        )
        .await
        .expect("pull should succeed");

        let contents =
            std::fs::read_to_string(clone.path().join("a.txt")).expect("failed to read back");
        assert_eq!(contents, "two\n");
    }

    #[tokio::test]
    async fn pulling_with_nothing_to_do_succeeds() {
        let (_upstream, clone) = upstream_and_tracking_clone().await;

        pull(
            clone.path(),
            "origin",
            &HashMap::new(),
            false,
            None::<fn(PullProgress)>,
            None,
        )
        .await
        .expect("an up-to-date pull should succeed");
    }

    #[tokio::test]
    async fn merges_when_the_branches_have_diverged() {
        // The `--ff` default: fast-forward if possible, otherwise merge, rather than git refusing.
        let (upstream, clone) = upstream_and_tracking_clone().await;
        commit_file(&upstream.path(), "theirs.txt", "theirs\n", "their work");
        commit_file(&clone.path(), "mine.txt", "mine\n", "my work");

        pull(
            clone.path(),
            "origin",
            &HashMap::new(),
            false,
            None::<fn(PullProgress)>,
            None,
        )
        .await
        .expect("a diverged pull should reconcile rather than refuse");

        assert!(clone.path().join("theirs.txt").exists());
        assert!(clone.path().join("mine.txt").exists());

        let parents = git(
            &["rev-list", "--parents", "-n", "1", "HEAD"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-list should succeed")
        .stdout_trimmed();
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "the reconciliation should be a merge, got {parents:?}"
        );
    }

    #[tokio::test]
    async fn reports_progress_starting_at_zero() {
        let (upstream, clone) = upstream_and_tracking_clone().await;
        commit_file(&upstream.path(), "a.txt", "two\n", "second");
        let mut updates: Vec<PullProgress> = Vec::new();

        pull(
            clone.path(),
            "origin",
            &HashMap::new(),
            false,
            Some(|progress: PullProgress| updates.push(progress)),
            None,
        )
        .await
        .expect("pull should succeed");

        assert!(!updates.is_empty());
        assert_eq!(updates[0].value, 0.0);
        assert_eq!(updates[0].title, "Pulling origin");
        assert_eq!(updates[0].remote, "origin");
        assert!(updates.iter().all(|u| u.kind == PullProgressKind::Pull));
    }

    // --- the pull.ff default ---

    #[tokio::test]
    async fn supplies_ff_when_the_user_has_not_configured_it() {
        let repo = empty_repository().await;
        assert_eq!(
            default_divergent_branch_arguments(&repo.path()).await,
            vec!["--ff".to_owned()]
        );
    }

    #[tokio::test]
    async fn respects_a_configured_pull_ff() {
        // Overriding a deliberate setting would be worse than letting git complain.
        let repo = empty_repository().await;
        set_config_value(repo.path(), "pull.ff", "only")
            .await
            .expect("setting the config should succeed");

        assert!(default_divergent_branch_arguments(&repo.path())
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn respects_pull_rebase_being_configured_via_pull_ff_false() {
        let repo = empty_repository().await;
        set_config_value(repo.path(), "pull.ff", "false")
            .await
            .expect("setting the config should succeed");

        assert!(
            default_divergent_branch_arguments(&repo.path())
                .await
                .is_empty(),
            "any configured value counts, not just the ones we'd have chosen"
        );
    }

    #[test]
    fn progress_omits_the_description_rather_than_sending_null() {
        let value = serde_json::to_value(PullProgress {
            kind: PullProgressKind::Pull,
            value: 0.0,
            title: "Pulling origin".to_owned(),
            description: None,
            remote: "origin".to_owned(),
        })
        .expect("serializes");

        assert!(value.get("description").is_none());
        assert_eq!(value["kind"], "pull");
    }
}
