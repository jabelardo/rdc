//! Building unified diffs for `git apply`.
//!
//! Ported from `desktop-plus/app/src/lib/patch-formatter.ts`, whose only consumer was `lib/git/apply.ts`
//! — so the same fork `status-parser` and `diff-parser` settled applies, and it lands in Rust. It was
//! never ported to TypeScript, so nothing is deleted here.
//!
//! # What makes this the hard part of partial staging
//!
//! Staging *some* lines of a file means handing git a patch that describes only those lines — and the
//! patch has to be internally consistent, because `git apply` will reject one whose hunk headers don't
//! match its body. Every rule below exists to keep that arithmetic right:
//!
//! - An **unselected addition** is dropped entirely: as far as this patch is concerned the line was never
//!   added.
//! - An **unselected deletion** becomes a *context* line: the patch is claiming the line is still there,
//!   so it counts toward both sides.
//! - In a **new or untracked file**, an unselected line is dropped outright. Such a file is all additions,
//!   so there is no "old" side for a context line to belong to.
//! - A hunk with no surviving additions or deletions is **omitted**, since a hunk of pure context changes
//!   nothing and git would reject the empty result.
//!
//! # The line selection is view state
//!
//! Which lines are ticked lives in the UI's `DiffSelection`, so it has to cross the boundary. It arrives
//! as [`LineSelection`] — the absolute indices of selected lines, where an index counts **from the start
//! of the diff including hunk header lines**, matching the original's
//! `hunk.unifiedDiffStart + lineIndex`.

use std::collections::HashSet;

use crate::diff::TextDiffData;
use crate::diff_parser::DiffLineType;
use crate::error::GitError;
use crate::status::AppFileStatus;

/// The lines a user ticked, by absolute index into the diff.
///
/// An index counts every line of the diff in order, hunk headers included — that is what the original's
/// `hunk.unifiedDiffStart + lineIndex` produces, and the two must agree or the wrong lines get staged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineSelection {
    selected: HashSet<u32>,
}

impl LineSelection {
    /// Builds a selection from absolute line indices.
    pub fn new(selected: impl IntoIterator<Item = u32>) -> Self {
        Self {
            selected: selected.into_iter().collect(),
        }
    }

    pub fn is_selected(&self, index: u32) -> bool {
        self.selected.contains(&index)
    }

    pub fn is_empty(&self) -> bool {
        self.selected.is_empty()
    }
}

/// Renders a unified diff file header.
///
/// `None` means the file doesn't exist on that side, which git spells `/dev/null`. The timestamps the
/// format allows are omitted, as git itself omits them.
fn format_patch_header(from: Option<&str>, to: Option<&str>) -> String {
    let from_path = from.map_or_else(|| "/dev/null".to_owned(), |path| format!("a/{path}"));
    let to_path = to.map_or_else(|| "/dev/null".to_owned(), |path| format!("b/{path}"));

    format!("--- {from_path}\n+++ {to_path}\n")
}

/// The header for a file in a given state.
///
/// A **renamed** file diffs against its *new* path on both sides, which looks wrong and isn't: `git diff`
/// shows a rename as old→new, but this patch is applied *alongside* the rename that
/// [`crate::apply::apply_patch_to_index`] has already staged, so the content change targets the file
/// where it now lives.
fn format_patch_header_for_file(path: &str, status: &AppFileStatus) -> String {
    match status {
        // A new file has no old side.
        AppFileStatus::New { .. } | AppFileStatus::Untracked { .. } => {
            format_patch_header(None, Some(path))
        }
        _ => format_patch_header(Some(path), Some(path)),
    }
}

/// Renders a hunk header.
///
/// A count of exactly 1 is omitted, which is the unified-diff convention git follows: `@@ -3 +3 @@` rather
/// than `@@ -3,1 +3,1 @@`.
fn format_hunk_header(old_start: u32, old_count: u32, new_start: u32, new_count: u32) -> String {
    let before = if old_count == 1 {
        old_start.to_string()
    } else {
        format!("{old_start},{old_count}")
    };
    let after = if new_count == 1 {
        new_start.to_string()
    } else {
        format!("{new_start},{new_count}")
    };

    format!("@@ -{before} +{after} @@\n")
}

/// The marker git uses for a file whose last line has no newline.
const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file\n";

