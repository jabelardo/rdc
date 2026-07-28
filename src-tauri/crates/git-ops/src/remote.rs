//! Managing a repository's remotes.
//!
//! Ported from `desktop-plus/app/src/lib/git/remote.ts`.
//!
//! # No memoization
//!
//! The original wrapped `getRemotesFromPath` in `memoizeOne`, which caches the result for the most
//! recent path. That is a frontend concern and a hazard here: adding a remote would leave the cache
//! stale until some *other* path was queried. Caching, if wanted, belongs in the store that knows when
//! remotes change.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::authentication::AUTHENTICATION_ERRORS;
use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_error_kind::GitErrorKind;
use crate::refs::get_symbolic_ref;
use crate::remote_progress::remote_env;

/// A remote, as git defines it.
///
/// Matches `IRemote` in the ported `src/models/remote.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// Lists the remotes, in the order git reports them (alphabetical by name).
///
/// A path that isn't a repository yields an **empty list rather than an error**, which the original did
/// too: the caller is usually asking "does this have remotes?" and a missing repository has none.
///
/// Only fetch URLs are reported. `git remote -v` prints a line per direction, and a remote can have a
/// different push URL; the original took the fetch line and this keeps that, because everything
/// downstream treats a remote as having one URL.
pub async fn get_remotes(repository: impl AsRef<Path>) -> Result<Vec<Remote>, GitError> {
    let output = git(
        &["remote", "-v"],
        repository,
        "getRemotes",
        GitOptions::default().with_expected_errors([GitErrorKind::NotAGitRepository]),
    )
    .await?;

    if output.git_error == Some(GitErrorKind::NotAGitRepository) {
        return Ok(Vec::new());
    }

    Ok(parse_remotes(&output.stdout_lossy()))
}

/// Parses `git remote -v` output, keeping only the fetch entries.
///
/// Each line is `<name>\t<url> (fetch|push)`. Split on the **last** space before the direction rather
/// than the first, since a URL can't contain a space but a name theoretically could.
fn parse_remotes(stdout: &str) -> Vec<Remote> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once('\t')?;
            let (url, direction) = rest.rsplit_once(' ')?;

            (direction == "(fetch)").then(|| Remote {
                name: name.to_owned(),
                url: url.to_owned(),
            })
        })
        .collect()
}

/// Adds a remote and returns it.
pub async fn add_remote(
    repository: impl AsRef<Path>,
    name: &str,
    url: &str,
) -> Result<Remote, GitError> {
    git(
        &["remote", "add", name, url],
        repository,
        "addRemote",
        GitOptions::default(),
    )
    .await?;

    Ok(Remote {
        name: name.to_owned(),
        url: url.to_owned(),
    })
}

/// Removes a remote.
///
/// Removing one that doesn't exist is **not an error**: git exits 2 for a missing remote and 128 for a
/// path that isn't a repository, and both are accepted. The original did the same — the caller wants
/// the remote gone, and it already is.
pub async fn remove_remote(repository: impl AsRef<Path>, name: &str) -> Result<(), GitError> {
    git(
        &["remote", "remove", name],
        repository,
        "removeRemote",
        GitOptions::default().with_success_exit_codes([2, 128]),
    )
    .await?;

    Ok(())
}

