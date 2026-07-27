//! Parsing `git status --porcelain=2 -z` output.
//!
//! Ported from `desktop-plus/app/src/lib/status-parser.ts`, together with the status types it
//! depends on from `app/src/models/status.ts`.
//!
//! # Why this lives in Rust
//!
//! Phase 1 ported `status-parser.ts` to TypeScript. Since `lib/git/status.ts` becomes a Rust
//! command, parsing had to move here too — otherwise Rust would ship raw porcelain over IPC for
//! the webview to interpret, splitting git logic across the boundary. The TypeScript parser's
//! tests became this module's spec and the TypeScript implementation was deleted. See
//! MIGRATION_PLAN.md Phase 2.
//!
//! # Format notes (from `git status` docs, as the original recorded them)
//!
//! In the `-z` format the `->` is omitted from rename entries and the field order is reversed
//! (`from -> to` becomes `to from`); a NUL follows each filename, replacing space as the field
//! separator and the terminating newline (a space still separates the status field from the first
//! filename); and filenames containing special characters are **not** quoted or backslash-escaped.
//! That last point is why paths must be NUL-delimited: a path may contain a newline, which the
//! tests exercise.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::GitError;

/// A single-character index/working-tree state from porcelain output.
///
/// Serializes to the same single-character values as the ported
/// `src/models/status.ts` enum, so the existing TypeScript type is reused rather than duplicated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitStatusEntry {
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "C")]
    Copied,
    #[serde(rename = ".")]
    Unchanged,
    #[serde(rename = "?")]
    Untracked,
    #[serde(rename = "!")]
    Ignored,
    #[serde(rename = "U")]
    UpdatedButUnmerged,
}

impl GitStatusEntry {
    /// The character git uses for this state.
    pub fn as_char(self) -> char {
        match self {
            Self::Modified => 'M',
            Self::Added => 'A',
            Self::Deleted => 'D',
            Self::Renamed => 'R',
            Self::Copied => 'C',
            Self::Unchanged => '.',
            Self::Untracked => '?',
            Self::Ignored => '!',
            Self::UpdatedButUnmerged => 'U',
        }
    }
}

/// How a submodule differs, decoded from the four-character `S<c><m><u>` code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleStatus {
    /// The submodule's checked-out commit differs from the one recorded in the superproject.
    pub commit_changed: bool,
    /// The submodule has modified tracked files.
    pub modified_changes: bool,
    /// The submodule has untracked files.
    pub untracked_changes: bool,
}

/// Which side did what, for a conflicted entry.
///
/// Serializes to the kebab-case values the ported TypeScript enum uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnmergedEntrySummary {
    AddedByUs,
    DeletedByUs,
    AddedByThem,
    DeletedByThem,
    BothDeleted,
    BothAdded,
    BothModified,
}

/// How an ordinary (non-renamed, non-conflicted) change should be presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrdinaryChange {
    Added,
    Modified,
    Deleted,
}

/// A status code interpreted into something the app can act on.
///
/// `index` and `working_tree` are optional because the catch-all case can't determine them — see
/// the fallback at the end of [`map_status`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEntry {
    Untracked {
        submodule_status: Option<SubmoduleStatus>,
    },
    Ordinary {
        change: OrdinaryChange,
        index: Option<GitStatusEntry>,
        working_tree: Option<GitStatusEntry>,
        submodule_status: Option<SubmoduleStatus>,
    },
    Renamed {
        index: Option<GitStatusEntry>,
        working_tree: Option<GitStatusEntry>,
        rename_or_copy_score: Option<u32>,
        submodule_status: Option<SubmoduleStatus>,
    },
    Copied {
        index: Option<GitStatusEntry>,
        working_tree: Option<GitStatusEntry>,
        submodule_status: Option<SubmoduleStatus>,
    },
    Conflicted {
        action: UnmergedEntrySummary,
        us: GitStatusEntry,
        them: GitStatusEntry,
        submodule_status: Option<SubmoduleStatus>,
    },
}

