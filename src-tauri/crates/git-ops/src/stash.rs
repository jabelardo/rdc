//! Stashing changes.
//!
//! Ported from `desktop-plus/app/src/lib/git/stash.ts`.
//!
//! # How the app finds its own stashes
//!
//! git has no way to attach metadata to a stash, so the app encodes what it needs in the *message*:
//! `!!GitHub_Desktop<branch>`, optionally preceded by `!!Name<url-encoded name>`. Entries without that
//! marker are stashes the user made elsewhere and are left alone.
//!
//! The marker string is deliberately unchanged from the original. A user upgrading from
//! `desktop-plus` keeps their stashes, and renaming it would orphan every one of them.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_delimiter_parser::LogParser;
use crate::git_error_kind::GitErrorKind;
use crate::log::{parse_raw_log_with_numstat, CommittedFileChange};
use crate::update_index::{stage_files, FileToStage};

/// The marker identifying a stash the app created.
///
/// Kept as the original's string so stashes survive an upgrade from `desktop-plus`.
pub const STASH_ENTRY_MARKER: &str = "!!GitHub_Desktop";

/// A stash entry the app created.
///
/// Matches `IStashEntry` in the ported `src/models/stash-entry.ts`, minus its `files` field: that
/// carries a load state the frontend owns (`NotLoaded`/`Loading`/`Loaded`), so it is view state and the
/// frontend supplies it — the same split as `WorkingDirectoryFileChange` in [`crate::status`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// The reflog name, e.g. `stash@{0}`.
    pub name: String,
    /// The branch that was checked out when the stash was made.
    pub branch_name: String,
    /// A user-provided name, if one was given.
    pub custom_name: Option<String>,
    /// The commit the stash was stored as.
    pub stash_sha: String,
    /// Seconds since the Unix epoch.
    ///
    /// The original read `%aI` (an ISO-8601 string) and parsed it into a `Date`. This asks git for
    /// `%at` instead, which *is* epoch seconds — one representation on the wire, no re-parsing, and the
    /// same convention as `CommitIdentity` in [`crate::log`].
    pub created_at: i64,
    pub tree: String,
    pub parents: Vec<String>,
}

/// What [`get_stashes`] found.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashResult {
    /// Entries the app created, newest first.
    pub desktop_entries: Vec<StashEntry>,
    /// How many stash entries exist in total, including ones made outside the app.
    pub stash_entry_count: usize,
}

/// Lists the app's stash entries, newest first, and counts all of them.
///
/// # An upstream off-by-one is fixed here
///
/// The original returned `entries.length - 1` as the total. Verified against real git: three stashes
/// produce three records, so it under-reported by one — and with exactly **one** stash it reported
/// **zero**, i.e. the UI would believe there were no stashes at all. Recorded in `MIGRATION_MAP.md` §8.
///
/// Exit code 128 means there is no `refs/stash` reflog, or the path isn't a repository. Neither is an
/// error: a repository with no stashes simply has none.
pub async fn get_stashes(repository: impl AsRef<Path>) -> Result<StashResult, GitError> {
    let fields = ["%gD", "%H", "%gs", "%T", "%P", "%at"];
    let parser = LogParser::new(&fields);

    let mut args = vec!["log".to_owned(), "-g".to_owned()];
    args.extend(parser.format_args());
    args.extend(["refs/stash".to_owned(), "--".to_owned()]);

    let output = git(
        &args,
        repository,
        "getStashEntries",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    if output.exit_code == 128 {
        return Ok(StashResult::default());
    }

    let records = parser.parse(&output.stdout_lossy());
    let stash_entry_count = records.len();
    let mut desktop_entries = Vec::new();

    for record in &records {
        let [name, stash_sha, message, tree, parents, date] = record.as_slice() else {
            continue;
        };

        let Some(details) = extract_stash_details(message) else {
            // A stash the user made outside the app.
            continue;
        };

        desktop_entries.push(StashEntry {
            name: name.clone(),
            branch_name: details.branch_name,
            custom_name: details.custom_name,
            stash_sha: stash_sha.clone(),
            created_at: date.parse().unwrap_or(0),
            tree: tree.clone(),
            parents: if parents.is_empty() {
                Vec::new()
            } else {
                parents.split(' ').map(str::to_owned).collect()
            },
        });
    }

    // git returns the reflog newest-first already; sorting by date makes that explicit and survives a
    // reflog whose order was disturbed by `stash store`.
    desktop_entries.sort_by_key(|entry| std::cmp::Reverse(entry.created_at));

    Ok(StashResult {
        desktop_entries,
        stash_entry_count,
    })
}

/// What the app encoded in a stash message.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StashDetails {
    branch_name: String,
    custom_name: Option<String>,
}