/// Builds a patch that stages only the selected lines.
///
/// Fails when the selection produces nothing to apply. That is deliberately an error rather than an empty
/// patch: being called at all means the caller believed there was something to stage, so an empty result
/// means the diff and the selection disagree — and `git apply` would reject it anyway, less clearly.
pub fn format_patch(
    path: &str,
    status: &AppFileStatus,
    diff: &TextDiffData,
    selection: &LineSelection,
) -> Result<String, GitError> {
    let is_new_file = matches!(
        status,
        AppFileStatus::New { .. } | AppFileStatus::Untracked { .. }
    );

    let mut patch = String::new();

    for hunk in &diff.hunks {
        let mut body = String::new();
        let mut old_count = 0;
        let mut new_count = 0;
        let mut any_changes = false;

        for (offset, line) in hunk.lines.iter().enumerate() {
            let index = hunk.unified_diff_start + u32::try_from(offset).unwrap_or(u32::MAX);

            // Hunk headers are rewritten below, so the original is skipped.
            if line.line_type == DiffLineType::Hunk {
                continue;
            }

            let mut emitted_line = true;

            if line.line_type == DiffLineType::Context {
                body.push_str(&line.text);
                body.push('\n');
                old_count += 1;
                new_count += 1;
            } else if selection.is_selected(index) {
                body.push_str(&line.text);
                body.push('\n');

                match line.line_type {
                    DiffLineType::Add => new_count += 1,
                    DiffLineType::Delete => old_count += 1,
                    _ => {}
                }
                any_changes = true;
            } else if is_new_file {
                // Nothing to fall back to: the whole file is additions.
                emitted_line = false;
            } else if line.line_type == DiffLineType::Add {
                // Pretend it was never added.
                emitted_line = false;
            } else if line.line_type == DiffLineType::Delete {
                // Pretend it is still there, so it belongs to both sides.
                body.push(' ');
                body.push_str(&line.text[1..]);
                body.push('\n');
                old_count += 1;
                new_count += 1;
            }

            // Only for a line that survived — the marker describes that line, so dropping the line drops
            // the marker with it.
            if emitted_line && line.no_trailing_new_line {
                body.push_str(NO_NEWLINE_MARKER);
            }
        }

        // A hunk of pure context changes nothing, and git would reject it.
        if !any_changes {
            continue;
        }

        patch.push_str(&format_hunk_header(
            hunk.header.old_start_line,
            old_count,
            hunk.header.new_start_line,
            new_count,
        ));
        patch.push_str(&body);
    }

    if patch.is_empty() {
        return Err(GitError::Parse {
            context: "formatPatch".to_owned(),
            message: format!("could not generate a patch for {path}: no changes were selected"),
        });
    }

    Ok(format!(
        "{}{patch}",
        format_patch_header_for_file(path, status)
    ))
}