/// A parsed status entry for one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Path relative to the repository root.
    pub path: String,
    /// The two-character status code, e.g. `.M`.
    pub status_code: String,
    /// The four-character submodule status code, e.g. `N...` or `SCMU`.
    pub submodule_status_code: String,
    /// The previous path, for a rename or copy.
    pub old_path: Option<String>,
    /// The rename/copy similarity score, for a rename or copy.
    pub rename_or_copy_score: Option<u32>,
}

/// One item of porcelain output: either a `# ` header line or a file entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusItem {
    /// A header, with the leading `# ` stripped.
    Header(String),
    Entry(StatusEntry),
}

const CHANGED_ENTRY_TYPE: &str = "1";
const RENAMED_OR_COPIED_ENTRY_TYPE: &str = "2";
const UNMERGED_ENTRY_TYPE: &str = "u";
const UNTRACKED_ENTRY_TYPE: &str = "?";
const IGNORED_ENTRY_TYPE: &str = "!";

/// Parses `git status --porcelain=2 -z` output.
///
/// Takes bytes rather than a string because paths are arbitrary bytes on Unix. Each field is
/// decoded lossily, matching the original's `Buffer::toString()` — a path that isn't valid UTF-8
/// comes back with replacement characters rather than failing the whole parse.
pub fn parse_porcelain_status(output: &[u8]) -> Result<Vec<StatusItem>, GitError> {
    let tokens: Vec<String> = output
        .split(|byte| *byte == 0)
        .map(|token| String::from_utf8_lossy(token).into_owned())
        .collect();

    let mut items = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let field = &tokens[index];

        if field.starts_with("# ") && field.len() > 2 {
            items.push(StatusItem::Header(field[2..].to_owned()));
            index += 1;
            continue;
        }

        let entry_kind = field.get(0..1).unwrap_or_default();

        if entry_kind == CHANGED_ENTRY_TYPE {
            items.push(StatusItem::Entry(parse_changed_entry(field)?));
        } else if entry_kind == RENAMED_OR_COPIED_ENTRY_TYPE {
            // A rename/copy spans two NUL-delimited fields: the entry, then the original path.
            index += 1;
            let old_path = tokens.get(index).filter(|path| !path.is_empty());
            items.push(StatusItem::Entry(parse_renamed_or_copied_entry(
                field, old_path,
            )?));
        } else if entry_kind == UNMERGED_ENTRY_TYPE {
            items.push(StatusItem::Entry(parse_unmerged_entry(field)?));
        } else if entry_kind == UNTRACKED_ENTRY_TYPE {
            items.push(StatusItem::Entry(parse_untracked_entry(field)));
        } else if entry_kind == IGNORED_ENTRY_TYPE {
            // Ignored entries are discarded — the app never asks for --ignored.
        }

        index += 1;
    }

    Ok(items)
}

// `(?s)` so the trailing path group can span newlines, which the original spelled `[\s\S]*?`.
// Unquoted paths mean a path may legitimately contain one.

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
fn changed_entry_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?s)^1 ([MADRCUTX?!.]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) (.*?)$",
        )
        .expect("pattern is valid")
    })
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`
fn renamed_or_copied_entry_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?s)^2 ([MADRCUTX?!.]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([RC]\d+) (.*?)$",
        )
        .expect("pattern is valid")
    })
}

/// `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
fn unmerged_entry_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?s)^u ([DAU]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([a-f0-9]+) (.*?)$",
        )
        .expect("pattern is valid")
    })
}

fn parse_error(context: &str, field: &str) -> GitError {
    GitError::Parse {
        context: context.to_owned(),
        // The field is included because a parse failure here almost always means git emitted a
        // shape we don't handle, and the raw line is the only way to diagnose that.
        message: format!("failed to parse status line: {field:?}"),
    }
}

fn parse_changed_entry(field: &str) -> Result<StatusEntry, GitError> {
    let captures = changed_entry_pattern()
        .captures(field)
        .ok_or_else(|| parse_error("parseChangedEntry", field))?;

    Ok(StatusEntry {
        status_code: captures[1].to_owned(),
        submodule_status_code: captures[2].to_owned(),
        path: captures[8].to_owned(),
        old_path: None,
        rename_or_copy_score: None,
    })
}

