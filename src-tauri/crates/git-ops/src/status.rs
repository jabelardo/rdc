//! Repository status.
//!
//! Ported from `desktop-plus/app/src/lib/git/status.ts`.
//!
//! # What this returns, and what it deliberately doesn't
//!
//! The original built `WorkingDirectoryFileChange` objects, each carrying a `DiffSelection` — the
//! set of lines/files the user has ticked for staging — and wrapped them in a
//! `WorkingDirectoryStatus` that aggregates an include-all state. Those are **view state**, not
//! git facts: `DiffSelection` starts as "all selected" here and is then mutated by the UI as the
//! user clicks.
//!
//! So this returns the git facts only — path, interpreted status, conflict details, branch and
//! ahead/behind, in-progress operation state — and the frontend constructs its own
//! `WorkingDirectoryFileChange`/`DiffSelection` from them. Keeping selection state out of the git
//! layer avoids inventing a Rust representation of something only the UI mutates.
//!
//! One consequence worth noting: the original computed the *initial* selection here, using the
//! rule "a submodule whose commit hasn't changed starts unselected". That rule is preserved as
//! [`StatusFileChange::starts_unselected`] so the frontend doesn't have to rediscover it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::diff::get_binary_paths;
use crate::diff_check::get_files_with_conflict_markers;
use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::operation_state::{
    get_rebase_internal_state, is_cherry_pick_head_found, is_merge_head_set, is_squash_msg_set,
    RebaseInternalState,
};
use crate::rev_parse::resolve_git_dir;
use crate::status_parser::{
    map_status, parse_porcelain_status, FileEntry, GitStatusEntry, OrdinaryChange, StatusEntry,
    StatusItem, SubmoduleStatus, UnmergedEntrySummary,
};

/// Status codes that mean the index holds a conflict.
const CONFLICT_STATUS_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

/// How far ahead/behind a branch is relative to its upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

/// How the app presents a changed file.
///
/// Internally tagged on `kind`, which reproduces the original TypeScript discriminated union
/// (`{ kind: AppFileStatusKind.Modified, … }`) exactly — the variant names already match the
/// ported `AppFileStatusKind` values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AppFileStatus {
    New {
        #[serde(skip_serializing_if = "Option::is_none")]
        submodule_status: Option<SubmoduleStatus>,
    },
    Modified {
        #[serde(skip_serializing_if = "Option::is_none")]
        submodule_status: Option<SubmoduleStatus>,
    },
    Deleted {
        #[serde(skip_serializing_if = "Option::is_none")]
        submodule_status: Option<SubmoduleStatus>,
    },
    Copied {
        old_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        submodule_status: Option<SubmoduleStatus>,
        rename_includes_modifications: bool,
    },
    Renamed {
        old_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        submodule_status: Option<SubmoduleStatus>,
        rename_includes_modifications: bool,
    },
    Untracked {
        #[serde(skip_serializing_if = "Option::is_none")]
        submodule_status: Option<SubmoduleStatus>,
    },
    Conflicted(ConflictedFileStatus),
}

/// The porcelain status for an unmerged entry.
///
/// Mirrors `UnmergedEntry` in the ported `src/models/status.ts`, which is a member of the `FileEntry`
/// union and therefore carries `kind: 'conflicted'`. Serde's internally-tagged *struct*
/// representation emits that constant tag, with `rename` supplying the lowercase name.
///
/// This is a separate type from the parser's [`crate::status_parser::FileEntry::Conflicted`] on
/// purpose: that one is an internal parsing detail and isn't serialized, whereas this crosses the
/// IPC boundary and so has to match the TypeScript byte for byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "conflicted", rename_all = "camelCase")]
pub struct UnmergedEntry {
    pub action: UnmergedEntrySummary,
    pub us: GitStatusEntry,
    pub them: GitStatusEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submodule_status: Option<SubmoduleStatus>,
}

