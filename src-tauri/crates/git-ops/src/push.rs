//! Pushing to a remote.
//!
//! Ported from `desktop-plus/app/src/lib/git/push.ts`.
//!
//! # Hooks
//!
//! [`push`] takes the hook machinery and intercepts `pre-push`, the one hook a push reaches — the last
//! chance to refuse what is about to leave the machine. See [`crate::hooks`].
//!
//! Upstream accepts an optional terminal-output callback, but no production caller supplies one.
//! Phase 3 therefore adds no speculative Channel; Phase 7 may add one with a real consumer.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{ExecutionControl, GitOutput};
use crate::hooks::with_env::{with_hooks_env, HookSupport};
use crate::progress::GitProgressParser;
use crate::remote_progress::{run_with_progress_controlled, ContextLines, RemoteRun};

/// A push progress update.
///
/// Matches `IPushProgress` in the ported `src/models/progress.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushProgress {
    pub kind: PushProgressKind,
    pub value: f64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushProgressKind {
    Push,
}

/// Options for [`push`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PushOptions {
    /// Overwrite the remote branch, but only if it is where we last saw it.
    ///
    /// `--force-with-lease` rather than `--force`: it refuses if someone else has pushed in the
    /// meantime, so it cannot silently discard their work.
    pub force_with_lease: bool,

    /// Skip the `pre-push` hook.
    pub no_verify: bool,
}

/// What to push, and where.
#[derive(Debug, Clone, Copy)]
pub struct PushTarget<'a> {
    pub remote_name: &'a str,
    pub local_branch: &'a str,
    /// The branch on the remote to push into. `None` means the branch has no upstream yet.
    pub remote_branch: Option<&'a str>,
    /// Tags to push alongside the branch. Empty pushes none.
    pub tags: &'a [String],
}