fn parse_renamed_or_copied_entry(
    field: &str,
    old_path: Option<&String>,
) -> Result<StatusEntry, GitError> {
    let captures = renamed_or_copied_entry_pattern()
        .captures(field)
        .ok_or_else(|| parse_error("parseRenamedOrCopiedEntry", field))?;

    let old_path = old_path.ok_or_else(|| GitError::Parse {
        context: "parseRenamedOrCopiedEntry".to_owned(),
        message: "a rename or copy entry was not followed by its original path".to_owned(),
    })?;

    // Group 8 is the score prefixed by R or C, e.g. "R100"; the digits are the similarity index.
    let score = captures[8][1..]
        .parse::<u32>()
        .map_err(|e| GitError::Parse {
            context: "parseRenamedOrCopiedEntry".to_owned(),
            message: format!(
                "could not parse rename/copy score from {:?}: {e}",
                &captures[8]
            ),
        })?;

    Ok(StatusEntry {
        status_code: captures[1].to_owned(),
        submodule_status_code: captures[2].to_owned(),
        path: captures[9].to_owned(),
        old_path: Some(old_path.clone()),
        rename_or_copy_score: Some(score),
    })
}

fn parse_unmerged_entry(field: &str) -> Result<StatusEntry, GitError> {
    let captures = unmerged_entry_pattern()
        .captures(field)
        .ok_or_else(|| parse_error("parseUnmergedEntry", field))?;

    Ok(StatusEntry {
        status_code: captures[1].to_owned(),
        submodule_status_code: captures[2].to_owned(),
        path: captures[10].to_owned(),
        old_path: None,
        rename_or_copy_score: None,
    })
}

fn parse_untracked_entry(field: &str) -> StatusEntry {
    StatusEntry {
        // Deliberately `??` rather than `?`, and `????` rather than the real submodule code: the
        // original notes this is to play nicely with `map_status`, and flags it as something worth
        // reconsidering. Kept as-is so the two stay in agreement.
        status_code: "??".to_owned(),
        submodule_status_code: "????".to_owned(),
        path: field.get(2..).unwrap_or_default().to_owned(),
        old_path: None,
        rename_or_copy_score: None,
    }
}

/// Decodes the four-character submodule code, or `None` when the path isn't a submodule (`N...`).
fn map_submodule_status(submodule_status_code: &str) -> Option<SubmoduleStatus> {
    if !submodule_status_code.starts_with('S') {
        return None;
    }

    let at = |index: usize| submodule_status_code.chars().nth(index);
    Some(SubmoduleStatus {
        commit_changed: at(1) == Some('C'),
        modified_changes: at(2) == Some('M'),
        untracked_changes: at(3) == Some('U'),
    })
}