/// Reads the app's marker out of a stash message, or `None` if it isn't one of ours.
fn extract_stash_details(message: &str) -> Option<StashDetails> {
    let captures = stash_message_pattern().captures(message)?;
    let branch_name = captures.get(2)?.as_str();

    // An empty branch name means the marker is malformed; the original rejected it too.
    if branch_name.is_empty() {
        return None;
    }

    Some(StashDetails {
        branch_name: branch_name.to_owned(),
        custom_name: captures.get(1).map(|name| decode_component(name.as_str())),
    })
}

fn stash_message_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?:!!Name<([^<>]+)>)?!!GitHub_Desktop<(.+)>$").expect("pattern is valid")
    })
}

/// Builds a stash message carrying the app's marker.
pub fn create_stash_message(branch_name: &str, custom_name: Option<&str>) -> String {
    let prefix = match custom_name.filter(|name| !name.is_empty()) {
        Some(name) => format!("!!Name<{}>", encode_component(name)),
        None => String::new(),
    };

    format!("{prefix}{STASH_ENTRY_MARKER}<{branch_name}>")
}

/// Percent-encodes a custom name.
///
/// Matches JavaScript's `encodeURIComponent` unreserved set — `A-Za-z0-9-_.!~*'()` — rather than a
/// more aggressive escape, because a name encoded by `desktop-plus` has to decode identically here.
/// Encoding at all is necessary: the marker uses `<` and `>` as delimiters, so a name containing one
/// would otherwise make the message unparseable.
fn encode_component(value: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";
    let mut encoded = String::with_capacity(value.len());

    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }

    encoded
}

/// Reverses [`encode_component`].
///
/// Invalid escapes are left as they are, matching the original's `catch` that returned the raw name —
/// a stash written by some other tool shouldn't be unreadable.
fn decode_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).unwrap_or_else(|_| value.to_owned())
}

/// The commit `refs/stash` points at, or `None` if there are no stashes.
async fn stash_ref(repository: &Path) -> Result<Option<String>, GitError> {
    let output = git(
        &["rev-parse", "--verify", "--quiet", "refs/stash"],
        repository,
        "stashRef",
        GitOptions::default().with_success_exit_codes([1]),
    )
    .await?;

    Ok((output.exit_code == 0).then(|| output.stdout_trimmed()))
}