/// A conflict, and whether we can count markers in it.
///
/// Untagged, because in the original these were two shapes of the *same* `Conflicted` kind,
/// distinguished by whether `conflictMarkerCount` is present (`isConflictWithMarkers` tested for
/// exactly that). Tagging it would introduce a discriminator the TypeScript side never had.
///
/// The conflict details sit **nested under `entry`**, not flattened alongside `conflictMarkerCount`.
/// That mirrors the original's `parseConflictedState`, which assigned the whole `UnmergedEntry`
/// through — and it matters, because `src/lib/status.ts` consumes the ported `AppFileStatus` and
/// would not typecheck against a flattened shape.
///
/// Note the original's `ConflictsWithMarkers.submoduleStatus` is deliberately not represented:
/// the type permits it, but `parseConflictedState` never sets it — the submodule status a conflict
/// carries is the one inside `entry`.
///
/// `WithMarkers` must stay first: untagged deserialization tries variants in declaration order, and
/// `Manual` would happily match a payload that has a marker count by ignoring the extra field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum ConflictedFileStatus {
    /// A text conflict, with the number of leftover markers found.
    ///
    /// Only produced for both-added/both-modified conflicts in non-binary files, which are the
    /// ones where git writes markers into the working copy.
    WithMarkers {
        entry: UnmergedEntry,
        conflict_marker_count: usize,
    },
    /// A conflict the user has to resolve by choosing a side — either because it isn't a
    /// content conflict, or because the file is binary and has no markers to count.
    Manual { entry: UnmergedEntry },
}

/// One changed path, as git sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFileChange {
    /// Path relative to the repository root.
    pub path: String,
    pub status: AppFileStatus,
    /// Whether the UI should start with this file *unticked*.
    ///
    /// Carries over the original's rule: a modified submodule whose own commit hasn't changed
    /// (only its working tree is dirty) starts unselected, because committing it in the
    /// superproject wouldn't record anything.
    pub starts_unselected: bool,
}

/// The status of a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_upstream_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_ahead_behind: Option<AheadBehind>,
    pub merge_head_found: bool,
    pub squash_msg_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_internal_state: Option<RebaseInternalState>,
    pub is_cherry_picking_head_found: bool,
    /// Changed paths, in the order git reported them.
    pub files: Vec<StatusFileChange>,
    pub do_conflicted_files_exist: bool,
}