/// Points an existing remote at a different URL.
pub async fn set_remote_url(
    repository: impl AsRef<Path>,
    name: &str,
    url: &str,
) -> Result<(), GitError> {
    git(
        &["remote", "set-url", name, url],
        repository,
        "setRemoteURL",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

/// The fetch URL of `name`, or `None` if there is no such remote.
pub async fn get_remote_url(
    repository: impl AsRef<Path>,
    name: &str,
) -> Result<Option<String>, GitError> {
    let output = git(
        &["remote", "get-url", name],
        repository,
        "getRemoteURL",
        GitOptions::default().with_success_exit_codes([2, 128]),
    )
    .await?;

    if output.exit_code != 0 {
        return Ok(None);
    }

    // Trimmed, unlike the original, which returned git's output including its trailing newline — a
    // URL with a newline on the end fails every comparison it is used in.
    Ok(Some(output.stdout_trimmed()))
}

/// Asks the remote which branch its `HEAD` points at, and records it locally.
///
/// This **contacts the remote**, so it needs the credential environment and can fail for the usual
/// authentication reasons. Exit codes 1 and 128 are tolerated, as in the original: a remote that can't
/// be reached, or has no `HEAD` to report, shouldn't fail whatever the caller was really doing.
///
/// `is_background_task` isn't a parameter here — it belongs to the session the caller built `env`
/// from, which is where the no-prompting rule is enforced.
pub async fn update_remote_head(
    repository: impl AsRef<Path>,
    name: &str,
    env: &HashMap<String, String>,
) -> Result<(), GitError> {
    let mut options = GitOptions::default()
        .with_success_exit_codes([1, 128])
        .with_expected_errors(AUTHENTICATION_ERRORS);

    for (key, value) in remote_env(env) {
        options = options.with_env(key, value);
    }

    git(
        &["remote", "set-head", "-a", name],
        repository,
        "updateRemoteHEAD",
        options,
    )
    .await?;

    Ok(())
}

/// The branch a remote's `HEAD` points at, with the remote prefix stripped.
///
/// Reads what [`update_remote_head`] recorded, so it needs no network. Returns `None` when the ref is
/// absent or doesn't name a branch under that remote.
pub async fn get_remote_head(
    repository: impl AsRef<Path>,
    name: &str,
) -> Result<Option<String>, GitError> {
    let namespace = format!("refs/remotes/{name}/");
    let head = get_symbolic_ref(repository, &format!("{namespace}HEAD")).await?;

    let Some(head) = head else {
        return Ok(None);
    };

    // The `len >` check is the original's, and it matters: a ref equal to the namespace would
    // otherwise yield an empty branch name.
    Ok(head
        .strip_prefix(&namespace)
        .filter(|branch| !branch.is_empty())
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    // --- parsing ---

    #[test]
    fn parses_fetch_entries_and_ignores_push_ones() {
        // git prints a line per direction; taking both would double every remote.
        let stdout = concat!(
            "origin\thttps://github.com/o/r.git (fetch)\n",
            "origin\thttps://github.com/o/r.git (push)\n",
            "upstream\thttps://github.com/u/r.git (fetch)\n",
            "upstream\thttps://github.com/u/r.git (push)\n",
        );

        assert_eq!(
            parse_remotes(stdout),
            vec![
                Remote {
                    name: "origin".to_owned(),
                    url: "https://github.com/o/r.git".to_owned()
                },
                Remote {
                    name: "upstream".to_owned(),
                    url: "https://github.com/u/r.git".to_owned()
                },
            ]
        );
    }

    #[test]
    fn reports_the_fetch_url_when_push_differs() {
        let stdout = concat!(
            "origin\thttps://github.com/o/r.git (fetch)\n",
            "origin\tssh://git@github.com/o/r.git (push)\n",
        );

        let remotes = parse_remotes(stdout);
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].url, "https://github.com/o/r.git");
    }

    #[test]
    fn parses_no_remotes_from_empty_output() {
        assert!(parse_remotes("").is_empty());
    }

    #[test]
    fn ignores_a_malformed_line() {
        assert!(parse_remotes("nonsense\n").is_empty());
    }

    // --- against real repositories ---

    #[tokio::test]
    async fn lists_remotes_alphabetically() {
        let repo = empty_repository().await;
        add_remote(repo.path(), "upstream", "https://example.invalid/u.git")
            .await
            .expect("add should succeed");
        add_remote(repo.path(), "origin", "https://example.invalid/o.git")
            .await
            .expect("add should succeed");

        let remotes = get_remotes(repo.path()).await.expect("should succeed");
        let names: Vec<&str> = remotes.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["origin", "upstream"]);
    }

    #[tokio::test]
    async fn a_repository_with_no_remotes_lists_none() {
        let repo = empty_repository().await;
        assert!(get_remotes(repo.path())
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn a_path_that_is_not_a_repository_lists_none_rather_than_failing() {
        // The caller is usually asking "does this have remotes?", and a missing repository has none.
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        assert!(get_remotes(dir.path())
            .await
            .expect("not a repository is not an error here")
            .is_empty());
    }

    #[tokio::test]
    async fn adds_a_remote_and_returns_it() {
        let repo = empty_repository().await;
        let remote = add_remote(repo.path(), "origin", "https://example.invalid/o.git")
            .await
            .expect("add should succeed");

        assert_eq!(remote.name, "origin");
        assert_eq!(
            get_remotes(repo.path()).await.expect("should succeed"),
            vec![remote]
        );
    }

    #[tokio::test]
    async fn adding_a_remote_that_exists_fails() {
        let repo = empty_repository().await;
        add_remote(repo.path(), "origin", "https://example.invalid/o.git")
            .await
            .expect("add should succeed");

        assert!(
            add_remote(repo.path(), "origin", "https://example.invalid/other.git")
                .await
                .is_err(),
            "git refuses, and silently repointing would lose the old URL"
        );
    }

    #[tokio::test]
    async fn removes_a_remote() {
        let repo = empty_repository().await;
        add_remote(repo.path(), "origin", "https://example.invalid/o.git")
            .await
            .expect("add should succeed");

        remove_remote(repo.path(), "origin")
            .await
            .expect("remove should succeed");
        assert!(get_remotes(repo.path())
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn removing_a_remote_that_does_not_exist_succeeds() {
        // The caller wants it gone, and it already is.
        let repo = empty_repository().await;
        remove_remote(repo.path(), "nosuchremote")
            .await
            .expect("removing a missing remote should not fail");
    }

    #[tokio::test]
    async fn removing_from_a_path_that_is_not_a_repository_succeeds() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        remove_remote(dir.path(), "origin")
            .await
            .expect("exit code 128 is tolerated");
    }

    #[tokio::test]
    async fn changes_a_remote_url() {
        let repo = empty_repository().await;
        add_remote(repo.path(), "origin", "https://example.invalid/old.git")
            .await
            .expect("add should succeed");

        set_remote_url(repo.path(), "origin", "https://example.invalid/new.git")
            .await
            .expect("set-url should succeed");

        assert_eq!(
            get_remote_url(repo.path(), "origin")
                .await
                .expect("should succeed")
                .as_deref(),
            Some("https://example.invalid/new.git")
        );
    }

    #[tokio::test]
    async fn reads_a_remote_url_without_a_trailing_newline() {
        // The original returned git's output verbatim, newline included, which fails every comparison
        // the value is then used in.
        let repo = empty_repository().await;
        add_remote(repo.path(), "origin", "https://example.invalid/o.git")
            .await
            .expect("add should succeed");

        let url = get_remote_url(repo.path(), "origin")
            .await
            .expect("should succeed")
            .expect("the remote exists");

        assert!(!url.ends_with('\n'), "got {url:?}");
        assert_eq!(url, "https://example.invalid/o.git");
    }

    #[tokio::test]
    async fn reads_no_url_for_a_missing_remote() {
        let repo = empty_repository().await;
        assert_eq!(
            get_remote_url(repo.path(), "nosuchremote")
                .await
                .expect("should succeed"),
            None
        );
    }

    // --- remote HEAD ---

    #[tokio::test]
    async fn records_and_reads_a_remotes_default_branch() {
        let upstream = empty_repository().await;
        commit_file(&upstream.path(), "a.txt", "one\n", "first");

        let repo = empty_repository().await;
        add_remote(repo.path(), "origin", &upstream.path().to_string_lossy())
            .await
            .expect("add should succeed");
        git(
            &["fetch", "origin"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("fetch should succeed");

        // A plain `git fetch` already records `refs/remotes/origin/HEAD` when the remote advertises
        // it — verified against real git. So `update_remote_head` is usually a refresh rather than the
        // thing that creates it; it still matters when the remote didn't advertise one, or when the
        // default branch changed upstream.
        update_remote_head(repo.path(), "origin", &HashMap::new())
            .await
            .expect("set-head should succeed");

        assert_eq!(
            get_remote_head(repo.path(), "origin")
                .await
                .expect("should succeed")
                .as_deref(),
            Some("main")
        );
    }

    #[tokio::test]
    async fn updating_head_for_an_unreachable_remote_does_not_fail() {
        // Tolerated because it is usually incidental to whatever the caller was really doing.
        let repo = empty_repository().await;
        add_remote(repo.path(), "origin", "/no/such/repository")
            .await
            .expect("add should succeed");

        update_remote_head(repo.path(), "origin", &HashMap::new())
            .await
            .expect("an unreachable remote should not fail the call");
    }

    #[tokio::test]
    async fn reads_no_head_for_a_remote_that_has_none() {
        let repo = empty_repository().await;
        assert_eq!(
            get_remote_head(repo.path(), "origin")
                .await
                .expect("should succeed"),
            None
        );
    }
}