/// Interprets a raw status code into a [`FileEntry`].
///
/// The final catch-all assumes "modified in some way", matching the original — an unrecognized
/// code shouldn't make a file invisible in the UI.
pub fn map_status(
    status_code: &str,
    submodule_status_code: &str,
    rename_or_copy_score: Option<u32>,
) -> FileEntry {
    let submodule_status = map_submodule_status(submodule_status_code);

    let ordinary = |change: OrdinaryChange, index, working_tree| FileEntry::Ordinary {
        change,
        index: Some(index),
        working_tree: Some(working_tree),
        submodule_status,
    };
    let conflicted = |action, us, them| FileEntry::Conflicted {
        action,
        us,
        them,
        submodule_status,
    };

    use GitStatusEntry as G;
    use OrdinaryChange as O;
    use UnmergedEntrySummary as U;

    match status_code {
        "??" => FileEntry::Untracked { submodule_status },

        ".M" => ordinary(O::Modified, G::Unchanged, G::Modified),
        "M." => ordinary(O::Modified, G::Modified, G::Unchanged),
        ".A" => ordinary(O::Added, G::Unchanged, G::Added),
        "A." => ordinary(O::Added, G::Added, G::Unchanged),
        ".D" => ordinary(O::Deleted, G::Unchanged, G::Deleted),
        "D." => ordinary(O::Deleted, G::Deleted, G::Unchanged),
        "AD" => ordinary(O::Added, G::Added, G::Deleted),
        "AM" => ordinary(O::Added, G::Added, G::Modified),

        "R." => FileEntry::Renamed {
            index: Some(G::Renamed),
            working_tree: Some(G::Unchanged),
            rename_or_copy_score,
            submodule_status,
        },
        ".R" => FileEntry::Renamed {
            index: Some(G::Unchanged),
            working_tree: Some(G::Renamed),
            rename_or_copy_score,
            submodule_status,
        },
        "RM" => FileEntry::Renamed {
            index: Some(G::Renamed),
            working_tree: Some(G::Modified),
            rename_or_copy_score,
            submodule_status,
        },
        "RD" => FileEntry::Renamed {
            index: Some(G::Renamed),
            working_tree: Some(G::Deleted),
            rename_or_copy_score,
            submodule_status,
        },

        "C." => FileEntry::Copied {
            index: Some(G::Copied),
            working_tree: Some(G::Unchanged),
            submodule_status,
        },
        ".C" => FileEntry::Copied {
            index: Some(G::Unchanged),
            working_tree: Some(G::Copied),
            submodule_status,
        },

        "DD" => conflicted(U::BothDeleted, G::Deleted, G::Deleted),
        "AU" => conflicted(U::AddedByUs, G::Added, G::UpdatedButUnmerged),
        "UD" => conflicted(U::DeletedByThem, G::UpdatedButUnmerged, G::Deleted),
        "UA" => conflicted(U::AddedByThem, G::UpdatedButUnmerged, G::Added),
        "DU" => conflicted(U::DeletedByUs, G::Deleted, G::UpdatedButUnmerged),
        "AA" => conflicted(U::BothAdded, G::Added, G::Added),
        "UU" => conflicted(
            U::BothModified,
            G::UpdatedButUnmerged,
            G::UpdatedButUnmerged,
        ),

        // Fallback: assume the file is modified in some way, with the index and working tree
        // states left unknown.
        _ => FileEntry::Ordinary {
            change: O::Modified,
            index: None,
            working_tree: None,
            submodule_status,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses a `\0`-joined string, as the TypeScript test helper did.
    fn parse(input: &str) -> Vec<StatusItem> {
        parse_porcelain_status(input.as_bytes()).expect("well-formed output should parse")
    }

    fn entries(items: Vec<StatusItem>) -> Vec<StatusEntry> {
        items
            .into_iter()
            .filter_map(|item| match item {
                StatusItem::Entry(entry) => Some(entry),
                StatusItem::Header(_) => None,
            })
            .collect()
    }

    // --- ported from src/lib/status-parser.test.ts ---

    #[test]
    fn parses_a_standard_status() {
        let entries = entries(parse(&([
            "1 .D N... 100644 100644 000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 deleted",
            "1 .M N... 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 modified",
            "? untracked",
        ].join("\0") + "\0")));

        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].status_code, ".D");
        assert_eq!(entries[0].path, "deleted");

        assert_eq!(entries[1].status_code, ".M");
        assert_eq!(entries[1].path, "modified");

        assert_eq!(entries[2].status_code, "??");
        assert_eq!(entries[2].path, "untracked");
    }

    #[test]
    fn parses_renames() {
        let entries = entries(parse(&([
            "2 R. N... 100644 100644 100644 2de0487c2d3e977f5f560b746833f9d7f9a054fd 2de0487c2d3e977f5f560b746833f9d7f9a054fd R100 new\0old",
            "2 RM N... 100644 100644 100644 a3cba7afce66ef37a228e094273c27141db21f36 a3cba7afce66ef37a228e094273c27141db21f36 R100 to\0from",
        ].join("\0") + "\0")));

        assert_eq!(entries.len(), 2);

        assert_eq!(entries[0].status_code, "R.");
        assert_eq!(entries[0].path, "new");
        assert_eq!(entries[0].old_path.as_deref(), Some("old"));

        assert_eq!(entries[1].status_code, "RM");
        assert_eq!(entries[1].path, "to");
        assert_eq!(entries[1].old_path.as_deref(), Some("from"));
    }

    #[test]
    fn ignores_ignored_files() {
        // The app never passes --ignored, but the original tested it all the same.
        assert!(entries(parse("! foo\0")).is_empty());
    }

    #[test]
    fn parses_status_headers() {
        let items = parse(
            &[
                "# branch.oid 2de0487c2d3e977f5f560b746833f9d7f9a054fd",
                "# branch.head main",
                "# branch.upstream origin/main",
                "# branch.ab +1 -0",
            ]
            .join("\0"),
        );

        let headers: Vec<String> = items
            .into_iter()
            .filter_map(|item| match item {
                StatusItem::Header(value) => Some(value),
                StatusItem::Entry(_) => None,
            })
            .collect();

        assert_eq!(
            headers,
            [
                "branch.oid 2de0487c2d3e977f5f560b746833f9d7f9a054fd",
                "branch.head main",
                "branch.upstream origin/main",
                "branch.ab +1 -0",
            ]
        );
    }

    #[test]
    fn parses_a_path_which_includes_a_newline() {
        // Paths are unquoted in -z mode, so a newline in a path is data, not a delimiter. This is
        // the case the `(?s)` flag exists for.
        let path =
            "ProjectSID/Images.xcassets/iPhone 67/Status Center/Report X68 Y461\n      /.DS_Store";
        let input = format!(
            "1 D. N... 100644 000000 000000 dc9fb24e86f7445720b39dcb39a7fc0e410d9583 0000000000000000000000000000000000000000 {path}"
        );

        let entries = entries(parse(&input));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, path);
        assert_eq!(entries[0].status_code, "D.");
    }

    #[test]
    fn parses_a_typechange() {
        let entries = entries(parse(
            "1 .T N... 120000 120000 100755 6165716e8b408ad09b51d1a37aa1ef50e7f84376 6165716e8b408ad09b51d1a37aa1ef50e7f84376 pdf_linux-x64/lib/libQt5Core.so.5",
        ));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "pdf_linux-x64/lib/libQt5Core.so.5");
        assert_eq!(entries[0].status_code, ".T");
    }

    #[test]
    fn parses_submodule_changes() {
        let entries = entries(parse(
            "1 .M SCMU 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 submodule/submodule",
        ));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "submodule/submodule");
        assert_eq!(entries[0].submodule_status_code, "SCMU");
    }

    // --- additional coverage the original lacked ---

    #[test]
    fn parses_an_unmerged_entry() {
        let entries = entries(parse(
            "u UU N... 100644 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 conflicted\0",
        ));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status_code, "UU");
        assert_eq!(entries[0].path, "conflicted");
    }

    #[test]
    fn records_the_rename_similarity_score() {
        let entries = entries(parse(
            "2 R. N... 100644 100644 100644 2de0487c2d3e977f5f560b746833f9d7f9a054fd 2de0487c2d3e977f5f560b746833f9d7f9a054fd R87 new\0old\0",
        ));

        assert_eq!(entries[0].rename_or_copy_score, Some(87));
    }

    #[test]
    fn reports_an_error_for_a_malformed_entry() {
        // The original threw here; surfacing it as an error rather than skipping the line means a
        // porcelain shape we don't handle can't silently vanish from the UI.
        let error = parse_porcelain_status(b"1 this is not a status line\0")
            .expect_err("a malformed entry should be an error");
        assert!(matches!(error, GitError::Parse { .. }), "got {error:?}");
    }

    #[test]
    fn reports_an_error_when_a_rename_is_missing_its_original_path() {
        let error = parse_porcelain_status(
            b"2 R. N... 100644 100644 100644 2de0487c2d3e977f5f560b746833f9d7f9a054fd 2de0487c2d3e977f5f560b746833f9d7f9a054fd R100 new\0",
        )
        .expect_err("a rename without its original path should be an error");
        assert!(matches!(error, GitError::Parse { .. }), "got {error:?}");
    }

    #[test]
    fn parses_empty_output_as_nothing() {
        assert!(parse_porcelain_status(b"")
            .expect("empty output should parse")
            .is_empty());
    }

    // --- map_status ---

    #[test]
    fn maps_untracked() {
        assert_eq!(
            map_status("??", "????", None),
            FileEntry::Untracked {
                submodule_status: None
            }
        );
    }

    #[test]
    fn maps_ordinary_changes_with_index_and_working_tree_states() {
        assert_eq!(
            map_status(".M", "N...", None),
            FileEntry::Ordinary {
                change: OrdinaryChange::Modified,
                index: Some(GitStatusEntry::Unchanged),
                working_tree: Some(GitStatusEntry::Modified),
                submodule_status: None,
            }
        );
        assert_eq!(
            map_status("D.", "N...", None),
            FileEntry::Ordinary {
                change: OrdinaryChange::Deleted,
                index: Some(GitStatusEntry::Deleted),
                working_tree: Some(GitStatusEntry::Unchanged),
                submodule_status: None,
            }
        );
    }

    #[test]
    fn maps_renames_carrying_the_score() {
        assert_eq!(
            map_status("RM", "N...", Some(100)),
            FileEntry::Renamed {
                index: Some(GitStatusEntry::Renamed),
                working_tree: Some(GitStatusEntry::Modified),
                rename_or_copy_score: Some(100),
                submodule_status: None,
            }
        );
    }

    #[test]
    fn maps_every_conflict_code() {
        use GitStatusEntry as G;
        use UnmergedEntrySummary as U;

        for (code, action, us, them) in [
            ("DD", U::BothDeleted, G::Deleted, G::Deleted),
            ("AU", U::AddedByUs, G::Added, G::UpdatedButUnmerged),
            ("UD", U::DeletedByThem, G::UpdatedButUnmerged, G::Deleted),
            ("UA", U::AddedByThem, G::UpdatedButUnmerged, G::Added),
            ("DU", U::DeletedByUs, G::Deleted, G::UpdatedButUnmerged),
            ("AA", U::BothAdded, G::Added, G::Added),
            (
                "UU",
                U::BothModified,
                G::UpdatedButUnmerged,
                G::UpdatedButUnmerged,
            ),
        ] {
            assert_eq!(
                map_status(code, "N...", None),
                FileEntry::Conflicted {
                    action,
                    us,
                    them,
                    submodule_status: None,
                },
                "for status code {code:?}"
            );
        }
    }

    #[test]
    fn falls_back_to_modified_for_an_unrecognized_code() {
        // An unknown code must still produce a visible change rather than nothing.
        assert_eq!(
            map_status(".T", "N...", None),
            FileEntry::Ordinary {
                change: OrdinaryChange::Modified,
                index: None,
                working_tree: None,
                submodule_status: None,
            }
        );
    }

    #[test]
    fn decodes_the_submodule_status_code() {
        assert_eq!(
            map_submodule_status("SCMU"),
            Some(SubmoduleStatus {
                commit_changed: true,
                modified_changes: true,
                untracked_changes: true,
            })
        );
        assert_eq!(
            map_submodule_status("SC.."),
            Some(SubmoduleStatus {
                commit_changed: true,
                modified_changes: false,
                untracked_changes: false,
            })
        );
        assert_eq!(
            map_submodule_status("S.MU"),
            Some(SubmoduleStatus {
                commit_changed: false,
                modified_changes: true,
                untracked_changes: true,
            })
        );
    }

    #[test]
    fn reports_no_submodule_status_for_a_regular_path() {
        assert_eq!(map_submodule_status("N..."), None);
    }

    #[test]
    fn carries_the_submodule_status_through_map_status() {
        assert_eq!(
            map_status(".M", "SCMU", None),
            FileEntry::Ordinary {
                change: OrdinaryChange::Modified,
                index: Some(GitStatusEntry::Unchanged),
                working_tree: Some(GitStatusEntry::Modified),
                submodule_status: Some(SubmoduleStatus {
                    commit_changed: true,
                    modified_changes: true,
                    untracked_changes: true,
                }),
            }
        );
    }

    #[test]
    fn status_entry_characters_round_trip() {
        for (entry, expected) in [
            (GitStatusEntry::Modified, 'M'),
            (GitStatusEntry::Added, 'A'),
            (GitStatusEntry::Deleted, 'D'),
            (GitStatusEntry::Renamed, 'R'),
            (GitStatusEntry::Copied, 'C'),
            (GitStatusEntry::Unchanged, '.'),
            (GitStatusEntry::Untracked, '?'),
            (GitStatusEntry::Ignored, '!'),
            (GitStatusEntry::UpdatedButUnmerged, 'U'),
        ] {
            assert_eq!(entry.as_char(), expected);
        }
    }
}