/// Builds a patch that *undoes* the selected lines, for applying to the working tree.
///
/// The inverse of [`format_patch`], and the reversal is why the rules differ:
///
/// - A selected **addition** becomes a deletion, and a selected **deletion** becomes an addition.
/// - An **unselected addition** stays, so it becomes a context line — it will still be in the file
///   afterwards.
/// - An **unselected deletion** is dropped: it isn't in the working copy, so this patch has nothing to say
///   about it.
///
/// The hunk header's sides are **swapped** for the same reason: the working copy is this patch's *old*
/// side.
///
/// Returns `None` for an empty selection rather than failing, unlike [`format_patch`]. Discarding nothing
/// is a legitimate no-op — the original returned `null` and the caller skipped the apply.
pub fn format_patch_to_discard_changes(
    path: &str,
    diff: &TextDiffData,
    selection: &LineSelection,
) -> Option<String> {
    let mut patch = String::new();

    for hunk in &diff.hunks {
        let mut body = String::new();
        let mut old_count = 0;
        let mut new_count = 0;
        let mut any_changes = false;

        for (offset, line) in hunk.lines.iter().enumerate() {
            let index = hunk.unified_diff_start + u32::try_from(offset).unwrap_or(u32::MAX);

            if line.line_type == DiffLineType::Hunk {
                continue;
            }

            let mut emitted_line = true;

            if line.line_type == DiffLineType::Context {
                body.push_str(&line.text);
                body.push('\n');
                old_count += 1;
                new_count += 1;
            } else if selection.is_selected(index) {
                match line.line_type {
                    DiffLineType::Add => {
                        // It exists in the working copy and must go.
                        body.push('-');
                        body.push_str(&line.text[1..]);
                        body.push('\n');
                        new_count += 1;
                    }
                    DiffLineType::Delete => {
                        // It was removed and must come back.
                        body.push('+');
                        body.push_str(&line.text[1..]);
                        body.push('\n');
                        old_count += 1;
                    }
                    _ => emitted_line = false,
                }
                any_changes = true;
            } else if line.line_type == DiffLineType::Add {
                // Staying put, so it is context for this patch.
                body.push(' ');
                body.push_str(&line.text[1..]);
                body.push('\n');
                old_count += 1;
                new_count += 1;
            } else {
                // An unselected deletion isn't in the working copy at all.
                emitted_line = false;
            }

            if emitted_line && line.no_trailing_new_line {
                body.push_str(NO_NEWLINE_MARKER);
            }
        }

        if !any_changes {
            continue;
        }

        // Swapped: the working copy is the old side of a reversing patch.
        patch.push_str(&format_hunk_header(
            hunk.header.new_start_line,
            new_count,
            hunk.header.old_start_line,
            old_count,
        ));
        patch.push_str(&body);
    }

    if patch.is_empty() {
        return None;
    }

    Some(format!(
        "{}{patch}",
        format_patch_header(Some(path), Some(path))
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff_parser::{DiffHunk, DiffHunkExpansionType, DiffHunkHeader, DiffLine};

    fn line(text: &str, line_type: DiffLineType, old: Option<u32>, new: Option<u32>) -> DiffLine {
        DiffLine {
            text: text.to_owned(),
            line_type,
            original_line_number: None,
            old_line_number: old,
            new_line_number: new,
            no_trailing_new_line: false,
        }
    }

    /// A one-hunk diff whose lines start at absolute index 0 (the hunk header).
    fn diff(lines: Vec<DiffLine>, header: DiffHunkHeader) -> TextDiffData {
        let count = u32::try_from(lines.len()).expect("small");
        TextDiffData {
            text: String::new(),
            hunks: vec![DiffHunk {
                header,
                lines,
                unified_diff_start: 0,
                unified_diff_end: count - 1,
                expansion_type: DiffHunkExpansionType::None,
            }],
            line_endings_change: None,
            max_line_number: 0,
            has_hidden_bidi_chars: false,
        }
    }

    fn modified() -> AppFileStatus {
        AppFileStatus::Modified {
            submodule_status: None,
        }
    }

    fn untracked() -> AppFileStatus {
        AppFileStatus::Untracked {
            submodule_status: None,
        }
    }

    /// The classic one-line change: context, a deletion, an addition, context.
    fn simple_diff() -> TextDiffData {
        diff(
            vec![
                line("@@ -1,3 +1,3 @@", DiffLineType::Hunk, None, None),
                line(" first", DiffLineType::Context, Some(1), Some(1)),
                line("-old", DiffLineType::Delete, Some(2), None),
                line("+new", DiffLineType::Add, None, Some(2)),
                line(" last", DiffLineType::Context, Some(3), Some(3)),
            ],
            DiffHunkHeader {
                old_start_line: 1,
                old_line_count: 3,
                new_start_line: 1,
                new_line_count: 3,
            },
        )
    }

    // --- headers ---

    #[test]
    fn a_new_file_has_no_old_side() {
        assert_eq!(
            format_patch_header_for_file("new.txt", &untracked()),
            "--- /dev/null\n+++ b/new.txt\n"
        );
    }

    #[test]
    fn a_renamed_file_targets_its_new_path_on_both_sides() {
        // Looks wrong, isn't: the patch is applied *alongside* the staged rename, so the content change
        // has to target where the file now lives.
        let renamed = AppFileStatus::Renamed {
            old_path: "before.txt".to_owned(),
            submodule_status: None,
            rename_includes_modifications: true,
        };

        assert_eq!(
            format_patch_header_for_file("after.txt", &renamed),
            "--- a/after.txt\n+++ b/after.txt\n"
        );
    }

    #[test]
    fn omits_a_line_count_of_one() {
        // git's convention: `@@ -3 +3 @@`, not `@@ -3,1 +3,1 @@`.
        assert_eq!(format_hunk_header(3, 1, 3, 1), "@@ -3 +3 @@\n");
        assert_eq!(format_hunk_header(1, 3, 1, 4), "@@ -1,3 +1,4 @@\n");
    }

    // --- staging a selection ---

    #[test]
    fn stages_both_sides_of_a_fully_selected_change() {
        // Indices 2 and 3 are the delete and the add.
        let patch = format_patch(
            "a.txt",
            &modified(),
            &simple_diff(),
            &LineSelection::new([2, 3]),
        )
        .expect("should format");

        assert_eq!(
            patch,
            concat!(
                "--- a/a.txt\n",
                "+++ b/a.txt\n",
                "@@ -1,3 +1,3 @@\n",
                " first\n",
                "-old\n",
                "+new\n",
                " last\n",
            )
        );
    }

    #[test]
    fn turns_an_unselected_deletion_into_context() {
        // Only the addition is staged, so the patch has to claim the old line is still present —
        // otherwise its line counts wouldn't add up and git would reject it.
        let patch = format_patch(
            "a.txt",
            &modified(),
            &simple_diff(),
            &LineSelection::new([3]),
        )
        .expect("should format");

        assert!(
            patch.contains(" old\n"),
            "the deletion became context: {patch}"
        );
        assert!(!patch.contains("-old\n"));
        // Four lines on the old side now: first, old-as-context, last... plus the new line on the new
        // side only.
        assert!(patch.contains("@@ -1,3 +1,4 @@\n"), "got {patch}");
    }

    #[test]
    fn drops_an_unselected_addition() {
        let patch = format_patch(
            "a.txt",
            &modified(),
            &simple_diff(),
            &LineSelection::new([2]),
        )
        .expect("should format");

        assert!(!patch.contains("+new"), "got {patch}");
        assert!(patch.contains("-old\n"));
        assert!(patch.contains("@@ -1,3 +1,2 @@\n"), "got {patch}");
    }

    #[test]
    fn drops_unselected_lines_entirely_in_a_new_file() {
        // A new file is all additions, so there is no old side for a context line to belong to.
        let new_file = diff(
            vec![
                line("@@ -0,0 +1,2 @@", DiffLineType::Hunk, None, None),
                line("+one", DiffLineType::Add, None, Some(1)),
                line("+two", DiffLineType::Add, None, Some(2)),
            ],
            DiffHunkHeader {
                old_start_line: 0,
                old_line_count: 0,
                new_start_line: 1,
                new_line_count: 2,
            },
        );

        let patch = format_patch("new.txt", &untracked(), &new_file, &LineSelection::new([1]))
            .expect("should format");

        assert_eq!(
            patch,
            concat!(
                "--- /dev/null\n",
                "+++ b/new.txt\n",
                "@@ -0,0 +1 @@\n",
                "+one\n",
            ),
            "the unselected addition is absent entirely"
        );
    }

    #[test]
    fn omits_a_hunk_with_nothing_selected() {
        let two_hunks = TextDiffData {
            hunks: vec![
                DiffHunk {
                    header: DiffHunkHeader {
                        old_start_line: 1,
                        old_line_count: 2,
                        new_start_line: 1,
                        new_line_count: 2,
                    },
                    lines: vec![
                        line("@@ -1,2 +1,2 @@", DiffLineType::Hunk, None, None),
                        line(" ctx", DiffLineType::Context, Some(1), Some(1)),
                        line("+one", DiffLineType::Add, None, Some(2)),
                    ],
                    unified_diff_start: 0,
                    unified_diff_end: 2,
                    expansion_type: DiffHunkExpansionType::None,
                },
                DiffHunk {
                    header: DiffHunkHeader {
                        old_start_line: 10,
                        old_line_count: 2,
                        new_start_line: 10,
                        new_line_count: 2,
                    },
                    lines: vec![
                        line("@@ -10,2 +10,2 @@", DiffLineType::Hunk, None, None),
                        line(" ctx", DiffLineType::Context, Some(10), Some(10)),
                        line("+two", DiffLineType::Add, None, Some(11)),
                    ],
                    unified_diff_start: 3,
                    unified_diff_end: 5,
                    expansion_type: DiffHunkExpansionType::None,
                },
            ],
            text: String::new(),
            line_endings_change: None,
            max_line_number: 0,
            has_hidden_bidi_chars: false,
        };

        // Only the second hunk's addition, at absolute index 5.
        let patch = format_patch("a.txt", &modified(), &two_hunks, &LineSelection::new([5]))
            .expect("should format");

        assert!(!patch.contains("+one"), "got {patch}");
        assert!(patch.contains("+two"), "got {patch}");
        assert!(
            !patch.contains("@@ -1,2"),
            "the untouched hunk should be omitted: {patch}"
        );
    }

    #[test]
    fn refuses_to_build_a_patch_from_an_empty_selection() {
        // Being called means the caller believed there was something to stage, so this disagreement is
        // worth reporting — and git apply would reject the empty result anyway, less clearly.
        assert!(matches!(
            format_patch(
                "a.txt",
                &modified(),
                &simple_diff(),
                &LineSelection::default()
            ),
            Err(GitError::Parse { .. })
        ));
    }

    #[test]
    fn keeps_a_no_newline_marker_for_a_line_that_survives() {
        let mut with_marker = simple_diff();
        with_marker.hunks[0].lines[3].no_trailing_new_line = true;

        let patch = format_patch(
            "a.txt",
            &modified(),
            &with_marker,
            &LineSelection::new([2, 3]),
        )
        .expect("should format");

        assert!(
            patch.contains("\\ No newline at end of file\n"),
            "got {patch}"
        );
    }

    #[test]
    fn drops_the_no_newline_marker_with_the_line_it_describes() {
        // The marker belongs to a specific line, so dropping the line must drop the marker — leaving it
        // would attach it to whatever came before.
        let mut with_marker = simple_diff();
        with_marker.hunks[0].lines[3].no_trailing_new_line = true;

        let patch = format_patch("a.txt", &modified(), &with_marker, &LineSelection::new([2]))
            .expect("should format");

        assert!(!patch.contains("No newline"), "got {patch}");
    }

    // --- discarding a selection ---

    #[test]
    fn reverses_a_fully_selected_change() {
        let patch =
            format_patch_to_discard_changes("a.txt", &simple_diff(), &LineSelection::new([2, 3]))
                .expect("should format");

        assert_eq!(
            patch,
            concat!(
                "--- a/a.txt\n",
                "+++ b/a.txt\n",
                "@@ -1,3 +1,3 @@\n",
                " first\n",
                "+old\n",
                "-new\n",
                " last\n",
            ),
            "the addition is removed and the deletion restored"
        );
    }

    #[test]
    fn keeps_an_unselected_addition_as_context() {
        // It will still be in the file after the discard, so the patch has to account for it.
        let patch =
            format_patch_to_discard_changes("a.txt", &simple_diff(), &LineSelection::new([2]))
                .expect("should format");

        assert!(patch.contains(" new\n"), "got {patch}");
        assert!(patch.contains("+old\n"), "got {patch}");
    }

    #[test]
    fn drops_an_unselected_deletion() {
        // It isn't in the working copy, so this patch has nothing to say about it.
        let patch =
            format_patch_to_discard_changes("a.txt", &simple_diff(), &LineSelection::new([3]))
                .expect("should format");

        assert!(!patch.contains("old"), "got {patch}");
        assert!(patch.contains("-new\n"), "got {patch}");
    }

    #[test]
    fn discarding_nothing_is_a_no_op_rather_than_an_error() {
        // Unlike `format_patch`: an empty discard selection is a legitimate request to do nothing.
        assert_eq!(
            format_patch_to_discard_changes("a.txt", &simple_diff(), &LineSelection::default()),
            None
        );
    }

    #[test]
    fn swaps_the_hunk_header_sides_when_reversing() {
        // The working copy is the *old* side of a reversing patch, so the starts are crossed.
        let asymmetric = diff(
            vec![
                line("@@ -5,1 +9,2 @@", DiffLineType::Hunk, None, None),
                line("+added", DiffLineType::Add, None, Some(9)),
            ],
            DiffHunkHeader {
                old_start_line: 5,
                old_line_count: 1,
                new_start_line: 9,
                new_line_count: 2,
            },
        );

        let patch = format_patch_to_discard_changes("a.txt", &asymmetric, &LineSelection::new([1]))
            .expect("should format");

        assert!(
            patch.contains("@@ -9 +5,0 @@\n"),
            "the new start leads when reversing: {patch}"
        );
    }
}