/// Stashes the working directory, returning whether anything was stashed.
///
/// `untracked_files_to_stage` must be staged first: `git stash push` with a pathspec ignores untracked
/// files, so anything untracked the user selected has to be in the index to be included. This is the
/// fix from desktop/desktop#8085 and it is why this takes them separately.
///
/// `selected_files` limits the stash to those paths; `None` stashes everything.
///
/// # How "did it work?" is decided — changed from the original
///
/// The original inferred it from the exit code and stderr: exit 1 with no line beginning `error: ` was
/// taken to mean a stash *was* created. Its own comment documented that this doesn't hold — an unborn
/// repository exits 1 having created nothing — and declined to fix it.
///
/// This asks git instead: `refs/stash` is read before and after, and a stash was created exactly when
/// that ref changed. No guessing, and the unborn-repository case falls out correctly. Recorded in
/// `MIGRATION_MAP.md` §8.
pub async fn create_stash_entry(
    repository: impl AsRef<Path>,
    branch_name: &str,
    untracked_files_to_stage: &[FileToStage],
    selected_files: Option<&[String]>,
) -> Result<bool, GitError> {
    let repository = repository.as_ref();

    stage_files(repository, untracked_files_to_stage).await?;

    let before = stash_ref(repository).await?;

    let message = create_stash_message(branch_name, None);
    let mut args = vec![
        "stash".to_owned(),
        "push".to_owned(),
        "-m".to_owned(),
        message,
    ];
    if let Some(selected) = selected_files {
        // `--` so a path resembling an option or revision can't be misread.
        args.push("--".to_owned());
        args.extend(selected.iter().cloned());
    }

    // Exit 1 is tolerated rather than interpreted; the ref comparison below decides the outcome.
    git(
        &args,
        repository,
        "createStashEntry",
        GitOptions::default().with_success_exit_codes([1]),
    )
    .await?;

    let after = stash_ref(repository).await?;

    Ok(after.is_some() && after != before)
}

/// The app's most recent stash for `branch_name`, if any.
///
/// The entries are newest first, so the first match is the latest.
pub async fn get_last_stash_entry_for_branch(
    repository: impl AsRef<Path>,
    branch_name: &str,
) -> Result<Option<StashEntry>, GitError> {
    let stashes = get_stashes(repository).await?;

    Ok(stashes
        .desktop_entries
        .into_iter()
        .find(|entry| entry.branch_name == branch_name))
}

