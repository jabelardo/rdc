//! Reading the reflog.
//!
//! Ported from `desktop-plus/app/src/lib/git/reflog.ts`.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// How much reflog to read when looking for recent branches.
///
/// The original's bound, and its reasoning: `git reflog show` is `git log -g` in disguise, and a
/// repository with an enormous reflog would otherwise be read in full. A cap keeps the cost predictable
/// at the price of missing branches checked out very long ago.
const RECENT_BRANCH_REFLOG_LIMIT: &str = "2500";

/// The `limit` most recently checked-out branches, newest first.
///
/// An **unborn branch** yields an empty list rather than an error: git exits 128 when `HEAD` has no
/// commits, which is a normal state for a fresh repository.
pub async fn get_recent_branches(
    repository: impl AsRef<Path>,
    limit: usize,
) -> Result<Vec<String>, GitError> {
    let output = git(
        &[
            "log",
            "-g",
            "--no-abbrev-commit",
            "--pretty=oneline",
            "HEAD",
            "-n",
            RECENT_BRANCH_REFLOG_LIMIT,
            "--",
        ],
        repository,
        "getRecentBranches",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    if output.exit_code == 128 {
        return Ok(Vec::new());
    }

    Ok(parse_recent_branches(&output.stdout_lossy(), limit))
}

/// Extracts branch names from reflog lines, most recent first.
///
/// Two operations are of interest, and one of them needs care:
///
/// - `checkout: moving from <a> to <b>` — `<b>` was checked out.
/// - `renamed refs/heads/<old> to refs/heads/<new>` — `<new>` exists now, but `<old>` **must be excluded**
///   from the results. A rename leaves reflog entries mentioning a branch that no longer exists, and
///   offering it as "recent" would produce a name nothing can check out.
///
/// The exclusion applies to names seen *after* the rename in the walk — i.e. earlier in time — which is
/// what the original's single pass did.
fn parse_recent_branches(stdout: &str, limit: usize) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();

    for line in stdout.lines() {
        if let Some(captures) = recent_branch_pattern().captures(line) {
            let operation = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
            let from = captures.get(2).map(|m| m.as_str()).unwrap_or_default();
            let to = captures.get(3).map(|m| m.as_str()).unwrap_or_default();

            if operation.eq_ignore_ascii_case("renamed") {
                excluded.push(from.to_owned());
            }

            if !excluded.iter().any(|name| name == to) && !names.iter().any(|name| name == to) {
                names.push(to.to_owned());
            }
        }

        if names.len() == limit {
            break;
        }
    }

    names
}

fn recent_branch_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i).*? (renamed|checkout)(?:: moving from|\s*) (?:refs/heads/|\s*)(.*?) to (?:refs/heads/|\s*)(.*?)$",
        )
        .expect("pattern is valid")
    })
}