/// Reads the status of a repository.
///
/// Returns `Ok(None)` when the path isn't a repository: `git status` exits 128 for that, which the
/// original treated as "missing" rather than an error. The `exists` field of the original's
/// `IStatusResult` is therefore represented by the `Option` itself.
///
/// # `list_untracked_files_individually`
///
/// Adds `--untracked-files=all`. **This is the original's `includeUntracked` parameter, renamed
/// because that name is misleading**: passing `false` does *not* exclude untracked files. git's
/// default is `--untracked-files=normal`, which still reports them — it just collapses an untracked
/// *directory* to a single entry (`nested/`) instead of listing every file beneath it
/// (`nested/b.txt`, `nested/deep/a.txt`). Verified against real git; the behaviour is unchanged
/// from the original, only the name.
pub async fn get_status(
    repository: impl AsRef<Path>,
    list_untracked_files_individually: bool,
) -> Result<Option<StatusResult>, GitError> {
    let repository = repository.as_ref();

    let mut args = vec!["--no-optional-locks".to_owned(), "status".to_owned()];
    if list_untracked_files_individually {
        args.push("--untracked-files=all".to_owned());
    }
    args.extend([
        "--branch".to_owned(),
        "--porcelain=2".to_owned(),
        "-z".to_owned(),
    ]);

    let output = git(
        &args,
        repository,
        "getStatus",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    if output.exit_code == 128 {
        // Almost always a path that isn't a repository, or has lost its .git directory.
        return Ok(None);
    }

    let parsed = parse_porcelain_status(&output.stdout)?;

    let mut headers = Vec::new();
    let mut entries = Vec::new();
    for item in parsed {
        match item {
            StatusItem::Header(value) => headers.push(value),
            StatusItem::Entry(entry) => entries.push(entry),
        }
    }

    // Resolved once and threaded through, rather than each helper recomputing it.
    let git_dir = resolve_git_dir(repository).await?;

    let merge_head_found = is_merge_head_set(&git_dir).await;
    let rebase_internal_state = get_rebase_internal_state(&git_dir).await;

    let conflicted_paths: Vec<String> = entries
        .iter()
        .filter(|entry| CONFLICT_STATUS_CODES.contains(&entry.status_code.as_str()))
        .map(|entry| entry.path.clone())
        .collect();

    let conflict_details = get_conflict_details(
        repository,
        merge_head_found,
        &conflicted_paths,
        rebase_internal_state.as_ref(),
    )
    .await;

    let files = build_file_changes(&entries, &conflict_details);
    let headers = parse_status_headers(&headers);

    Ok(Some(StatusResult {
        current_branch: headers.current_branch,
        current_upstream_branch: headers.current_upstream_branch,
        current_tip: headers.current_tip,
        branch_ahead_behind: headers.branch_ahead_behind,
        merge_head_found,
        squash_msg_found: is_squash_msg_set(&git_dir).await,
        rebase_internal_state,
        is_cherry_picking_head_found: is_cherry_pick_head_found(&git_dir).await,
        files,
        do_conflicted_files_exist: !conflicted_paths.is_empty(),
    }))
}

/// Conflict marker counts and binary paths, used to interpret conflicted entries.
#[derive(Debug, Default)]
struct ConflictDetails {
    conflict_counts_by_path: HashMap<String, usize>,
    binary_file_paths: Vec<String>,
}

/// Gathers the extra detail needed to describe conflicts.
///
/// Which ref to diff against depends on what kind of operation produced the conflict. Failures are
/// swallowed and reported as "no detail", matching the original: partial conflict metadata should
/// degrade the display, not fail the whole status call.
async fn get_conflict_details(
    repository: &Path,
    merge_head_found: bool,
    conflicted_paths: &[String],
    rebase_internal_state: Option<&RebaseInternalState>,
) -> ConflictDetails {
    let reference = if merge_head_found {
        Some("MERGE_HEAD")
    } else if rebase_internal_state.is_some() {
        Some("REBASE_HEAD")
    } else if !conflicted_paths.is_empty() {
        // Conflicts with neither a merge head nor a rebase in progress: most likely a stash pop
        // introduced them, so compare against HEAD.
        Some("HEAD")
    } else {
        None
    };

    let Some(reference) = reference else {
        return ConflictDetails::default();
    };

    let conflict_counts_by_path = get_files_with_conflict_markers(repository)
        .await
        .unwrap_or_default();

    // The original tolerated this failing for the HEAD case specifically, noting HEAD may not
    // exist yet. Tolerating it for all three is simpler and no less correct — the fallback is an
    // empty list either way.
    let binary_file_paths = get_binary_paths(repository, reference, conflicted_paths)
        .await
        .unwrap_or_default();

    ConflictDetails {
        conflict_counts_by_path,
        binary_file_paths,
    }
}

/// Turns status entries into the app's file changes.
///
/// Keeps git's ordering, and applies the two suppression rules the original had.
fn build_file_changes(
    entries: &[StatusEntry],
    conflict_details: &ConflictDetails,
) -> Vec<StatusFileChange> {
    let mut files: Vec<StatusFileChange> = Vec::new();

    for entry in entries {
        let status = map_status(
            &entry.status_code,
            &entry.submodule_status_code,
            entry.rename_or_copy_score,
        );

        // Added to the index then deleted from the working tree: the file won't be part of the
        // commit, so showing it in the changes list would be misleading.
        if let FileEntry::Ordinary {
            index: Some(GitStatusEntry::Added),
            working_tree: Some(GitStatusEntry::Deleted),
            ..
        } = status
        {
            continue;
        }

        // A staged delete plus an untracked file at the same path would otherwise draw twice.
        if matches!(status, FileEntry::Untracked { .. }) {
            files.retain(|existing| existing.path != entry.path);
        }

        let Some(app_status) = to_app_status(
            &entry.path,
            &status,
            conflict_details,
            entry.old_path.as_deref(),
        ) else {
            // The original called `fatalError` here. A status we can't classify shouldn't take
            // down the whole listing, so the entry is skipped instead.
            continue;
        };

        let starts_unselected = matches!(
            &app_status,
            AppFileStatus::Modified {
                submodule_status: Some(submodule),
            } if !submodule.commit_changed
        );

        // Later entries for the same path replace earlier ones, preserving position — the
        // original used a Map keyed on path for exactly this.
        if let Some(existing) = files.iter_mut().find(|file| file.path == entry.path) {
            existing.status = app_status;
            existing.starts_unselected = starts_unselected;
        } else {
            files.push(StatusFileChange {
                path: entry.path.clone(),
                status: app_status,
                starts_unselected,
            });
        }
    }

    files
}

/// Interprets a [`FileEntry`] as an [`AppFileStatus`].
///
/// `None` when the combination can't be classified — a rename or copy without an original path,
/// which shouldn't happen because the parser requires one.
fn to_app_status(
    path: &str,
    entry: &FileEntry,
    conflict_details: &ConflictDetails,
    old_path: Option<&str>,
) -> Option<AppFileStatus> {
    match entry {
        FileEntry::Ordinary {
            change,
            submodule_status,
            ..
        } => Some(match change {
            OrdinaryChange::Added => AppFileStatus::New {
                submodule_status: *submodule_status,
            },
            OrdinaryChange::Modified => AppFileStatus::Modified {
                submodule_status: *submodule_status,
            },
            OrdinaryChange::Deleted => AppFileStatus::Deleted {
                submodule_status: *submodule_status,
            },
        }),

        FileEntry::Copied {
            submodule_status, ..
        } => Some(AppFileStatus::Copied {
            old_path: old_path?.to_owned(),
            submodule_status: *submodule_status,
            // The original hard-codes false for copies.
            rename_includes_modifications: false,
        }),

        FileEntry::Renamed {
            working_tree,
            rename_or_copy_score,
            submodule_status,
            ..
        } => Some(AppFileStatus::Renamed {
            old_path: old_path?.to_owned(),
            submodule_status: *submodule_status,
            // A score below 100 means the content changed as well as the path.
            rename_includes_modifications: *working_tree == Some(GitStatusEntry::Modified)
                || rename_or_copy_score.is_some_and(|score| score < 100),
        }),

        FileEntry::Untracked { submodule_status } => Some(AppFileStatus::Untracked {
            submodule_status: *submodule_status,
        }),

        FileEntry::Conflicted {
            action,
            us,
            them,
            submodule_status,
        } => Some(AppFileStatus::Conflicted(to_conflicted_status(
            *action,
            *us,
            *them,
            *submodule_status,
            path,
            conflict_details,
        ))),
    }
}

/// Decides whether a conflict can report marker counts.
///
/// Only both-added and both-modified put markers in the file, and only when it isn't binary —
/// otherwise the user has to pick a side, so it's a manual conflict.
fn to_conflicted_status(
    action: UnmergedEntrySummary,
    us: GitStatusEntry,
    them: GitStatusEntry,
    submodule_status: Option<SubmoduleStatus>,
    path: &str,
    conflict_details: &ConflictDetails,
) -> ConflictedFileStatus {
    let has_markers = matches!(
        action,
        UnmergedEntrySummary::BothAdded | UnmergedEntrySummary::BothModified
    ) && !conflict_details
        .binary_file_paths
        .iter()
        .any(|binary| binary == path);

    let entry = UnmergedEntry {
        action,
        us,
        them,
        submodule_status,
    };

    if has_markers {
        ConflictedFileStatus::WithMarkers {
            entry,
            conflict_marker_count: conflict_details
                .conflict_counts_by_path
                .get(path)
                .copied()
                .unwrap_or(0),
        }
    } else {
        ConflictedFileStatus::Manual { entry }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct StatusHeaders {
    current_branch: Option<String>,
    current_upstream_branch: Option<String>,
    current_tip: Option<String>,
    branch_ahead_behind: Option<AheadBehind>,
}

/// Extracts branch information from the `# branch.*` header lines.
fn parse_status_headers(headers: &[String]) -> StatusHeaders {
    let mut result = StatusHeaders::default();

    for header in headers {
        if let Some(captures) = branch_oid_pattern().captures(header) {
            // Deliberately does not match `branch.oid (initial)`, which is what git reports for an
            // unborn branch — there is no tip yet.
            result.current_tip = captures.get(1).map(|m| m.as_str().to_owned());
        } else if let Some(value) = header.strip_prefix("branch.head ") {
            if value != "(detached)" {
                result.current_branch = Some(value.to_owned());
            }
        } else if let Some(value) = header.strip_prefix("branch.upstream ") {
            result.current_upstream_branch = Some(value.to_owned());
        } else if let Some(captures) = branch_ab_pattern().captures(header) {
            let ahead = captures.get(1).and_then(|m| m.as_str().parse::<u32>().ok());
            let behind = captures.get(2).and_then(|m| m.as_str().parse::<u32>().ok());
            if let (Some(ahead), Some(behind)) = (ahead, behind) {
                result.branch_ahead_behind = Some(AheadBehind { ahead, behind });
            }
        }
    }

    result
}

fn branch_oid_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^branch\.oid ([a-f0-9]+)$").expect("pattern is valid"))
}

fn branch_ab_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^branch\.ab \+(\d+) -(\d+)$").expect("pattern is valid"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

    fn header_strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    // --- header parsing ---

    #[test]
    fn parses_branch_headers() {
        let headers = parse_status_headers(&header_strings(&[
            "branch.oid 2de0487c2d3e977f5f560b746833f9d7f9a054fd",
            "branch.head main",
            "branch.upstream origin/main",
            "branch.ab +1 -2",
        ]));

        assert_eq!(
            headers.current_tip.as_deref(),
            Some("2de0487c2d3e977f5f560b746833f9d7f9a054fd")
        );
        assert_eq!(headers.current_branch.as_deref(), Some("main"));
        assert_eq!(
            headers.current_upstream_branch.as_deref(),
            Some("origin/main")
        );
        assert_eq!(
            headers.branch_ahead_behind,
            Some(AheadBehind {
                ahead: 1,
                behind: 2
            })
        );
    }

    #[test]
    fn ignores_an_unborn_branch_oid() {
        // git reports `branch.oid (initial)` before the first commit; there is no tip to report.
        let headers = parse_status_headers(&header_strings(&["branch.oid (initial)"]));
        assert_eq!(headers.current_tip, None);
    }

    #[test]
    fn treats_a_detached_head_as_having_no_branch() {
        let headers = parse_status_headers(&header_strings(&["branch.head (detached)"]));
        assert_eq!(headers.current_branch, None);
    }

    #[test]
    fn ignores_unrecognized_headers() {
        let headers = parse_status_headers(&header_strings(&["something.else whatever"]));
        assert_eq!(headers, StatusHeaders::default());
    }

    // --- get_status against real repositories ---

    #[tokio::test]
    async fn reports_none_for_a_directory_that_is_not_a_repository() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        assert_eq!(
            get_status(dir.path(), true)
                .await
                .expect("a non-repository is not an error"),
            None
        );
    }

    #[tokio::test]
    async fn reports_a_clean_repository() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        assert_eq!(status.current_branch.as_deref(), Some("main"));
        assert!(status.current_tip.is_some());
        assert_eq!(status.current_upstream_branch, None);
        assert!(status.files.is_empty(), "got {:?}", status.files);
        assert!(!status.merge_head_found);
        assert!(!status.do_conflicted_files_exist);
        assert_eq!(status.rebase_internal_state, None);
    }

    #[tokio::test]
    async fn reports_modified_added_and_untracked_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");

        std::fs::write(repo.path().join("tracked"), "changed\n").expect("failed to write");
        std::fs::write(repo.path().join("staged"), "new\n").expect("failed to write");
        git(
            &["add", "--", "staged"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        std::fs::write(repo.path().join("untracked"), "loose\n").expect("failed to write");

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        let by_path: HashMap<&str, &AppFileStatus> = status
            .files
            .iter()
            .map(|file| (file.path.as_str(), &file.status))
            .collect();

        assert!(
            matches!(by_path.get("tracked"), Some(AppFileStatus::Modified { .. })),
            "got {by_path:?}"
        );
        assert!(
            matches!(by_path.get("staged"), Some(AppFileStatus::New { .. })),
            "got {by_path:?}"
        );
        assert!(
            matches!(
                by_path.get("untracked"),
                Some(AppFileStatus::Untracked { .. })
            ),
            "got {by_path:?}"
        );
    }

    #[tokio::test]
    async fn collapses_untracked_directories_when_not_listing_individually() {
        // Pins down what the flag actually does. Passing false does NOT hide untracked files —
        // git's default `normal` mode reports an untracked directory as one entry instead of
        // enumerating its contents. Getting this wrong is easy: the original parameter was named
        // `includeUntracked`, which suggests the opposite.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");
        std::fs::write(repo.path().join("loose.txt"), "loose\n").expect("failed to write");
        std::fs::create_dir_all(repo.path().join("nested/deep")).expect("failed to create dirs");
        std::fs::write(repo.path().join("nested/b.txt"), "b\n").expect("failed to write");
        std::fs::write(repo.path().join("nested/deep/a.txt"), "a\n").expect("failed to write");

        let collapsed = get_status(repo.path(), false)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");
        let collapsed_paths: Vec<&str> = collapsed
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();

        assert!(
            collapsed_paths.contains(&"loose.txt"),
            "a top-level untracked file is still reported: {collapsed_paths:?}"
        );
        assert!(
            collapsed_paths.contains(&"nested/"),
            "an untracked directory collapses to one entry: {collapsed_paths:?}"
        );
        assert!(
            !collapsed_paths.contains(&"nested/b.txt"),
            "its contents are not enumerated: {collapsed_paths:?}"
        );

        let individual = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");
        let individual_paths: Vec<&str> = individual
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();

        assert!(
            individual_paths.contains(&"nested/b.txt")
                && individual_paths.contains(&"nested/deep/a.txt"),
            "with the flag set every untracked file is listed: {individual_paths:?}"
        );
        assert!(
            !individual_paths.contains(&"nested/"),
            "and the directory itself is not: {individual_paths:?}"
        );
    }

    #[tokio::test]
    async fn reports_a_rename() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "before", "contents\n", "first");
        git(
            &["mv", "before", "after"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("mv should succeed");

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        let renamed = status
            .files
            .iter()
            .find(|file| file.path == "after")
            .expect("the new path should be listed");

        match &renamed.status {
            AppFileStatus::Renamed {
                old_path,
                rename_includes_modifications,
                ..
            } => {
                assert_eq!(old_path, "before");
                assert!(
                    !rename_includes_modifications,
                    "an unmodified rename scores 100"
                );
            }
            other => panic!("expected Renamed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reports_a_conflict_with_its_marker_count() {
        let repo = conflicted_repository().await;

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        assert!(status.merge_head_found, "a merge should be in progress");
        assert!(status.do_conflicted_files_exist);

        let conflicted = status
            .files
            .iter()
            .find(|file| file.path == "foo")
            .expect("the conflicted file should be listed");

        match &conflicted.status {
            AppFileStatus::Conflicted(ConflictedFileStatus::WithMarkers {
                entry,
                conflict_marker_count,
            }) => {
                assert_eq!(entry.action, UnmergedEntrySummary::BothModified);
                assert!(
                    *conflict_marker_count > 0,
                    "a text conflict should have countable markers"
                );
            }
            other => panic!("expected a text conflict with markers, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reports_a_binary_conflict_as_manual() {
        let repo = conflicted_repository().await;
        // A binary merge driver means git leaves no markers, so the user must pick a side.
        std::fs::write(repo.path().join(".gitattributes"), "foo merge=binary\n")
            .expect("failed to write .gitattributes");

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        let conflicted = status
            .files
            .iter()
            .find(|file| file.path == "foo")
            .expect("the conflicted file should be listed");

        assert!(
            matches!(
                &conflicted.status,
                AppFileStatus::Conflicted(ConflictedFileStatus::Manual { .. })
            ),
            "got {:?}",
            conflicted.status
        );
    }

    #[tokio::test]
    async fn reports_ahead_behind_against_an_upstream() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        let base = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        git(
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/repo.git",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("remote add should succeed");
        git(
            &["update-ref", "refs/remotes/origin/main", &base],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("update-ref should succeed");
        git(
            &["branch", "--set-upstream-to=origin/main", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("set-upstream should succeed");

        // One local commit the upstream doesn't have.
        commit_file(&repo.path(), "foo", "ahead\n", "second");

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        assert_eq!(
            status.current_upstream_branch.as_deref(),
            Some("origin/main")
        );
        assert_eq!(
            status.branch_ahead_behind,
            Some(AheadBehind {
                ahead: 1,
                behind: 0
            })
        );
    }

    #[tokio::test]
    async fn skips_a_file_added_to_the_index_then_deleted() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "keep", "contents\n", "first");

        std::fs::write(repo.path().join("transient"), "here\n").expect("failed to write");
        git(
            &["add", "--", "transient"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        std::fs::remove_file(repo.path().join("transient")).expect("failed to remove");

        let status = get_status(repo.path(), true)
            .await
            .expect("should succeed")
            .expect("a repository should be Some");

        assert!(
            !status.files.iter().any(|file| file.path == "transient"),
            "an added-then-deleted file won't be in the commit, so it shouldn't be listed: {:?}",
            status.files
        );
    }

    // --- classification, without spawning git ---

    #[test]
    fn marks_a_dirty_submodule_with_an_unchanged_commit_as_starting_unselected() {
        let details = ConflictDetails::default();
        let entry = map_status(".M", "S.MU", None);
        let status = to_app_status("sub", &entry, &details, None).expect("should classify");

        let starts_unselected = matches!(
            &status,
            AppFileStatus::Modified {
                submodule_status: Some(submodule),
            } if !submodule.commit_changed
        );
        assert!(
            starts_unselected,
            "committing this in the superproject would record nothing"
        );
    }

    #[test]
    fn marks_a_submodule_with_a_changed_commit_as_starting_selected() {
        let details = ConflictDetails::default();
        let entry = map_status(".M", "SC..", None);
        let status = to_app_status("sub", &entry, &details, None).expect("should classify");

        let starts_unselected = matches!(
            &status,
            AppFileStatus::Modified {
                submodule_status: Some(submodule),
            } if !submodule.commit_changed
        );
        assert!(!starts_unselected);
    }

    #[test]
    fn treats_a_partial_rename_as_including_modifications() {
        let details = ConflictDetails::default();
        let entry = map_status("R.", "N...", Some(87));
        let status = to_app_status("new", &entry, &details, Some("old")).expect("should classify");

        match status {
            AppFileStatus::Renamed {
                rename_includes_modifications,
                ..
            } => assert!(
                rename_includes_modifications,
                "a score below 100 means the content changed too"
            ),
            other => panic!("expected Renamed, got {other:?}"),
        }
    }

    #[test]
    fn treats_a_non_content_conflict_as_manual() {
        // Deleted-by-them has no markers to count regardless of whether the file is binary.
        let details = ConflictDetails::default();
        let entry = map_status("UD", "N...", None);
        let status = to_app_status("foo", &entry, &details, None).expect("should classify");

        assert!(
            matches!(
                status,
                AppFileStatus::Conflicted(ConflictedFileStatus::Manual { .. })
            ),
            "got {status:?}"
        );
    }

    #[test]
    fn skips_a_rename_without_an_original_path() {
        // The parser guarantees an old path for renames, so this is defensive; it must not panic.
        let details = ConflictDetails::default();
        let entry = map_status("R.", "N...", Some(100));
        assert_eq!(to_app_status("new", &entry, &details, None), None);
    }
}
