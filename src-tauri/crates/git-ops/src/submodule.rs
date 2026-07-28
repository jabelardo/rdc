//! Submodules.
//!
//! Ported from `desktop-plus/app/src/lib/git/submodule.ts`.
//!
//! # Why this matters beyond listing
//!
//! The submodule list isn't only for display. `git-store`'s discard-changes path uses it to decide
//! whether a changed path is a submodule, because a submodule must be **reset** rather than moved to
//! the trash. So an entry missing from the list is a safety question, not a cosmetic one — which is why
//! the `describe`-shaped omission described on [`list_submodules`] is worth fixing rather than copying.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::authentication::AUTHENTICATION_ERRORS;
use crate::error::GitError;
use crate::exec::{git, git_with_stderr, GitOptions};
use crate::progress::ProgressLineSplitter;
use crate::rev_parse::resolve_git_dir;

/// A submodule as `git submodule status` reports it.
///
/// Matches `SubmoduleEntry` in the ported `src/models/submodule.ts`, except that `describe` is
/// optional — see [`list_submodules`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmoduleEntry {
    /// The commit the submodule is currently at.
    pub sha: String,
    /// Path relative to the containing repository.
    pub path: String,
    /// `git describe` output, when git reported any.
    ///
    /// `None` for an uninitialized or conflicted submodule, where git prints no `(describe)` part.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub describe: Option<String>,
}

/// Lists the top-level submodules.
///
/// Not recursive, matching the original and `git status`: the app has no story for managing nested
/// submodules, so listing them would imply one.
///
/// # An upstream omission is fixed here
///
/// The original's pattern was `/^.([^ ]+) (.+) \((.+?)\)$/gm`, which **requires** a parenthesised
/// `git describe` value. Verified against real git: `git submodule status` prints that part only for a
/// submodule that is checked out. An **uninitialized** submodule is reported as `-<sha> <path>` and a
/// **conflicted** one as `U<sha> <path>`, both without it — so neither matched, and both were silently
/// dropped from the list.
///
/// Those are precisely the entries that matter most: an uninitialized submodule is what
/// `submodule update --init` exists to fix, and the list guards submodule paths from being trashed. So
/// `describe` is optional here and every entry is reported. Recorded in `MIGRATION_MAP.md` §8.
///
/// The leading status character (` `, `-`, `+`, `U`) is still discarded, as the original did —
/// `SubmoduleEntry` has no field for it and inventing one with no consumer would be speculative. It is
/// available in the output if a caller ever needs it.
pub async fn list_submodules(
    repository: impl AsRef<Path>,
) -> Result<Vec<SubmoduleEntry>, GitError> {
    let repository = repository.as_ref();

    if !has_submodules(repository).await {
        return Ok(Vec::new());
    }

    let output = git(
        &["submodule", "status", "--"],
        repository,
        "listSubmodules",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    if output.exit_code == 128 {
        // git couldn't make sense of the submodule configuration; nothing useful to report.
        return Ok(Vec::new());
    }

    Ok(parse_submodule_status(&output.stdout_lossy()))
}

/// Whether the repository looks like it has submodules at all.
///
/// An optimisation carried over from the original: spawning git is expensive enough — especially on
/// Windows — to be worth avoiding when a cheap file check settles it.
///
/// `.gitmodules` and `.git/modules` cover ordinary repositories. A **linked worktree** keeps its modules
/// directory in the git common directory instead, so that is checked too, by reading the `commondir`
/// file rather than asking git — again to avoid the process.
async fn has_submodules(repository: &Path) -> bool {
    if repository.join(".gitmodules").exists() || repository.join(".git/modules").exists() {
        return true;
    }

    let Ok(git_dir) = resolve_git_dir(repository).await else {
        return false;
    };

    let Ok(contents) = std::fs::read_to_string(git_dir.join("commondir")) else {
        return false;
    };

    let common_dir = contents.trim_end_matches(['\r', '\n']);
    if common_dir.is_empty() {
        return false;
    }

    // Relative to the git directory, as git writes it.
    git_dir.join(common_dir).join("modules").exists()
}

/// Parses `git submodule status` output.
///
/// Each line is `<marker><sha> <path>` with an optional ` (<describe>)`:
///
/// ```text
///  1eaabe34fc6f486367a176207420378f587d3b48 sub (v2.16.0-rc0)
/// -1eaabe34fc6f486367a176207420378f587d3b48 sub
/// ```
///
/// The marker is one of ` ` (unchanged), `-` (uninitialized), `+` (not at the recorded commit) or `U`
/// (conflicted).
fn parse_submodule_status(stdout: &str) -> Vec<SubmoduleEntry> {
    submodule_status_pattern()
        .captures_iter(stdout)
        .filter_map(|captures| {
            Some(SubmoduleEntry {
                sha: captures.get(1)?.as_str().to_owned(),
                path: captures.get(2)?.as_str().to_owned(),
                describe: captures.get(3).map(|value| value.as_str().to_owned()),
            })
        })
        .collect()
}

fn submodule_status_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        // `(?m)` for per-line anchoring. The describe group is optional, which is the fix; the path is
        // non-greedy so it doesn't swallow the ` (describe)` when one is present.
        Regex::new(r"(?m)^.([^ ]+) (.+?)(?: \((.+?)\))?$").expect("pattern is valid")
    })
}