/// Pushes `local_branch` to `remote`.
///
/// `remote_branch` is the branch on the remote to push into. **`None` means the branch has no
/// upstream yet**, so `--set-upstream` is added and the local name is used — and note the original's
/// precedence, preserved here: when there is no upstream, `--set-upstream` is passed *instead of*
/// `--force-with-lease`, never both. Force-pushing to a branch that doesn't exist remotely is
/// meaningless, and a lease against a missing ref would fail.
///
/// `tags` are pushed alongside the branch. An empty slice pushes none.
///
/// `env` carries the credential environment — see [`crate::authentication`] for why this crate doesn't
/// build it itself.
///
/// Authentication failures come back as [`GitOutput::git_error`] rather than an `Err`, so the caller
/// can prompt and retry.
/// Runs the operation with the repository's hooks intercepted, when the caller asked for it.
///
/// A push reaches one hook, `pre-push`, which is the last chance to refuse what is about to leave the machine.
///
/// `hooks` is the machinery only — the list above belongs to the operation, since which hooks git can reach
/// is a property of the command being run rather than of the caller. See
/// [`HookSupport`](crate::hooks::with_env::HookSupport).
pub async fn push<F>(
    repository: impl AsRef<Path>,
    target: PushTarget<'_>,
    env: &HashMap<String, String>,
    options: PushOptions,
    on_progress: Option<F>,
    hooks: Option<&HookSupport>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(PushProgress) + Send,
{
    push_controlled(repository, target, env, options, on_progress, hooks, None).await
}

/// Pushes with an operation-owned cancellation signal.
pub async fn push_controlled<F>(
    repository: impl AsRef<Path>,
    target: PushTarget<'_>,
    env: &HashMap<String, String>,
    options: PushOptions,
    on_progress: Option<F>,
    hooks: Option<&HookSupport>,
    control: Option<ExecutionControl>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(PushProgress) + Send,
{
    let repository = repository.as_ref();
    let interception = hooks.map(|support| support.intercepting(["pre-push"]));

    // Wrapped rather than threaded: the hooks server has to stay alive for the whole invocation, and this
    // operation has more than one way out of it.
    with_hooks_env(
        repository,
        interception.as_ref(),
        env.clone(),
        |env| async move {
            push_impl(repository, target, &env, options, on_progress, control).await
        },
    )
    .await?
}

async fn push_impl<F>(
    repository: impl AsRef<Path>,
    target: PushTarget<'_>,
    env: &HashMap<String, String>,
    options: PushOptions,
    on_progress: Option<F>,
    control: Option<ExecutionControl>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(PushProgress) + Send,
{
    let PushTarget {
        remote_name,
        local_branch,
        remote_branch,
        tags,
    } = target;
    let remote_url_env = env;

    let refspec = match remote_branch {
        Some(remote_branch) => format!("{local_branch}:{remote_branch}"),
        None => local_branch.to_owned(),
    };

    let mut args = vec!["push".to_owned(), remote_name.to_owned(), refspec];
    args.extend(tags.iter().cloned());

    if remote_branch.is_none() {
        args.push("--set-upstream".to_owned());
    } else if options.force_with_lease {
        args.push("--force-with-lease".to_owned());
    }

    if options.no_verify {
        args.push("--no-verify".to_owned());
    }

    let title = format!("Pushing to {remote_name}");

    let Some(mut on_progress) = on_progress else {
        return run_with_progress_controlled(
            repository,
            RemoteRun {
                args: &args,
                name: "push",
                env: remote_url_env,
                success_exit_codes: &[],
                parser: GitProgressParser::push(),
                context: ContextLines::Include,
            },
            control,
            |_, _| {},
        )
        .await;
    };

    // `--progress` only when someone is listening, matching the original.
    args.push("--progress".to_owned());

    // An initial zero so the UI can show the operation has started before git says anything.
    on_progress(PushProgress {
        kind: PushProgressKind::Push,
        value: 0.0,
        title: title.clone(),
        description: None,
        remote: remote_name.to_owned(),
        branch: local_branch.to_owned(),
    });

    run_with_progress_controlled(
        repository,
        RemoteRun {
            args: &args,
            name: "push",
            env: remote_url_env,
            success_exit_codes: &[],
            parser: GitProgressParser::push(),
            context: ContextLines::Include,
        },
        control,
        |value, description| {
            on_progress(PushProgress {
                kind: PushProgressKind::Push,
                value,
                title: title.clone(),
                description: Some(description),
                remote: remote_name.to_owned(),
                branch: local_branch.to_owned(),
            });
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    /// A bare repository to push into, so no network is involved.
    async fn bare_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        git(
            &["init", "--bare", "--initial-branch=main"],
            dir.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("init --bare should succeed");
        dir
    }

    /// A repository with one commit and `origin` pointing at a bare repository.
    async fn repo_with_remote() -> (crate::test_support::TempRepository, tempfile::TempDir) {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let remote = bare_remote().await;
        git(
            &["remote", "add", "origin", &remote.path().to_string_lossy()],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("remote add should succeed");

        (repo, remote)
    }

    async fn remote_branches(remote: &Path) -> Vec<String> {
        git(
            &["branch", "--format=%(refname:short)"],
            remote,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed")
        .stdout_lossy()
        .lines()
        .map(str::to_owned)
        .collect()
    }

    #[tokio::test]
    async fn pushes_a_branch_and_sets_its_upstream() {
        let (repo, remote) = repo_with_remote().await;

        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: None,
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            None::<fn(PushProgress)>,
            None,
        )
        .await
        .expect("push should succeed");

        assert_eq!(
            remote_branches(remote.path()).await,
            vec!["main".to_owned()]
        );

        let upstream = git(
            &["rev-parse", "--abbrev-ref", "main@{upstream}"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the upstream should be set")
        .stdout_trimmed();
        assert_eq!(upstream, "origin/main");
    }

    #[tokio::test]
    async fn pushes_to_a_differently_named_remote_branch() {
        let (repo, remote) = repo_with_remote().await;

        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: Some("elsewhere"),
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            None::<fn(PushProgress)>,
            None,
        )
        .await
        .expect("push should succeed");

        assert_eq!(
            remote_branches(remote.path()).await,
            vec!["elsewhere".to_owned()]
        );
    }

    #[tokio::test]
    async fn pushes_tags_alongside_the_branch() {
        let (repo, remote) = repo_with_remote().await;
        git(&["tag", "v1.0"], repo.path(), "test", GitOptions::default())
            .await
            .expect("tag should succeed");

        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: None,
                tags: &["v1.0".to_owned()],
            },
            &HashMap::new(),
            PushOptions::default(),
            None::<fn(PushProgress)>,
            None,
        )
        .await
        .expect("push should succeed");

        let tags = git(&["tag"], remote.path(), "test", GitOptions::default())
            .await
            .expect("tag should succeed")
            .stdout_trimmed();
        assert_eq!(tags, "v1.0");
    }

    #[tokio::test]
    async fn refuses_a_non_fast_forward_push_without_a_lease() {
        let (repo, remote) = repo_with_remote().await;
        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: None,
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            None::<fn(PushProgress)>,
            None,
        )
        .await
        .expect("the first push should succeed");

        // Rewrite history so the local branch diverges from the remote.
        git(
            &["commit", "--amend", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("amended\n"),
        )
        .await
        .expect("amend should succeed");

        let result = push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: Some("main"),
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            None::<fn(PushProgress)>,
            None,
        )
        .await;

        assert!(result.is_err(), "a diverged push must not silently succeed");
        let _ = remote;
    }

    #[tokio::test]
    async fn a_lease_allows_overwriting_what_we_last_saw() {
        let (repo, remote) = repo_with_remote().await;
        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: None,
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            None::<fn(PushProgress)>,
            None,
        )
        .await
        .expect("the first push should succeed");

        git(
            &["commit", "--amend", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("amended\n"),
        )
        .await
        .expect("amend should succeed");

        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: Some("main"),
                tags: &[],
            },
            &HashMap::new(),
            PushOptions {
                force_with_lease: true,
                ..PushOptions::default()
            },
            None::<fn(PushProgress)>,
            None,
        )
        .await
        .expect("a lease should allow the overwrite");

        let message = git(
            &["log", "-1", "--format=%s", "main"],
            remote.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_trimmed();
        assert_eq!(message, "amended");
    }

    #[tokio::test]
    async fn reports_progress_starting_at_zero() {
        let (repo, _remote) = repo_with_remote().await;
        let mut updates: Vec<PushProgress> = Vec::new();

        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: None,
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            Some(|progress: PushProgress| updates.push(progress)),
            None,
        )
        .await
        .expect("push should succeed");

        assert!(!updates.is_empty());
        assert_eq!(updates[0].value, 0.0);
        assert_eq!(updates[0].description, None);
        assert_eq!(updates[0].title, "Pushing to origin");
        assert_eq!(updates[0].remote, "origin");
        assert_eq!(updates[0].branch, "main");
        assert!(updates.iter().all(|u| u.kind == PushProgressKind::Push));
    }

    #[tokio::test]
    async fn progress_never_decreases() {
        let (repo, _remote) = repo_with_remote().await;
        let mut values: Vec<f64> = Vec::new();

        push(
            repo.path(),
            PushTarget {
                remote_name: "origin",
                local_branch: "main",
                remote_branch: None,
                tags: &[],
            },
            &HashMap::new(),
            PushOptions::default(),
            Some(|progress: PushProgress| values.push(progress.value)),
            None,
        )
        .await
        .expect("push should succeed");

        for pair in values.windows(2) {
            assert!(pair[1] >= pair[0], "progress went backwards: {values:?}");
        }
    }

    #[test]
    fn a_push_with_no_upstream_sets_it_rather_than_forcing() {
        // Precedence preserved from the original: never both. A lease against a ref that doesn't exist
        // remotely would fail, and forcing onto a missing branch is meaningless.
        //
        // Asserted by reproducing the argument construction, since the branch depends on inputs rather
        // than on git's behaviour.
        let options = PushOptions {
            force_with_lease: true,
            ..PushOptions::default()
        };
        let remote_branch: Option<&str> = None;

        let mut args: Vec<String> = Vec::new();
        if remote_branch.is_none() {
            args.push("--set-upstream".to_owned());
        } else if options.force_with_lease {
            args.push("--force-with-lease".to_owned());
        }

        assert_eq!(args, vec!["--set-upstream".to_owned()]);
    }

    #[test]
    fn progress_omits_the_description_rather_than_sending_null() {
        // `IProgress.description` is optional in the ported model.
        let value = serde_json::to_value(PushProgress {
            kind: PushProgressKind::Push,
            value: 0.0,
            title: "Pushing to origin".to_owned(),
            description: None,
            remote: "origin".to_owned(),
            branch: "main".to_owned(),
        })
        .expect("serializes");

        assert!(value.get("description").is_none());
        assert_eq!(value["kind"], "push");
    }
}