/// Drops the app's stash entry with the given commit, if it exists.
///
/// Looks the entry up by SHA to get its `stash@{n}` name, because that index shifts as other entries
/// are dropped — dropping by a stale index would delete the wrong stash.
pub async fn drop_stash_entry(
    repository: impl AsRef<Path>,
    stash_sha: &str,
) -> Result<(), GitError> {
    let repository = repository.as_ref();

    let Some(entry) = find_entry_by_sha(repository, stash_sha).await? else {
        return Ok(());
    };

    git(
        &["stash", "drop", &entry.name],
        repository,
        "dropStashEntry",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

async fn find_entry_by_sha(
    repository: &Path,
    stash_sha: &str,
) -> Result<Option<StashEntry>, GitError> {
    Ok(get_stashes(repository)
        .await?
        .desktop_entries
        .into_iter()
        .find(|entry| entry.stash_sha == stash_sha))
}

/// Applies the app's stash entry with the given commit and removes it.
///
/// Conflicts are expected rather than fatal, so the caller can drive a resolution flow.
///
/// A pop that conflicts exits 1 **and leaves the stash in place**, so it is dropped explicitly. The
/// original distinguished that case by requiring stderr to be empty; this checks whether the entry is
/// still there afterwards, which is the condition actually being tested.
pub async fn pop_stash_entry(
    repository: impl AsRef<Path>,
    stash_sha: &str,
) -> Result<(), GitError> {
    let repository = repository.as_ref();

    let Some(entry) = find_entry_by_sha(repository, stash_sha).await? else {
        return Ok(());
    };

    git(
        &["stash", "pop", "--quiet", &entry.name],
        repository,
        "popStashEntry",
        GitOptions::default()
            .with_success_exit_codes([1])
            .with_expected_errors([GitErrorKind::MergeConflicts]),
    )
    .await?;

    // Still present means the pop conflicted, so git kept it; drop it as the original did.
    if find_entry_by_sha(repository, stash_sha).await?.is_some() {
        drop_stash_entry(repository, stash_sha).await?;
    }

    Ok(())
}

/// Re-stores a stash under a new message and drops the old entry.
///
/// git can't edit a stash's message, so the entry is rebuilt: `commit-tree` makes a new commit with the
/// same tree and parents, `stash store` records it, and the old one is dropped. The author and committer
/// dates are pinned so the rebuilt entry keeps its original position when sorted by date.
async fn replace_stash_entry(
    repository: &Path,
    entry: &StashEntry,
    message: &str,
) -> Result<String, GitError> {
    let mut args = vec!["commit-tree".to_owned()];
    for parent in &entry.parents {
        args.extend(["-p".to_owned(), parent.clone()]);
    }
    args.extend([
        "-m".to_owned(),
        message.to_owned(),
        // Signing a synthetic stash commit would prompt for a key and serves no purpose.
        "--no-gpg-sign".to_owned(),
        entry.tree.clone(),
    ]);

    // git's raw date format: `<epoch> <timezone>`. UTC, matching the original's `toISOString()`.
    let date = format!("{} +0000", entry.created_at);

    let output = git(
        &args,
        repository,
        "replaceStashEntry",
        GitOptions::default()
            .with_env("GIT_AUTHOR_DATE", date.clone())
            .with_env("GIT_COMMITTER_DATE", date),
    )
    .await?;
    let new_sha = output.stdout_trimmed();

    git(
        &["stash", "store", "-m", message, &new_sha],
        repository,
        "replaceStashEntry",
        GitOptions::default(),
    )
    .await?;

    drop_stash_entry(repository, &entry.stash_sha).await?;

    Ok(new_sha)
}

/// Re-associates a stash entry with a different branch.
pub async fn move_stash_entry(
    repository: impl AsRef<Path>,
    entry: &StashEntry,
    branch_name: &str,
) -> Result<String, GitError> {
    let message = format!(
        "On {branch_name}: {}",
        create_stash_message(branch_name, entry.custom_name.as_deref())
    );

    replace_stash_entry(repository.as_ref(), entry, &message).await
}

/// Sets or clears a stash entry's user-provided name.
///
/// Returns the entry's new SHA, or `None` when the name is unchanged and nothing was rewritten —
/// rebuilding the entry for no reason would change its SHA and invalidate whatever the caller holds.
///
/// A name that is blank or only whitespace clears the custom name, matching the original's
/// `newName?.trim() || null`.
pub async fn rename_stash_entry(
    repository: impl AsRef<Path>,
    entry: &StashEntry,
    new_name: Option<&str>,
) -> Result<Option<String>, GitError> {
    let custom_name = new_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);

    if custom_name == entry.custom_name {
        return Ok(None);
    }

    let message = format!(
        "On {}: {}",
        entry.branch_name,
        create_stash_message(&entry.branch_name, custom_name.as_deref())
    );

    Ok(Some(
        replace_stash_entry(repository.as_ref(), entry, &message).await?,
    ))
}

/// The files a stash entry touches.
pub async fn get_stashed_files(
    repository: impl AsRef<Path>,
    stash_sha: &str,
) -> Result<Vec<CommittedFileChange>, GitError> {
    let output = git(
        &[
            "stash",
            "show",
            stash_sha,
            "--raw",
            "--numstat",
            "-z",
            "--format=format:",
            "--no-show-signature",
            "--",
        ],
        repository,
        "getStashedFiles",
        GitOptions::default(),
    )
    .await?;

    Ok(
        parse_raw_log_with_numstat(&output.stdout_lossy(), stash_sha, &format!("{stash_sha}^"))?
            .files,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    // --- message encoding ---

    #[test]
    fn builds_a_message_carrying_the_marker() {
        assert_eq!(create_stash_message("main", None), "!!GitHub_Desktop<main>");
    }

    #[test]
    fn includes_an_encoded_custom_name() {
        assert_eq!(
            create_stash_message("main", Some("my work")),
            "!!Name<my%20work>!!GitHub_Desktop<main>"
        );
    }

    #[test]
    fn encodes_the_delimiters_that_would_break_the_message() {
        // A name containing `<` or `>` would otherwise make the marker unparseable.
        let message = create_stash_message("main", Some("a<b>c"));
        assert_eq!(message, "!!Name<a%3Cb%3Ec>!!GitHub_Desktop<main>");

        let details = extract_stash_details(&message).expect("should parse");
        assert_eq!(details.custom_name.as_deref(), Some("a<b>c"));
    }

    #[test]
    fn matches_encode_uri_component_for_the_unreserved_set() {
        // These must round-trip through a name written by desktop-plus, so the set matters.
        assert_eq!(encode_component("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        assert_eq!(encode_component("a b"), "a%20b");
        assert_eq!(encode_component("100%"), "100%25");
        assert_eq!(encode_component("a/b?c#d"), "a%2Fb%3Fc%23d");
    }

    #[test]
    fn round_trips_a_name_with_multibyte_characters() {
        let name = "作業中 🎉";
        let encoded = encode_component(name);
        assert!(encoded.is_ascii(), "got {encoded}");
        assert_eq!(decode_component(&encoded), name);
    }

    #[test]
    fn leaves_an_invalid_escape_as_it_is() {
        // A stash written by another tool shouldn't be unreadable.
        assert_eq!(decode_component("a%zzb"), "a%zzb");
        assert_eq!(decode_component("trailing%"), "trailing%");
    }

    // --- message parsing ---

    #[test]
    fn recognizes_a_message_with_no_custom_name() {
        let details =
            extract_stash_details("On main: !!GitHub_Desktop<main>").expect("should parse");
        assert_eq!(details.branch_name, "main");
        assert_eq!(details.custom_name, None);
    }

    #[test]
    fn recognizes_a_message_with_a_custom_name() {
        let details = extract_stash_details("On main: !!Name<my%20work>!!GitHub_Desktop<feature>")
            .expect("should parse");
        assert_eq!(details.branch_name, "feature");
        assert_eq!(details.custom_name.as_deref(), Some("my work"));
    }

    #[test]
    fn ignores_a_stash_made_outside_the_app() {
        assert_eq!(
            extract_stash_details("WIP on main: abc1234 some commit"),
            None
        );
        assert_eq!(extract_stash_details("On main: my own stash"), None);
    }

    #[test]
    fn rejects_a_marker_with_an_empty_branch_name() {
        assert_eq!(extract_stash_details("!!GitHub_Desktop<>"), None);
    }

    #[test]
    fn handles_a_branch_name_containing_angle_brackets() {
        // The pattern's `(.+)` is greedy to the last `>`, so an unusual branch name still round-trips.
        let message = create_stash_message("feature/a>b", None);
        let details = extract_stash_details(&message).expect("should parse");
        assert_eq!(details.branch_name, "feature/a>b");
    }

    // --- against real repositories ---

    async fn repo_with_a_commit() -> TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        repo
    }

    #[tokio::test]
    async fn a_repository_with_no_stashes_reports_none() {
        let repo = repo_with_a_commit().await;
        assert_eq!(
            get_stashes(repo.path()).await.expect("should succeed"),
            StashResult::default()
        );
    }

    #[tokio::test]
    async fn a_path_that_is_not_a_repository_reports_none() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        assert_eq!(
            get_stashes(dir.path()).await.expect("should succeed"),
            StashResult::default()
        );
    }

    #[tokio::test]
    async fn creates_and_lists_a_stash() {
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");

        let created = create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");
        assert!(created);

        let stashes = get_stashes(repo.path()).await.expect("should succeed");
        assert_eq!(stashes.desktop_entries.len(), 1);
        assert_eq!(stashes.desktop_entries[0].branch_name, "main");
        assert_eq!(stashes.desktop_entries[0].name, "refs/stash@{0}");
        assert!(stashes.desktop_entries[0].created_at > 0);

        // And the working tree is clean again.
        let contents = std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read");
        assert_eq!(contents, "one\n");
    }

    #[tokio::test]
    async fn reports_nothing_stashed_when_there_are_no_changes() {
        let repo = repo_with_a_commit().await;

        let created = create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("should succeed");
        assert!(!created, "there was nothing to stash");
        assert!(get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries
            .is_empty());
    }

    #[tokio::test]
    async fn reports_nothing_stashed_in_a_repository_with_no_commits() {
        // The case the original documented as broken: `git stash push` exits 1 having created nothing,
        // and inferring success from the exit code claimed a stash existed. Asking git about
        // `refs/stash` gets it right.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("a.txt"), "one\n").expect("failed to write");

        let created = create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("an unborn repository should not be an error");

        assert!(!created, "nothing can be stashed before the first commit");
    }

    #[tokio::test]
    async fn counts_stashes_made_outside_the_app() {
        // The off-by-one. Three stashes must report three, and one must report one.
        let repo = repo_with_a_commit().await;

        for index in 1..=3 {
            std::fs::write(repo.path().join("a.txt"), format!("change{index}\n"))
                .expect("failed to write");
            git(
                &["stash", "push", "-m", &format!("mine {index}")],
                repo.path(),
                "test",
                GitOptions::default(),
            )
            .await
            .expect("stash should succeed");
        }

        let stashes = get_stashes(repo.path()).await.expect("should succeed");
        assert_eq!(stashes.stash_entry_count, 3);
        assert!(stashes.desktop_entries.is_empty(), "none of them are ours");
    }

    #[tokio::test]
    async fn a_single_stash_is_counted_as_one() {
        // The original reported zero here, which the UI would read as "no stashes".
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        git(
            &["stash", "push", "-m", "mine"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("stash should succeed");

        assert_eq!(
            get_stashes(repo.path())
                .await
                .expect("should succeed")
                .stash_entry_count,
            1
        );
    }

    #[tokio::test]
    async fn stashes_only_the_selected_paths() {
        let repo = repo_with_a_commit().await;
        commit_file(&repo.path(), "b.txt", "b\n", "second");
        std::fs::write(repo.path().join("a.txt"), "changed a\n").expect("failed to write");
        std::fs::write(repo.path().join("b.txt"), "changed b\n").expect("failed to write");

        create_stash_entry(repo.path(), "main", &[], Some(&["a.txt".to_owned()]))
            .await
            .expect("stashing should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "one\n",
            "the selected file is reverted"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("b.txt")).expect("failed to read"),
            "changed b\n",
            "the unselected file is left alone"
        );
    }

    #[tokio::test]
    async fn includes_an_untracked_file_that_was_staged_first() {
        // Why `untracked_files_to_stage` exists: `stash push` with a pathspec ignores untracked files,
        // so they have to be in the index. desktop/desktop#8085.
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("new.txt"), "new\n").expect("failed to write");

        create_stash_entry(
            repo.path(),
            "main",
            &[FileToStage::new("new.txt")],
            Some(&["new.txt".to_owned()]),
        )
        .await
        .expect("stashing should succeed");

        assert!(
            !repo.path().join("new.txt").exists(),
            "the untracked file should have been stashed away"
        );
    }

    #[tokio::test]
    async fn finds_the_last_entry_for_a_branch() {
        let repo = repo_with_a_commit().await;

        std::fs::write(repo.path().join("a.txt"), "first change\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");
        std::fs::write(repo.path().join("a.txt"), "second change\n").expect("failed to write");
        create_stash_entry(repo.path(), "other", &[], None)
            .await
            .expect("stashing should succeed");

        let entry = get_last_stash_entry_for_branch(repo.path(), "main")
            .await
            .expect("should succeed")
            .expect("there is one for main");
        assert_eq!(entry.branch_name, "main");

        assert_eq!(
            get_last_stash_entry_for_branch(repo.path(), "nosuchbranch")
                .await
                .expect("should succeed"),
            None
        );
    }

    #[tokio::test]
    async fn drops_an_entry_by_its_sha() {
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        drop_stash_entry(repo.path(), &entry.stash_sha)
            .await
            .expect("dropping should succeed");

        assert!(get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries
            .is_empty());
    }

    #[tokio::test]
    async fn dropping_an_unknown_sha_is_a_noop() {
        let repo = repo_with_a_commit().await;
        drop_stash_entry(repo.path(), &"a".repeat(40))
            .await
            .expect("dropping something that isn't there should succeed");
    }

    #[tokio::test]
    async fn pops_an_entry_restoring_the_changes() {
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        pop_stash_entry(repo.path(), &entry.stash_sha)
            .await
            .expect("popping should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "changed\n"
        );
        assert!(
            get_stashes(repo.path())
                .await
                .expect("should succeed")
                .desktop_entries
                .is_empty(),
            "a popped entry is gone"
        );
    }

    #[tokio::test]
    async fn a_conflicting_pop_still_removes_the_entry() {
        // git leaves a conflicting stash in place; the original dropped it explicitly and so does this.
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "stashed change\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        // Commit a conflicting change so the pop can't apply cleanly.
        commit_file(&repo.path(), "a.txt", "conflicting change\n", "second");

        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        pop_stash_entry(repo.path(), &entry.stash_sha)
            .await
            .expect("a conflicting pop should not be an error");

        assert!(
            get_stashes(repo.path())
                .await
                .expect("should succeed")
                .desktop_entries
                .is_empty(),
            "the entry must not be left behind"
        );
    }

    #[tokio::test]
    async fn renames_an_entry_and_keeps_its_date() {
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        let before = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();

        let new_sha = rename_stash_entry(repo.path(), &before, Some("  my work  "))
            .await
            .expect("renaming should succeed")
            .expect("the name changed, so it was rewritten");

        let after = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        assert_eq!(after.stash_sha, new_sha);
        assert_eq!(after.custom_name.as_deref(), Some("my work"), "trimmed");
        assert_eq!(after.branch_name, "main");
        assert_eq!(after.tree, before.tree, "the contents are unchanged");
        assert_eq!(
            after.created_at, before.created_at,
            "the date is pinned so sorting is stable"
        );
    }

    #[tokio::test]
    async fn renaming_to_the_same_name_rewrites_nothing() {
        // Rebuilding the entry would change its SHA and invalidate whatever the caller holds.
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        assert_eq!(
            rename_stash_entry(repo.path(), &entry, None)
                .await
                .expect("should succeed"),
            None,
            "it already had no custom name"
        );
    }

    #[tokio::test]
    async fn a_blank_name_clears_the_custom_name() {
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");
        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        rename_stash_entry(repo.path(), &entry, Some("named"))
            .await
            .expect("should succeed");

        let named = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        assert_eq!(named.custom_name.as_deref(), Some("named"));

        rename_stash_entry(repo.path(), &named, Some("   "))
            .await
            .expect("should succeed");

        let cleared = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        assert_eq!(cleared.custom_name, None);
    }

    #[tokio::test]
    async fn moves_an_entry_to_another_branch() {
        let repo = repo_with_a_commit().await;
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        move_stash_entry(repo.path(), &entry, "feature")
            .await
            .expect("moving should succeed");

        let moved = get_stashes(repo.path()).await.expect("should succeed");
        assert_eq!(moved.desktop_entries.len(), 1, "the old entry is dropped");
        assert_eq!(moved.desktop_entries[0].branch_name, "feature");
        assert_eq!(moved.desktop_entries[0].tree, entry.tree);
    }

    #[tokio::test]
    async fn reads_the_files_a_stash_touches() {
        let repo = repo_with_a_commit().await;
        commit_file(&repo.path(), "b.txt", "b\n", "second");
        std::fs::write(repo.path().join("a.txt"), "changed a\n").expect("failed to write");
        std::fs::write(repo.path().join("b.txt"), "changed b\n").expect("failed to write");
        create_stash_entry(repo.path(), "main", &[], None)
            .await
            .expect("stashing should succeed");

        let entry = get_stashes(repo.path())
            .await
            .expect("should succeed")
            .desktop_entries[0]
            .clone();
        let files = get_stashed_files(repo.path(), &entry.stash_sha)
            .await
            .expect("should succeed");

        let mut paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, vec!["a.txt", "b.txt"]);
    }
}