/// Restores the given submodule paths to the commits the containing repository records.
///
/// A no-op when `paths` is empty. `--force` because the point is to discard whatever the submodule's
/// working tree currently has.
pub async fn reset_submodule_paths(
    repository: impl AsRef<Path>,
    paths: &[String],
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut args = vec![
        "submodule".to_owned(),
        "update".to_owned(),
        "--recursive".to_owned(),
        "--force".to_owned(),
        "--".to_owned(),
    ];
    args.extend(paths.iter().cloned());

    git(
        &args,
        repository,
        "resetSubmodulePaths",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

/// Initialises and updates every submodule, reporting progress.
///
/// Run after an operation that may have changed which commits the submodules should be at — `checkout`
/// does, and `pull` will.
///
/// `on_progress` receives `(fraction, description)`, leaving the caller to build its own progress
/// value: `checkout` reports an `ICheckoutProgress` with a `target`, a pull reports an
/// `IPullProgress` with a `remote`, and this shouldn't need to know which.
///
/// `allow_file_protocol` adds `protocol.file.allow=always`. git disabled `file://` submodules by default
/// as part of the CVE-2022-39253 fix — a malicious repository could otherwise make a clone pull in a
/// local path — so this is off unless a caller opts in, and tests are the main legitimate use.
///
/// Authentication failures are declared expected, because updating a submodule can hit the network.
pub async fn update_submodules<F>(
    repository: impl AsRef<Path>,
    env: &HashMap<String, String>,
    allow_file_protocol: bool,
    on_progress: Option<F>,
) -> Result<(), GitError>
where
    F: FnMut(f64, String) + Send,
{
    let mut args: Vec<String> = Vec::new();
    if allow_file_protocol {
        args.extend(["-c".to_owned(), "protocol.file.allow=always".to_owned()]);
    }
    args.extend([
        "submodule".to_owned(),
        "update".to_owned(),
        "--init".to_owned(),
        "--recursive".to_owned(),
    ]);

    let mut options = GitOptions::default().with_expected_errors(AUTHENTICATION_ERRORS);
    for (key, value) in env {
        options = options.with_env(key.clone(), value.clone());
    }

    let Some(mut on_progress) = on_progress else {
        git(&args, repository, "updateSubmodules", options).await?;
        return Ok(());
    };

    on_progress(0.0, "Updating submodules".to_owned());

    let mut events = 0_u32;
    let mut splitter = ProgressLineSplitter::new();

    git_with_stderr(&args, repository, "updateSubmodules", options, |chunk| {
        for line in splitter.push(chunk) {
            if is_submodule_event(&line) {
                events += 1;
            }
            on_progress(
                fake_progress(events),
                format!("Updating submodules: {line}"),
            );
        }
    })
    .await?;

    on_progress(1.0, "Submodules updated".to_owned());

    Ok(())
}

/// Whether a line marks a submodule having been dealt with.
fn is_submodule_event(line: &str) -> bool {
    line.starts_with("Cloning into ") || checked_out_pattern().is_match(line)
}

fn checked_out_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"^Submodule path .+?: checked out ").expect("pattern is valid"))
}