/// When each branch was last checked out, for checkouts at or after `after` (epoch seconds).
///
/// Returned as pairs rather than a map, because a branch name is an arbitrary string. Only the most
/// recent checkout of each branch is reported.
///
/// # Two changes from the original
///
/// The date is passed **unquoted**. The original interpolated `--after="<iso>"`, and since the argument
/// vector reaches git directly there is no shell to strip those quotes. git happens to tolerate them —
/// verified — but the failure mode if it didn't is silent: an unparseable date makes git filter out
/// *everything* rather than complaining, so this would have returned an empty map with no indication why.
///
/// The timestamps are read as epoch seconds (`--date=unix`) rather than parsed from an ISO string, which
/// also drops the original's `[a-z0-9]{40}` SHA pattern — that assumed SHA-1 and would match nothing in a
/// SHA-256 repository.
pub async fn get_branch_checkouts(
    repository: impl AsRef<Path>,
    after: i64,
) -> Result<Vec<(String, i64)>, GitError> {
    let output = git(
        &[
            "reflog",
            "--date=unix",
            &format!("--after={after}"),
            "--pretty=%H %gd %gs",
            "--grep-reflog=checkout: moving from .* to .*$",
            "--",
        ],
        repository,
        "getBranchCheckouts",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    // An orphaned branch with no commits makes git fail to read the reflog. That is not an error worth
    // surfacing — there are simply no checkouts to report. See desktop/desktop#7983.
    if output.exit_code == 128 {
        return Ok(Vec::new());
    }

    Ok(parse_branch_checkouts(&output.stdout_lossy()))
}

/// Parses `%H %gd %gs` reflog lines with `--date=unix`.
///
/// A line reads `<sha> HEAD@{<epoch>} checkout: moving from <a> to <b>`.
fn parse_branch_checkouts(stdout: &str) -> Vec<(String, i64)> {
    let mut checkouts: Vec<(String, i64)> = Vec::new();

    for line in stdout.lines() {
        let Some(captures) = checkout_pattern().captures(line) else {
            continue;
        };

        let Some(timestamp) = captures.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) else {
            continue;
        };
        let Some(branch) = captures.get(2).map(|m| m.as_str()) else {
            continue;
        };

        // The reflog is newest-first, so the first sighting is the most recent checkout.
        if !checkouts.iter().any(|(name, _)| name == branch) {
            checkouts.push((branch.to_owned(), timestamp));
        }
    }

    checkouts
}

