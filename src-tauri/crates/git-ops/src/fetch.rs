//! Fetching from a remote.
//!
//! Ported from `desktop-plus/app/src/lib/git/fetch.ts`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::authentication::AUTHENTICATION_ERRORS;
use crate::error::GitError;
use crate::exec::{git, ExecutionControl, GitOptions, GitOutput};
use crate::progress::GitProgressParser;
use crate::remote_progress::{remote_env, run_with_progress_controlled, ContextLines, RemoteRun};

/// A fetch progress update.
///
/// Matches `IFetchProgress` in the ported `src/models/progress.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProgress {
    pub kind: FetchProgressKind,
    pub value: f64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub remote: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchProgressKind {
    Fetch,
}

/// Fetches from `remote_name`.
///
/// `--prune` removes remote-tracking refs for branches deleted upstream, so the branch list doesn't
/// accumulate ghosts. `--recurse-submodules=on-demand` fetches a submodule only when the superproject
/// now references a commit the submodule doesn't have, which avoids fetching every submodule every
/// time.
///
/// Authentication failures come back as [`GitOutput::git_error`] rather than an `Err`.
pub async fn fetch<F>(
    repository: impl AsRef<Path>,
    remote_name: &str,
    env: &HashMap<String, String>,
    on_progress: Option<F>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(FetchProgress) + Send,
{
    fetch_controlled(repository, remote_name, env, on_progress, None).await
}

/// Fetches with an operation-owned cancellation signal.
///
/// Keeping this as a sibling preserves every existing caller while Slice 10 migrates only the
/// user/background Fetch command whose recovery policy is defined.
pub async fn fetch_controlled<F>(
    repository: impl AsRef<Path>,
    remote_name: &str,
    env: &HashMap<String, String>,
    on_progress: Option<F>,
    control: Option<ExecutionControl>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(FetchProgress) + Send,
{
    let mut args = vec!["fetch".to_owned()];
    let title = format!("Fetching {remote_name}");

    let Some(mut on_progress) = on_progress else {
        args.extend([
            "--prune".to_owned(),
            "--recurse-submodules=on-demand".to_owned(),
            remote_name.to_owned(),
        ]);

        return run_with_progress_controlled(
            repository,
            RemoteRun {
                args: &args,
                name: "fetch",
                env,
                success_exit_codes: &[],
                parser: GitProgressParser::fetch(),
                context: ContextLines::OnlyCountingObjects,
            },
            control,
            |_, _| {},
        )
        .await;
    };

    args.push("--progress".to_owned());
    args.extend([
        "--prune".to_owned(),
        "--recurse-submodules=on-demand".to_owned(),
        remote_name.to_owned(),
    ]);

    on_progress(FetchProgress {
        kind: FetchProgressKind::Fetch,
        value: 0.0,
        title: title.clone(),
        description: None,
        remote: remote_name.to_owned(),
    });

    run_with_progress_controlled(
        repository,
        RemoteRun {
            args: &args,
            name: "fetch",
            env,
            success_exit_codes: &[],
            parser: GitProgressParser::fetch(),
            context: ContextLines::OnlyCountingObjects,
        },
        control,
        |value, description| {
            on_progress(FetchProgress {
                kind: FetchProgressKind::Fetch,
                value,
                title: title.clone(),
                description: Some(description),
                remote: remote_name.to_owned(),
            });
        },
    )
    .await
}

/// Fetches a single refspec.
///
/// Tolerates exit code 128, which the original also did: the refspec may simply not exist on the
/// remote — a pull request ref that has since been deleted, say — and that is not a failure worth
/// surfacing.
pub async fn fetch_refspec(
    repository: impl AsRef<Path>,
    remote_name: &str,
    refspec: &str,
    env: &HashMap<String, String>,
) -> Result<GitOutput, GitError> {
    let mut options = GitOptions::default()
        .with_success_exit_codes([128])
        .with_expected_errors(AUTHENTICATION_ERRORS);

    for (key, value) in remote_env(env) {
        options = options.with_env(key, value);
    }

    git(
        &["fetch", remote_name, refspec],
        repository,
        "fetchRefspec",
        options,
    )
    .await
}

/// Fast-forwards local branches to match their upstreams, without checking them out.
///
/// `branches` is `(upstream_ref, local_ref)` pairs. A no-op when empty.
///
/// Three details, all from the original and all load-bearing:
///
/// - **`fetch .`** — fetching from the repository *itself* is what updates a branch without checking
///   it out.
/// - **`--show-forced-updates`** is passed explicitly so a user's `fetch.showForcedUpdates=false`
///   can't let a branch be updated in a way that isn't a fast-forward.
/// - **`--no-write-fetch-head`** keeps this from clobbering `FETCH_HEAD`, which a real fetch owns.
/// - **Exit code 1 is success**: git reports it when one or more refs couldn't be updated, which is
///   the expected outcome for any branch that has diverged.
///
/// `GIT_REFLOG_ACTION=pull` makes the resulting reflog entries read as a pull rather than a fetch,
/// which is what the user actually did.
pub async fn fast_forward_branches(
    repository: impl AsRef<Path>,
    branches: &[(String, String)],
) -> Result<(), GitError> {
    if branches.is_empty() {
        return Ok(());
    }

    // Ref pairs go over stdin rather than as arguments, because a repository with many branches would
    // otherwise exceed the platform's command-line limit.
    let stdin = branches
        .iter()
        .map(|(upstream, local)| format!("{upstream}:{local}"))
        .collect::<Vec<_>>()
        .join("\n");

    git(
        &[
            "fetch",
            ".",
            "--show-forced-updates",
            "--no-write-fetch-head",
            "--stdin",
        ],
        repository,
        "fastForwardBranches",
        GitOptions::default()
            .with_success_exit_codes([1])
            .with_env("GIT_REFLOG_ACTION", "pull")
            .with_stdin(stdin),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    #[cfg(unix)]
    use std::sync::{Arc, Mutex};
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    use crate::test_support::BlockingSshFetch;

    /// An "upstream" repository and a clone of it, so nothing touches the network.
    async fn upstream_and_clone() -> (TempRepository, TempRepository) {
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

        (upstream, clone)
    }

    async fn refs_matching(repo: &Path, pattern: &str) -> Vec<String> {
        git(
            &["for-each-ref", "--format=%(refname:short)", pattern],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("for-each-ref should succeed")
        .stdout_lossy()
        .lines()
        .map(str::to_owned)
        .collect()
    }

    #[tokio::test]
    async fn fetches_remote_branches() {
        let (_upstream, clone) = upstream_and_clone().await;

        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        // `contains` rather than equality: git also creates `refs/remotes/origin/HEAD`, which
        // shortens to a bare "origin".
        let refs = refs_matching(&clone.path(), "refs/remotes/origin").await;
        assert!(refs.contains(&"origin/main".to_owned()), "got {refs:?}");
    }

    #[tokio::test]
    async fn controlled_fetch_honours_operation_cancellation() {
        let (_upstream, clone) = upstream_and_clone().await;
        let control = ExecutionControl::new();
        control.cancel(crate::TerminationReason::Cancelled);

        let result = fetch_controlled(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
            Some(control),
        )
        .await;

        assert!(matches!(
            result,
            Err(GitError::OperationTerminated {
                reason: crate::TerminationReason::Cancelled,
                ..
            })
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancels_a_fetch_blocked_after_reporting_activity() {
        let fixture = BlockingSshFetch::new().await;
        let control = ExecutionControl::new();
        let cancellation = control.clone();
        let progress = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&progress);
        let repository = fixture.repository();
        let env = fixture.env();
        let task = tokio::spawn(async move {
            fetch_controlled(
                repository,
                "origin",
                &env,
                Some(move |update| {
                    captured.lock().expect("progress lock").push(update);
                }),
                Some(control),
            )
            .await
        });

        fixture.wait_until_blocked().await;
        wait_for_counting_progress(&progress).await;
        cancellation.cancel(crate::TerminationReason::Cancelled);
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled Fetch should reap its SSH process tree")
            .expect("Fetch task should not panic");

        assert!(matches!(
            result,
            Err(GitError::OperationTerminated {
                reason: crate::TerminationReason::Cancelled,
                ..
            })
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn times_out_a_fetch_at_the_same_deterministic_barrier() {
        let fixture = BlockingSshFetch::new().await;
        let control = ExecutionControl::new();
        let timeout = control.clone();
        let repository = fixture.repository();
        let env = fixture.env();
        let task = tokio::spawn(async move {
            fetch_controlled(
                repository,
                "origin",
                &env,
                None::<fn(FetchProgress)>,
                Some(control),
            )
            .await
        });

        fixture.wait_until_blocked().await;
        timeout.cancel(crate::TerminationReason::TimedOut);
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("timed-out Fetch should reap its SSH process tree")
            .expect("Fetch task should not panic");

        assert!(matches!(
            result,
            Err(GitError::OperationTerminated {
                reason: crate::TerminationReason::TimedOut,
                ..
            })
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_completion_wins_before_a_late_cancellation_request() {
        let fixture = BlockingSshFetch::new().await;
        let control = ExecutionControl::new();
        let late_cancellation = control.clone();
        let repository = fixture.repository();
        let fetched_repository = repository.clone();
        let env = fixture.env();
        let task = tokio::spawn(async move {
            fetch_controlled(
                fetched_repository,
                "origin",
                &env,
                None::<fn(FetchProgress)>,
                Some(control),
            )
            .await
        });

        fixture.wait_until_blocked().await;
        fixture.release();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("released Fetch should complete")
            .expect("Fetch task should not panic")
            .expect("released Fetch should succeed");
        late_cancellation.cancel(crate::TerminationReason::Cancelled);

        let refs = refs_matching(&repository, "refs/remotes/origin").await;
        assert!(refs.contains(&"origin/main".to_owned()), "got {refs:?}");
    }

    #[cfg(unix)]
    async fn wait_for_counting_progress(progress: &Arc<Mutex<Vec<FetchProgress>>>) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if progress
                    .lock()
                    .expect("progress lock")
                    .iter()
                    .any(|update| {
                        update
                            .description
                            .as_deref()
                            .is_some_and(|text| text.starts_with("remote: Counting objects"))
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("blocking SSH fixture did not publish Fetch activity");
    }

    #[tokio::test]
    async fn prunes_branches_deleted_upstream() {
        let (upstream, clone) = upstream_and_clone().await;
        git(
            &["branch", "doomed"],
            upstream.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");
        assert!(refs_matching(&clone.path(), "refs/remotes/origin")
            .await
            .contains(&"origin/doomed".to_owned()));

        git(
            &["branch", "-D", "doomed"],
            upstream.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch -D should succeed");

        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        assert!(
            !refs_matching(&clone.path(), "refs/remotes/origin")
                .await
                .contains(&"origin/doomed".to_owned()),
            "--prune should remove the tracking ref"
        );
    }

    #[tokio::test]
    async fn reports_progress_starting_at_zero() {
        let (_upstream, clone) = upstream_and_clone().await;
        let mut updates: Vec<FetchProgress> = Vec::new();

        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            Some(|progress: FetchProgress| updates.push(progress)),
        )
        .await
        .expect("fetch should succeed");

        assert!(!updates.is_empty());
        assert_eq!(updates[0].value, 0.0);
        assert_eq!(updates[0].title, "Fetching origin");
        assert_eq!(updates[0].remote, "origin");
        assert_eq!(updates[0].description, None);
    }

    #[tokio::test]
    async fn does_not_report_ref_update_summaries_as_progress() {
        // git's fetch stderr carries lines like `* [new branch] main -> origin/main`. They are not
        // progress and the original deliberately filtered them out.
        let (_upstream, clone) = upstream_and_clone().await;
        let mut descriptions: Vec<String> = Vec::new();

        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            Some(|progress: FetchProgress| {
                if let Some(description) = progress.description {
                    descriptions.push(description);
                }
            }),
        )
        .await
        .expect("fetch should succeed");

        for description in &descriptions {
            assert!(
                !description.contains("[new branch]") && !description.starts_with("From "),
                "a ref-update summary leaked into progress: {description:?}"
            );
        }
    }

    #[tokio::test]
    async fn fetching_an_unknown_refspec_is_not_an_error() {
        let (_upstream, clone) = upstream_and_clone().await;

        let output = fetch_refspec(
            clone.path(),
            "origin",
            "refs/pull/999/head:refs/remotes/origin/pr/999",
            &HashMap::new(),
        )
        .await
        .expect("a missing refspec should not fail");

        assert_ne!(output.exit_code, 0, "git did report a problem");
    }

    #[tokio::test]
    async fn fetches_a_specific_refspec() {
        let (upstream, clone) = upstream_and_clone().await;
        git(
            &["branch", "topic"],
            upstream.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        fetch_refspec(
            clone.path(),
            "origin",
            "refs/heads/topic:refs/remotes/origin/topic",
            &HashMap::new(),
        )
        .await
        .expect("fetch should succeed");

        assert!(refs_matching(&clone.path(), "refs/remotes/origin")
            .await
            .contains(&"origin/topic".to_owned()));
    }

    // --- fast-forwarding ---

    #[tokio::test]
    async fn fast_forwards_a_branch_without_checking_it_out() {
        let (upstream, clone) = upstream_and_clone().await;
        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        // A local branch tracking origin/main, while HEAD stays elsewhere.
        git(
            &["checkout", "-b", "local", "origin/main", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        git(
            &["checkout", "-b", "elsewhere", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        commit_file(&upstream.path(), "a.txt", "two\n", "second");
        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        fast_forward_branches(
            clone.path(),
            &[(
                "refs/remotes/origin/main".to_owned(),
                "refs/heads/local".to_owned(),
            )],
        )
        .await
        .expect("fast-forward should succeed");

        let local = git(
            &["rev-parse", "local"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        let tracking = git(
            &["rev-parse", "refs/remotes/origin/main"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        assert_eq!(local, tracking);
    }

    #[tokio::test]
    async fn fast_forwarding_nothing_is_a_noop() {
        let repo = empty_repository().await;
        fast_forward_branches(repo.path(), &[])
            .await
            .expect("an empty list should not run git at all");
    }

    #[tokio::test]
    async fn a_diverged_branch_is_left_alone_rather_than_failing() {
        // git exits 1 when a ref can't be fast-forwarded, which is the expected outcome — so it must
        // not be treated as an error.
        let (upstream, clone) = upstream_and_clone().await;
        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        git(
            &["checkout", "-b", "local", "origin/main", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&clone.path(), "local.txt", "mine\n", "local work");
        git(
            &["checkout", "-b", "elsewhere", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        let before = git(
            &["rev-parse", "local"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        commit_file(&upstream.path(), "a.txt", "two\n", "second");
        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        fast_forward_branches(
            clone.path(),
            &[(
                "refs/remotes/origin/main".to_owned(),
                "refs/heads/local".to_owned(),
            )],
        )
        .await
        .expect("a diverged branch should not fail the call");

        let after = git(
            &["rev-parse", "local"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        assert_eq!(before, after, "the diverged branch must not be moved");
    }

    #[tokio::test]
    async fn fast_forwarding_does_not_touch_fetch_head() {
        let (upstream, clone) = upstream_and_clone().await;
        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");
        git(
            &["checkout", "-b", "local", "origin/main", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        git(
            &["checkout", "-b", "elsewhere", "--"],
            clone.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        commit_file(&upstream.path(), "a.txt", "two\n", "second");
        fetch(
            clone.path(),
            "origin",
            &HashMap::new(),
            None::<fn(FetchProgress)>,
        )
        .await
        .expect("fetch should succeed");

        let fetch_head = clone.path().join(".git/FETCH_HEAD");
        let before = std::fs::read(&fetch_head).unwrap_or_default();

        fast_forward_branches(
            clone.path(),
            &[(
                "refs/remotes/origin/main".to_owned(),
                "refs/heads/local".to_owned(),
            )],
        )
        .await
        .expect("fast-forward should succeed");

        let after = std::fs::read(&fetch_head).unwrap_or_default();
        assert_eq!(
            before, after,
            "--no-write-fetch-head should leave FETCH_HEAD alone"
        );
    }
}