/// Progress that approaches 1 without reaching it, from the number of events seen.
///
/// Deliberately fake, and the original explained why: there is no way to know upfront how many
/// submodules there are or what git will have to do with each — clone one, merely check out another. So
/// this reports `1 - e^(-n/4)`, which moves quickly at first and slows as it goes, never claiming
/// completion. The caller emits an explicit `1.0` when git actually finishes.
fn fake_progress(events: u32) -> f64 {
    1.0 - (-(f64::from(events)) * 0.25).exp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    // --- status parsing ---

    #[test]
    fn parses_a_checked_out_submodule() {
        let stdout = " 1eaabe34fc6f486367a176207420378f587d3b48 sub (v2.16.0-rc0)\n";

        assert_eq!(
            parse_submodule_status(stdout),
            vec![SubmoduleEntry {
                sha: "1eaabe34fc6f486367a176207420378f587d3b48".to_owned(),
                path: "sub".to_owned(),
                describe: Some("v2.16.0-rc0".to_owned()),
            }]
        );
    }

    #[test]
    fn parses_an_uninitialized_submodule_that_the_original_dropped() {
        // The fix. git prints no `(describe)` for an uninitialized submodule, and the original's
        // pattern required one — so this entry vanished from the list entirely.
        let stdout = "-1eaabe34fc6f486367a176207420378f587d3b48 sub\n";

        assert_eq!(
            parse_submodule_status(stdout),
            vec![SubmoduleEntry {
                sha: "1eaabe34fc6f486367a176207420378f587d3b48".to_owned(),
                path: "sub".to_owned(),
                describe: None,
            }]
        );
    }

    #[test]
    fn parses_a_conflicted_submodule() {
        // Also missing its describe, and also dropped by the original.
        let stdout = "U0000000000000000000000000000000000000000 sub\n";
        let parsed = parse_submodule_status(stdout);

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "sub");
        assert_eq!(parsed[0].describe, None);
    }

    #[test]
    fn parses_a_submodule_not_at_its_recorded_commit() {
        let stdout = "+9f8e7d6c5b4a39281706f5e4d3c2b1a098765432 sub (v1.0-1-g9f8e7d6)\n";
        let parsed = parse_submodule_status(stdout);

        assert_eq!(parsed[0].describe.as_deref(), Some("v1.0-1-g9f8e7d6"));
    }

    #[test]
    fn parses_several_submodules_in_mixed_states() {
        let stdout = concat!(
            " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa first (v1.0)\n",
            "-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb second\n",
            "+cccccccccccccccccccccccccccccccccccccccc third (v2.0-1-gccccccc)\n",
        );

        let parsed = parse_submodule_status(stdout);
        let paths: Vec<&str> = parsed.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["first", "second", "third"]);
        assert_eq!(parsed[1].describe, None);
    }

    #[test]
    fn keeps_a_path_containing_spaces() {
        // The path group is non-greedy, so it must still take the whole path rather than stopping early.
        let stdout = " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa my sub dir (v1.0)\n";
        let parsed = parse_submodule_status(stdout);

        assert_eq!(parsed[0].path, "my sub dir");
        assert_eq!(parsed[0].describe.as_deref(), Some("v1.0"));
    }

    #[test]
    fn keeps_a_path_containing_spaces_when_uninitialized() {
        let stdout = "-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa my sub dir\n";
        let parsed = parse_submodule_status(stdout);

        assert_eq!(parsed[0].path, "my sub dir");
        assert_eq!(parsed[0].describe, None);
    }

    #[test]
    fn parses_nothing_from_empty_output() {
        assert!(parse_submodule_status("").is_empty());
    }

    #[test]
    fn omits_describe_rather_than_sending_null() {
        // `SubmoduleEntry.describe` is optional on the wire, so absent must mean absent.
        let value = serde_json::to_value(SubmoduleEntry {
            sha: "a".repeat(40),
            path: "sub".to_owned(),
            describe: None,
        })
        .expect("serializes");

        assert!(value.get("describe").is_none());
    }

    // --- fake progress ---

    #[test]
    fn progress_starts_at_zero_and_approaches_one() {
        assert_eq!(fake_progress(0), 0.0);

        let mut previous = 0.0;
        for events in 1..20 {
            let value = fake_progress(events);
            assert!(value > previous, "should increase at {events}");
            assert!(value < 1.0, "must never claim completion at {events}");
            previous = value;
        }
    }

    #[test]
    fn progress_slows_down_as_it_goes() {
        // The point of the curve: early events move it a lot, later ones less, since we can't know how
        // many submodules there are.
        let first_step = fake_progress(1) - fake_progress(0);
        let later_step = fake_progress(10) - fake_progress(9);
        assert!(first_step > later_step * 5.0);
    }

    #[test]
    fn recognizes_the_lines_that_count_as_events() {
        assert!(is_submodule_event("Cloning into '/tmp/repo/sub'..."));
        assert!(is_submodule_event(
            "Submodule path 'sub': checked out 'aaaaaaa'"
        ));
        assert!(is_submodule_event(
            "Submodule path 'nested/sub': checked out 'bbbbbbb'"
        ));

        assert!(!is_submodule_event(
            "Submodule 'sub' registered for path 'sub'"
        ));
        assert!(!is_submodule_event("remote: Counting objects: 5"));
        assert!(!is_submodule_event(""));
    }

    // --- against real repositories ---

    /// An outer repository with `sub` as a submodule of an inner one.
    async fn repo_with_submodule() -> (TempRepository, TempRepository) {
        let inner = empty_repository().await;
        commit_file(&inner.path(), "a.txt", "one\n", "first");
        git(
            &["tag", "v1.0"],
            inner.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("tag should succeed");

        let outer = empty_repository().await;
        commit_file(&outer.path(), "base.txt", "base\n", "base");

        git(
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--",
                &inner.path().to_string_lossy(),
                "sub",
            ],
            outer.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("submodule add should succeed");
        git(
            &["commit", "-F", "-"],
            outer.path(),
            "test",
            GitOptions::default().with_stdin("add submodule\n"),
        )
        .await
        .expect("commit should succeed");

        (outer, inner)
    }

    #[tokio::test]
    async fn a_repository_with_no_submodules_lists_none() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert!(list_submodules(repo.path())
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn skips_running_git_when_there_are_no_submodules() {
        // The cheap file check that avoids spawning a process.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert!(!has_submodules(&repo.path()).await);
    }

    #[tokio::test]
    async fn lists_a_checked_out_submodule() {
        let (outer, _inner) = repo_with_submodule().await;

        let submodules = list_submodules(outer.path()).await.expect("should succeed");

        assert_eq!(submodules.len(), 1, "got {submodules:?}");
        assert_eq!(submodules[0].path, "sub");
        assert_eq!(submodules[0].sha.len(), 40);
        assert_eq!(submodules[0].describe.as_deref(), Some("v1.0"));
    }

    #[tokio::test]
    async fn lists_an_uninitialized_submodule() {
        // End to end for the fix: after a deinit git reports no describe, and the entry must still be
        // listed — the discard-changes path relies on it to avoid trashing the directory.
        let (outer, _inner) = repo_with_submodule().await;
        git(
            &["submodule", "deinit", "-f", "sub"],
            outer.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("deinit should succeed");

        let submodules = list_submodules(outer.path()).await.expect("should succeed");

        assert_eq!(submodules.len(), 1, "got {submodules:?}");
        assert_eq!(submodules[0].path, "sub");
        assert_eq!(
            submodules[0].describe, None,
            "git reports no describe for an uninitialized submodule"
        );
    }

    /// Empties a submodule so restoring it requires a real clone.
    ///
    /// `deinit` alone leaves `.git/modules/<name>` in place, so `update --init` restores from that local
    /// copy without using any transport — which quietly means a test that only deinits never exercises
    /// the clone path or the protocol restriction. Removing the modules directory too is what forces it.
    async fn empty_submodule(outer: &Path) {
        git(
            &["submodule", "deinit", "-f", "sub"],
            outer,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("deinit should succeed");

        std::fs::remove_dir_all(outer.join(".git/modules"))
            .expect("failed to remove the modules directory");
    }

    #[tokio::test]
    async fn updates_and_initialises_submodules() {
        let (outer, _inner) = repo_with_submodule().await;
        empty_submodule(&outer.path()).await;
        assert!(
            !outer.path().join("sub/a.txt").exists(),
            "the working tree should be empty to start with"
        );

        update_submodules(outer.path(), &HashMap::new(), true, None::<fn(f64, String)>)
            .await
            .expect("updating should succeed");

        assert!(
            outer.path().join("sub/a.txt").exists(),
            "--init should have cloned and checked it out"
        );
    }

    #[tokio::test]
    async fn reports_progress_beginning_at_zero_and_ending_at_one() {
        let (outer, _inner) = repo_with_submodule().await;
        empty_submodule(&outer.path()).await;

        let mut updates: Vec<(f64, String)> = Vec::new();
        update_submodules(
            outer.path(),
            &HashMap::new(),
            true,
            Some(|value: f64, description: String| updates.push((value, description))),
        )
        .await
        .expect("updating should succeed");

        assert!(updates.len() >= 2, "got {updates:?}");
        assert_eq!(updates[0].0, 0.0);
        assert_eq!(updates[0].1, "Updating submodules");
        assert_eq!(updates.last().expect("non-empty").0, 1.0);
        assert_eq!(updates.last().expect("non-empty").1, "Submodules updated");
    }

    #[tokio::test]
    async fn progress_never_decreases() {
        let (outer, _inner) = repo_with_submodule().await;
        empty_submodule(&outer.path()).await;

        let mut values: Vec<f64> = Vec::new();
        update_submodules(
            outer.path(),
            &HashMap::new(),
            true,
            Some(|value: f64, _: String| values.push(value)),
        )
        .await
        .expect("updating should succeed");

        for pair in values.windows(2) {
            assert!(pair[1] >= pair[0], "progress went backwards: {values:?}");
        }
    }

    #[tokio::test]
    async fn a_file_protocol_submodule_needs_the_opt_in() {
        // git refuses local-path submodules by default since the CVE-2022-39253 fix, so a *clone*
        // without the opt-in fails with "transport 'file' not allowed" — verified against real git.
        // `empty_submodule` is what makes this a clone rather than a local restore.
        let (outer, _inner) = repo_with_submodule().await;
        empty_submodule(&outer.path()).await;

        let result = update_submodules(
            outer.path(),
            &HashMap::new(),
            false,
            None::<fn(f64, String)>,
        )
        .await;

        assert!(
            result.is_err(),
            "without protocol.file.allow git should refuse"
        );
    }

    #[tokio::test]
    async fn resets_a_submodule_to_its_recorded_commit() {
        let (outer, _inner) = repo_with_submodule().await;

        // Move the submodule's working tree off what the superproject records.
        std::fs::write(outer.path().join("sub/a.txt"), "scribbled\n").expect("failed to write");

        reset_submodule_paths(outer.path(), &["sub".to_owned()])
            .await
            .expect("resetting should succeed");

        assert_eq!(
            std::fs::read_to_string(outer.path().join("sub/a.txt")).expect("failed to read"),
            "one\n"
        );
    }

    #[tokio::test]
    async fn resetting_no_paths_is_a_noop() {
        let repo = empty_repository().await;
        reset_submodule_paths(repo.path(), &[])
            .await
            .expect("an empty list should not run git at all");
    }
}