fn checkout_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        // `[0-9a-f]+` rather than the original's `{40}`, which assumed SHA-1.
        Regex::new(r"^[0-9a-f]+ HEAD@\{(\d+)\} checkout: moving from .* to (.*)$")
            .expect("pattern is valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    // --- recent branches ---

    #[test]
    fn finds_checked_out_branches_newest_first() {
        let stdout = concat!(
            "aaa HEAD@{0}: checkout: moving from main to feature\n",
            "bbb HEAD@{1}: checkout: moving from other to main\n",
        );

        assert_eq!(
            parse_recent_branches(stdout, 10),
            vec!["feature".to_owned(), "main".to_owned()]
        );
    }

    #[test]
    fn reports_each_branch_once() {
        let stdout = concat!(
            "aaa HEAD@{0}: checkout: moving from main to feature\n",
            "bbb HEAD@{1}: checkout: moving from feature to main\n",
            "ccc HEAD@{2}: checkout: moving from main to feature\n",
        );

        assert_eq!(
            parse_recent_branches(stdout, 10),
            vec!["feature".to_owned(), "main".to_owned()]
        );
    }

    #[test]
    fn honours_the_limit() {
        let stdout = concat!(
            "aaa HEAD@{0}: checkout: moving from main to one\n",
            "bbb HEAD@{1}: checkout: moving from one to two\n",
            "ccc HEAD@{2}: checkout: moving from two to three\n",
        );

        assert_eq!(parse_recent_branches(stdout, 2).len(), 2);
    }

    #[test]
    fn excludes_a_branch_that_was_renamed_away() {
        // A rename leaves entries naming a branch that no longer exists; offering it as "recent" would
        // give the user a name nothing can check out.
        let stdout = concat!(
            "aaa HEAD@{0}: renamed refs/heads/old-name to refs/heads/new-name\n",
            "bbb HEAD@{1}: checkout: moving from main to old-name\n",
        );

        assert_eq!(
            parse_recent_branches(stdout, 10),
            vec!["new-name".to_owned()],
            "old-name is gone, so it must not be offered"
        );
    }

    #[test]
    fn ignores_lines_that_are_not_checkouts_or_renames() {
        let stdout = concat!(
            "aaa HEAD@{0}: commit: some work\n",
            "bbb HEAD@{1}: pull: Fast-forward\n",
            "ccc HEAD@{2}: checkout: moving from main to feature\n",
        );

        assert_eq!(
            parse_recent_branches(stdout, 10),
            vec!["feature".to_owned()]
        );
    }

    #[test]
    fn finds_no_branches_in_empty_output() {
        assert!(parse_recent_branches("", 10).is_empty());
    }

    // --- checkouts after a date ---

    #[test]
    fn parses_checkout_timestamps_as_epoch_seconds() {
        let stdout = concat!(
            "aaaaaaa HEAD@{1690000100} checkout: moving from main to feature\n",
            "bbbbbbb HEAD@{1690000000} checkout: moving from feature to main\n",
        );

        assert_eq!(
            parse_branch_checkouts(stdout),
            vec![
                ("feature".to_owned(), 1_690_000_100),
                ("main".to_owned(), 1_690_000_000),
            ]
        );
    }

    #[test]
    fn keeps_only_the_most_recent_checkout_of_each_branch() {
        // The reflog is newest-first, so the first sighting wins.
        let stdout = concat!(
            "aaaaaaa HEAD@{1690000200} checkout: moving from other to main\n",
            "bbbbbbb HEAD@{1690000100} checkout: moving from feature to main\n",
        );

        assert_eq!(
            parse_branch_checkouts(stdout),
            vec![("main".to_owned(), 1_690_000_200)]
        );
    }

    #[test]
    fn parses_a_sha256_length_hash() {
        // The original required exactly 40 hex characters, which matches nothing in a SHA-256 repository.
        let stdout = format!(
            "{} HEAD@{{1690000000}} checkout: moving from main to feature\n",
            "a".repeat(64)
        );

        assert_eq!(
            parse_branch_checkouts(&stdout),
            vec![("feature".to_owned(), 1_690_000_000)]
        );
    }

    #[test]
    fn ignores_a_line_with_an_unparseable_timestamp() {
        let stdout = "aaaaaaa HEAD@{notanumber} checkout: moving from main to feature\n";
        assert!(parse_branch_checkouts(stdout).is_empty());
    }

    // --- against real repositories ---

    #[tokio::test]
    async fn reads_recent_branches_from_a_real_repository() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        for branch in ["one", "two", "three"] {
            git(
                &["checkout", "-b", branch, "--"],
                repo.path(),
                "test",
                GitOptions::default(),
            )
            .await
            .expect("checkout should succeed");
        }

        let branches = get_recent_branches(repo.path(), 10)
            .await
            .expect("should succeed");

        assert_eq!(
            branches.first().map(String::as_str),
            Some("three"),
            "the most recent checkout comes first: {branches:?}"
        );
        assert!(branches.contains(&"one".to_owned()));
    }

    #[tokio::test]
    async fn an_unborn_branch_has_no_recent_branches() {
        // git exits 128 when HEAD has no commits, which is normal for a fresh repository.
        let repo = empty_repository().await;

        assert!(get_recent_branches(repo.path(), 10)
            .await
            .expect("an unborn HEAD is not an error")
            .is_empty());
    }

    #[tokio::test]
    async fn reads_checkouts_after_a_date() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        git(
            &["checkout", "-b", "feature", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        let checkouts = get_branch_checkouts(repo.path(), 0)
            .await
            .expect("should succeed");

        assert!(
            checkouts.iter().any(|(name, _)| name == "feature"),
            "got {checkouts:?}"
        );
        assert!(checkouts.iter().all(|(_, when)| *when > 0));
    }

    #[tokio::test]
    async fn a_future_date_matches_nothing() {
        // Also the reason the date is passed unquoted: an unparseable one filters everything out
        // silently, so a broken filter would be indistinguishable from this legitimate empty result.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        git(
            &["checkout", "-b", "feature", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        // Far enough ahead to be safe regardless of when the tests run.
        let far_future = 4_000_000_000;
        assert!(get_branch_checkouts(repo.path(), far_future)
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn a_past_date_matches_the_checkouts() {
        // The companion to the test above: together they show the filter actually filters, which is what
        // proves the date reached git in a form it understood.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        git(
            &["checkout", "-b", "feature", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        assert!(!get_branch_checkouts(repo.path(), 1)
            .await
            .expect("should succeed")
            .is_empty());
    }
}
