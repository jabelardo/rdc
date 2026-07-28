//! A parser for the GNU unified diff format.
//!
//! Ported from `src/lib/diff-parser.ts` (itself ported from
//! `desktop-plus/app/src/lib/diff-parser.ts`), using that module's tests as the specification.
//!
//! # Why this moved to Rust
//!
//! Exactly the fork `status` settled in Phase 2, with the same answer. `src/lib/diff-parser.ts` was
//! ported to TypeScript in Phase 1 and had **no importers except its own test** — `lib/git/diff.ts`
//! is destined for Rust, and the two can't both own parsing. Git execution and interpretation stay
//! together; the frontend receives structured hunks rather than raw unified-diff text.
//!
//! The TypeScript parser and its test are deleted. `src/models/diff/**` stays: those are the domain
//! types the UI renders, and `DiffSelection` operates on them. As with `WorkingDirectoryFileChange`
//! in `status`, the frontend hydrates its classes from this plain data.
//!
//! # Field shapes are not optional here
//!
//! Unlike `status`, the TypeScript classes declare `number | null` rather than `number?`, so these
//! types serialize **explicit nulls** rather than omitting absent values. `DiffLineType` is also a
//! *numeric* TypeScript enum, so it serializes as `0`–`3` and not as variant names. Both are pinned
//! by the wire snapshot.
//!
//! # Fidelity note on the scanning
//!
//! The pointer arithmetic below mirrors the original's `ls`/`le` line pointers rather than using an
//! idiomatic line iterator, because one of its behaviours is load-bearing and surprising: an **empty
//! line terminates the diff**. `nextLine` returns false when the line start equals the line end, so
//! a bare `\n` ends parsing. That is why a context line for a blank source line must be `" "` and
//! not `""` — the original's test suite has a helper whose entire job is reinstating that space.

use serde::{Deserialize, Serialize};

use crate::error::GitError;

/// How many new lines a diff expansion adds by default.
///
/// Ported from `DefaultDiffExpansionStep` in `src/lib/diff-hunks.ts`.
pub const DEFAULT_DIFF_EXPANSION_STEP: u32 = 20;

/// What a line in the diff represents.
///
/// A **numeric** enum in TypeScript (`Context = 0`), so it serializes as an integer. Serialized by
/// hand rather than with `serde_repr` to avoid a dependency for one type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineType {
    Context = 0,
    Add = 1,
    Delete = 2,
    Hunk = 3,
}

impl Serialize for DiffLineType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for DiffLineType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(Self::Context),
            1 => Ok(Self::Add),
            2 => Ok(Self::Delete),
            3 => Ok(Self::Hunk),
            other => Err(serde::de::Error::custom(format!(
                "unknown DiffLineType discriminant: {other}"
            ))),
        }
    }
}

/// Whether a hunk header can be expanded, and in which direction.
///
/// A *string* enum in TypeScript, unlike [`DiffLineType`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiffHunkExpansionType {
    /// Cannot be expanded at all.
    None,
    /// Can be expanded up only — the first hunk.
    Up,
    /// Can be expanded down only — the trailing dummy hunk the UI appends.
    Down,
    /// Can be expanded in both directions.
    Both,
    /// A gap short enough that expanding it merges this hunk with the one above.
    Short,
}

/// One line of a diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// The raw line, **including** its `+`/`-`/space prefix.
    pub text: String,
    #[serde(rename = "type")]
    pub line_type: DiffLineType,
    /// Position in the original patch, before any UI-side expansion.
    pub original_line_number: Option<u32>,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
    /// Whether the file this line belongs to lacks a trailing newline.
    pub no_trailing_new_line: bool,
}

/// The line ranges a hunk covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkHeader {
    pub old_start_line: u32,
    pub old_line_count: u32,
    pub new_start_line: u32,
    pub new_line_count: u32,
}

impl DiffHunkHeader {
    /// The header rendered back into unified-diff form.
    ///
    /// Ported from `toDiffLineRepresentation`; the UI uses it when synthesising expanded hunks.
    pub fn to_diff_line_representation(&self) -> String {
        format!(
            "@@ -{},{} +{},{} @@",
            self.old_start_line, self.old_line_count, self.new_start_line, self.new_line_count
        )
    }
}

/// A contiguous run of changed and context lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: DiffHunkHeader,
    pub lines: Vec<DiffLine>,
    /// Where the hunk starts within the diff as a whole, counted in lines.
    pub unified_diff_start: u32,
    /// Where it ends. Inclusive of the header line.
    pub unified_diff_end: u32,
    pub expansion_type: DiffHunkExpansionType,
}

/// A parsed unified diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDiff {
    /// Everything from the start of the diff to the first hunk header, without a trailing newline.
    pub header: String,
    /// Everything after the header, with `\ No newline at end of file` markers removed. That
    /// information survives as [`DiffLine::no_trailing_new_line`].
    pub contents: String,
    pub hunks: Vec<DiffHunk>,
    /// Whether git reported the contents as binary and produced no hunks.
    pub is_binary: bool,
    pub max_line_number: u32,
    /// Whether the diff contains invisible bidirectional control characters.
    pub has_hidden_bidi_chars: bool,
}

/// Whether `c` is one of the invisible bidirectional control characters.
///
/// Ported from `HiddenBidiCharsRegex`. These can make code render differently from how it compiles,
/// so the UI warns about them — see <https://github.co/hiddenchars>.
fn is_hidden_bidi_char(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Whether a hunk header can be expanded, and how.
///
/// Ported from `getHunkHeaderExpansionType` in `src/lib/diff-hunks.ts`. That TypeScript function
/// stays: Phase 7's `ui/diff/text-diff-expansion.ts` recomputes expansion types *after* the user
/// expands a hunk, so both sides genuinely need the rule. They are pinned against each other by the
/// wire snapshot rather than left to drift.
pub fn get_hunk_header_expansion_type(
    hunk_index: usize,
    header: &DiffHunkHeader,
    previous_hunk: Option<&DiffHunk>,
) -> DiffHunkExpansionType {
    // Only the first hunk can be expanded upwards exclusively, and only the UI's trailing dummy
    // hunk downwards exclusively; everything between goes both ways unless the gap is too small to
    // make direction meaningful.
    if hunk_index == 0 {
        return if header.old_start_line > 1 && header.new_start_line > 1 {
            DiffHunkExpansionType::Up
        } else {
            DiffHunkExpansionType::None
        };
    }

    let Some(previous) = previous_hunk else {
        // `hunkIndex > 0` with no previous hunk can't arise from `parse`, and in the original the
        // `Infinity` distance would land here too.
        return DiffHunkExpansionType::Both;
    };

    // Saturating, because a malformed diff could describe hunks that overlap or run backwards; the
    // original got `-Infinity`-ish behaviour from JavaScript numbers and fell through to `Short`.
    let distance = header
        .old_start_line
        .saturating_sub(previous.header.old_start_line)
        .saturating_sub(previous.header.old_line_count);

    if distance <= DEFAULT_DIFF_EXPANSION_STEP {
        DiffHunkExpansionType::Short
    } else {
        DiffHunkExpansionType::Both
    }
}

/// The largest line number appearing in `hunks`.
///
/// Ported from `getLargestLineNumber`. Note it does not scan everything: it walks backwards and
/// returns at the **first** non-hunk line it finds, because a diff's line numbers increase
/// monotonically, so the last real line carries the maximum.
pub fn get_largest_line_number(hunks: &[DiffHunk]) -> u32 {
    for hunk in hunks.iter().rev() {
        for line in hunk.lines.iter().rev() {
            if line.line_type == DiffLineType::Hunk {
                continue;
            }

            let new_line = line.new_line_number.unwrap_or(0);
            let old_line = line.old_line_number.unwrap_or(0);
            return new_line.max(old_line);
        }
    }

    0
}

/// The prefix character classifying a diff line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinePrefix {
    Add,
    Delete,
    Context,
    NoNewline,
}

impl LinePrefix {
    fn from_char(c: char) -> Option<Self> {
        match c {
            '+' => Some(Self::Add),
            '-' => Some(Self::Delete),
            ' ' => Some(Self::Context),
            '\\' => Some(Self::NoNewline),
            _ => None,
        }
    }
}

/// Parses a unified diff, as produced by `git diff`, `git log --patch`, and similar.
///
/// Takes `&str` rather than bytes: the original operated on a JavaScript string, so the caller
/// performs the (lossy) decode and this preserves that boundary. Diff *content* can be arbitrary
/// bytes, which is why binary files are reported via [`RawDiff::is_binary`] rather than parsed.
pub fn parse_diff(text: &str) -> Result<RawDiff, GitError> {
    Parser::new(text).parse()
}

/// Line-pointer state, mirroring the original's `ls`/`le`.
struct Parser<'a> {
    text: &'a str,
    /// Offset where the current line starts.
    line_start: usize,
    /// Offset of the newline ending the current line, or one past the end. `None` before the first
    /// line — the original used `-1`, which Rust's unsigned indices can't represent.
    line_end: Option<usize>,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            line_start: 0,
            line_end: None,
        }
    }

    /// The offset the next line would start at.
    fn next_start(&self) -> usize {
        match self.line_end {
            Some(end) => end + 1,
            None => 0,
        }
    }

    /// Advances to the next line. Returns false at the end of the diff **or on an empty line** —
    /// see the fidelity note in the module docs.
    fn next_line(&mut self) -> bool {
        self.line_start = self.next_start();

        if self.line_start >= self.text.len() {
            return false;
        }

        let end = match self.text[self.line_start..].find('\n') {
            Some(offset) => self.line_start + offset,
            None => self.text.len(),
        };
        self.line_end = Some(end);

        self.line_start != end
    }

    /// Advances and returns the line, or `None` at the end of the diff.
    fn read_line(&mut self) -> Option<&'a str> {
        if self.next_line() {
            Some(&self.text[self.line_start..self.line_end.unwrap_or(self.line_start)])
        } else {
            None
        }
    }

    fn current_line(&self) -> &'a str {
        &self.text[self.line_start..self.line_end.unwrap_or(self.line_start)]
    }

    /// The first character of the next line, without advancing.
    fn peek(&self) -> Option<char> {
        let position = self.next_start();
        self.text[position..]
            .chars()
            .next()
            .filter(|_| position < self.text.len())
    }

    /// Scans to the end of the `+++` line, reporting whether git declared the contents binary.
    ///
    /// `None` means the end of the diff was reached without finding `+++`, which is legitimate —
    /// an empty file produces exactly that.
    fn parse_diff_header(&mut self) -> Option<bool> {
        while self.next_line() {
            let line = self.current_line();

            if line.starts_with("Binary files ") && line.ends_with("differ") {
                return Some(true);
            }

            if line.starts_with("+++") {
                return Some(false);
            }
        }

        None
    }

    /// Parses a hunk header such as `@@ -84,10 +82,8 @@ optional heading`.
    ///
    /// A range may omit its comma and count, in which case the count is 1 — hence the defaults.
    /// Any hunk heading after the closing `@@` is ignored.
    fn parse_hunk_header(line: &str) -> Result<DiffHunkHeader, GitError> {
        let invalid = || GitError::Parse {
            context: "diffParser".to_owned(),
            message: format!("Invalid hunk header format: {line:?}"),
        };

        let rest = line.strip_prefix("@@ -").ok_or_else(invalid)?;
        let (old, rest) = rest.split_once(" +").ok_or_else(invalid)?;
        // Everything from the closing `@@` onwards is the optional heading.
        let (new, _) = rest.split_once(" @@").ok_or_else(invalid)?;

        let (old_start_line, old_line_count) = Self::parse_range(old).ok_or_else(invalid)?;
        let (new_start_line, new_line_count) = Self::parse_range(new).ok_or_else(invalid)?;

        Ok(DiffHunkHeader {
            old_start_line,
            old_line_count,
            new_start_line,
            new_line_count,
        })
    }

    /// Parses `l,s` or a bare `l`, where a missing `s` means 1.
    fn parse_range(range: &str) -> Option<(u32, u32)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    }

    /// Parses one hunk, header included.
    ///
    /// `lines_consumed` is how many diff lines precede this hunk, which is what gives lines their
    /// `original_line_number` and hunks their unified-diff span. Those positions mean nothing to git;
    /// they exist so the UI can address individual lines for staging.
    fn parse_hunk(
        &mut self,
        lines_consumed: u32,
        hunk_index: usize,
        previous_hunk: Option<&DiffHunk>,
    ) -> Result<DiffHunk, GitError> {
        let header_line = self.read_line().ok_or_else(|| GitError::Parse {
            context: "diffParser".to_owned(),
            message: "Expected hunk header but reached end of diff".to_owned(),
        })?;

        let header = Self::parse_hunk_header(header_line)?;

        let mut lines = vec![DiffLine {
            text: header_line.to_owned(),
            line_type: DiffLineType::Hunk,
            // The original hard-codes 1 here while leaving both line numbers null.
            original_line_number: Some(1),
            old_line_number: None,
            new_line_number: None,
            no_trailing_new_line: false,
        }];

        let mut rolling_before = header.old_start_line;
        let mut rolling_after = header.new_start_line;
        let mut diff_line_number = lines_consumed;

        while let Some(prefix) = self.peek().and_then(LinePrefix::from_char) {
            let line = self.read_line().ok_or_else(|| GitError::Parse {
                context: "diffParser".to_owned(),
                message: "Expected unified diff line but reached end of diff".to_owned(),
            })?;

            if prefix == LinePrefix::NoNewline {
                // `\ No newline at end of file` describes the *previous* line rather than being one.
                // git's own apply.c checks the same minimum length.
                if line.len() < 12 {
                    return Err(GitError::Parse {
                        context: "diffParser".to_owned(),
                        message:
                            "Expected \"no newline at end of file\" marker to be at least 12 bytes long"
                                .to_owned(),
                    });
                }

                if let Some(previous) = lines.last_mut() {
                    previous.no_trailing_new_line = true;
                }

                // Deliberately does not advance `diff_line_number`: the marker is not a line. Getting
                // this wrong misnumbers every line after a file whose last line lacked a newline.
                continue;
            }

            diff_line_number += 1;

            let diff_line = match prefix {
                LinePrefix::Add => {
                    let new_line_number = rolling_after;
                    rolling_after += 1;
                    DiffLine {
                        text: line.to_owned(),
                        line_type: DiffLineType::Add,
                        original_line_number: Some(diff_line_number),
                        old_line_number: None,
                        new_line_number: Some(new_line_number),
                        no_trailing_new_line: false,
                    }
                }
                LinePrefix::Delete => {
                    let old_line_number = rolling_before;
                    rolling_before += 1;
                    DiffLine {
                        text: line.to_owned(),
                        line_type: DiffLineType::Delete,
                        original_line_number: Some(diff_line_number),
                        old_line_number: Some(old_line_number),
                        new_line_number: None,
                        no_trailing_new_line: false,
                    }
                }
                LinePrefix::Context => {
                    let old_line_number = rolling_before;
                    let new_line_number = rolling_after;
                    rolling_before += 1;
                    rolling_after += 1;
                    DiffLine {
                        text: line.to_owned(),
                        line_type: DiffLineType::Context,
                        original_line_number: Some(diff_line_number),
                        old_line_number: Some(old_line_number),
                        new_line_number: Some(new_line_number),
                        no_trailing_new_line: false,
                    }
                }
                LinePrefix::NoNewline => unreachable!("handled above"),
            };

            lines.push(diff_line);
        }

        if lines.len() == 1 {
            return Err(GitError::Parse {
                context: "diffParser".to_owned(),
                message: "Malformed diff, empty hunk".to_owned(),
            });
        }

        let line_count = u32::try_from(lines.len()).unwrap_or(u32::MAX);
        let expansion_type = get_hunk_header_expansion_type(hunk_index, &header, previous_hunk);

        Ok(DiffHunk {
            header,
            lines,
            unified_diff_start: lines_consumed,
            unified_diff_end: lines_consumed + line_count - 1,
            expansion_type,
        })
    }

    fn parse(mut self) -> Result<RawDiff, GitError> {
        let has_hidden_bidi_chars = self.text.chars().any(is_hidden_bidi_char);

        let header_info = self.parse_diff_header();
        let header_end = self.line_end.unwrap_or(0);
        let header = self.text[..header_end].to_owned();

        // No `+++` line, or a binary marker: either way there are no hunks to read.
        let Some(is_binary) = header_info else {
            return Ok(RawDiff {
                header,
                contents: String::new(),
                hunks: Vec::new(),
                is_binary: false,
                max_line_number: 0,
                has_hidden_bidi_chars: false,
            });
        };

        if is_binary {
            return Ok(RawDiff {
                header,
                contents: String::new(),
                hunks: Vec::new(),
                is_binary: true,
                max_line_number: 0,
                has_hidden_bidi_chars: false,
            });
        }

        let mut hunks: Vec<DiffHunk> = Vec::new();
        let mut lines_consumed = 0;

        loop {
            let hunk = self.parse_hunk(lines_consumed, hunks.len(), hunks.last())?;
            lines_consumed += u32::try_from(hunk.lines.len()).unwrap_or(u32::MAX);
            hunks.push(hunk);

            if self.peek().is_none() {
                break;
            }
        }

        let contents_end = self.line_end.unwrap_or(header_end);
        let contents_start = (header_end + 1).min(contents_end);
        let contents =
            self.text[contents_start..contents_end].replace("\n\\ No newline at end of file", "");

        let max_line_number = get_largest_line_number(&hunks);

        Ok(RawDiff {
            header,
            contents,
            hunks,
            is_binary: false,
            max_line_number,
            has_hidden_bidi_chars,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The original's test suite carried this helper, and the reason is worth preserving: an editor
    /// that de-indents whitespace-only lines silently turns a context line `" "` into `""`, and an
    /// empty line terminates the parse. Every blank context line in these fixtures needs its space.
    fn reinstate_spaces_at_the_start_of_blank_lines(text: &str) -> String {
        text.replace("\n\n", "\n \n")
    }

    fn parse(text: &str) -> RawDiff {
        parse_diff(text).expect("the diff should parse")
    }

    // --- cases ported from src/lib/diff-parser.test.ts ---

    #[test]
    fn parses_changed_files() {
        let diff_text = concat!(
            "diff --git a/app/src/lib/diff-parser.ts b/app/src/lib/diff-parser.ts\n",
            "index e1d4871..3bd3ee0 100644\n",
            "--- a/app/src/lib/diff-parser.ts\n",
            "+++ b/app/src/lib/diff-parser.ts\n",
            "@@ -18,6 +18,7 @@ export function parseRawDiff(lines: ReadonlyArray<string>): Diff {\n",
            "\n",
            "     let numberOfUnifiedDiffLines = 0\n",
            "\n",
            "+\n",
            "     while (prefixFound) {\n",
            "\n",
            "       // trim any preceding text\n",
            "@@ -71,12 +72,9 @@ export function parseRawDiff(lines: ReadonlyArray<string>): Diff {\n",
            "         diffSections.push(new DiffSection(range, diffLines, startDiffSection, endDiffSection))\n",
            "       } else {\n",
            "         const diffBody = diffTextBuffer\n",
            "-\n",
            "         let startDiffSection: number = 0\n",
            "         let endDiffSection: number = 0\n",
            "-\n",
            "         const diffLines = diffBody.split('\\n')\n",
            "-\n",
            "         if (diffSections.length === 0) {\n",
            "           startDiffSection = 0\n",
            "           endDiffSection = diffLines.length\n",
            "@@ -84,10 +82,8 @@ export function parseRawDiff(lines: ReadonlyArray<string>): Diff {\n",
            "           startDiffSection = numberOfUnifiedDiffLines\n",
            "           endDiffSection = startDiffSection + diffLines.length\n",
            "         }\n",
            "-\n",
            "         diffSections.push(new DiffSection(range, diffLines, startDiffSection, endDiffSection))\n",
            "       }\n",
            "     }\n",
            "-\n",
            "     return new Diff(diffSections)\n",
            " }\n",
        );

        let diff = parse(&reinstate_spaces_at_the_start_of_blank_lines(diff_text));
        assert_eq!(diff.hunks.len(), 3);

        let hunk = &diff.hunks[0];
        assert_eq!(hunk.unified_diff_start, 0);
        assert_eq!(hunk.unified_diff_end, 7);
        assert_eq!(hunk.lines.len(), 8);

        let lines = &hunk.lines;
        assert_eq!(
            lines[0].text,
            "@@ -18,6 +18,7 @@ export function parseRawDiff(lines: ReadonlyArray<string>): Diff {"
        );
        assert_eq!(lines[0].line_type, DiffLineType::Hunk);
        assert_eq!(lines[0].old_line_number, None);
        assert_eq!(lines[0].new_line_number, None);

        assert_eq!(lines[1].text, " ");
        assert_eq!(lines[1].line_type, DiffLineType::Context);
        assert_eq!(lines[1].old_line_number, Some(18));
        assert_eq!(lines[1].new_line_number, Some(18));

        assert_eq!(lines[2].text, "     let numberOfUnifiedDiffLines = 0");
        assert_eq!(lines[2].line_type, DiffLineType::Context);
        assert_eq!(lines[2].old_line_number, Some(19));
        assert_eq!(lines[2].new_line_number, Some(19));

        assert_eq!(lines[3].text, " ");
        assert_eq!(lines[3].old_line_number, Some(20));
        assert_eq!(lines[3].new_line_number, Some(20));

        assert_eq!(lines[4].text, "+");
        assert_eq!(lines[4].line_type, DiffLineType::Add);
        assert_eq!(lines[4].old_line_number, None);
        assert_eq!(lines[4].new_line_number, Some(21));

        assert_eq!(lines[5].text, "     while (prefixFound) {");
        assert_eq!(lines[5].line_type, DiffLineType::Context);
        assert_eq!(lines[5].old_line_number, Some(21));
        assert_eq!(lines[5].new_line_number, Some(22));

        let second = &diff.hunks[1];
        assert_eq!(second.unified_diff_start, 8);
        assert_eq!(second.unified_diff_end, 20);
        assert_eq!(second.lines.len(), 13);
    }

    #[test]
    fn parses_new_files() {
        let diff_text = concat!(
            "diff --git a/testste b/testste\n",
            "new file mode 100644\n",
            "index 0000000..f13588b\n",
            "--- /dev/null\n",
            "+++ b/testste\n",
            "@@ -0,0 +1 @@\n",
            "+asdfasdf\n",
        );

        let diff = parse(diff_text);
        assert_eq!(diff.hunks.len(), 1);

        let hunk = &diff.hunks[0];
        assert_eq!(hunk.unified_diff_start, 0);
        assert_eq!(hunk.unified_diff_end, 1);
        assert_eq!(hunk.lines.len(), 2);

        assert_eq!(hunk.lines[0].text, "@@ -0,0 +1 @@");
        assert_eq!(hunk.lines[0].line_type, DiffLineType::Hunk);
        assert_eq!(hunk.lines[0].old_line_number, None);
        assert_eq!(hunk.lines[0].new_line_number, None);

        assert_eq!(hunk.lines[1].text, "+asdfasdf");
        assert_eq!(hunk.lines[1].line_type, DiffLineType::Add);
        assert_eq!(hunk.lines[1].old_line_number, None);
        assert_eq!(hunk.lines[1].new_line_number, Some(1));
    }

    #[test]
    fn parses_files_containing_hunk_markers_in_their_content() {
        // A `@@` inside the content must not be mistaken for a header.
        let diff_text = concat!(
            "diff --git a/test.txt b/test.txt\n",
            "index 24219cc..bf711a5 100644\n",
            "--- a/test.txt\n",
            "+++ b/test.txt\n",
            "@@ -1 +1 @@\n",
            "-foo @@\n",
            "+@@ foo\n",
        );

        let diff = parse(diff_text);
        assert_eq!(diff.hunks.len(), 1);

        let hunk = &diff.hunks[0];
        assert_eq!(hunk.unified_diff_start, 0);
        assert_eq!(hunk.unified_diff_end, 2);
        assert_eq!(hunk.lines.len(), 3);

        assert_eq!(hunk.lines[1].text, "-foo @@");
        assert_eq!(hunk.lines[1].line_type, DiffLineType::Delete);
        assert_eq!(hunk.lines[1].old_line_number, Some(1));
        assert_eq!(hunk.lines[1].new_line_number, None);

        assert_eq!(hunk.lines[2].text, "+@@ foo");
        assert_eq!(hunk.lines[2].line_type, DiffLineType::Add);
        assert_eq!(hunk.lines[2].old_line_number, None);
        assert_eq!(hunk.lines[2].new_line_number, Some(1));
    }

    #[test]
    fn parses_new_files_without_a_newline_at_end_of_file() {
        let diff_text = concat!(
            "diff --git a/test2.txt b/test2.txt\n",
            "new file mode 100644\n",
            "index 0000000..faf7da1\n",
            "--- /dev/null\n",
            "+++ b/test2.txt\n",
            "@@ -0,0 +1 @@\n",
            "+asdasdasd\n",
            "\\ No newline at end of file\n",
        );

        let diff = parse(diff_text);
        assert_eq!(diff.hunks.len(), 1);

        let hunk = &diff.hunks[0];
        assert_eq!(hunk.unified_diff_start, 0);
        assert_eq!(hunk.unified_diff_end, 1);
        assert_eq!(hunk.lines.len(), 2, "the marker is not a line of its own");

        assert!(!hunk.lines[0].no_trailing_new_line);
        assert_eq!(hunk.lines[1].text, "+asdasdasd");
        assert!(hunk.lines[1].no_trailing_new_line);
    }

    #[test]
    fn parses_a_diff_that_adds_a_newline_at_end_of_file() {
        let diff_text = concat!(
            "diff --git a/test2.txt b/test2.txt\n",
            "index 1910281..257cc56 100644\n",
            "--- a/test2.txt\n",
            "+++ b/test2.txt\n",
            "@@ -1 +1 @@\n",
            "-foo\n",
            "\\ No newline at end of file\n",
            "+foo\n",
        );

        let diff = parse(diff_text);
        let hunk = &diff.hunks[0];
        assert_eq!(hunk.lines.len(), 3);

        // The marker sits between the two lines, and must not consume a line number — this is the
        // case that would silently misnumber everything after it.
        assert_eq!(hunk.lines[1].text, "-foo");
        assert_eq!(hunk.lines[1].original_line_number, Some(1));
        assert!(hunk.lines[1].no_trailing_new_line);

        assert_eq!(hunk.lines[2].text, "+foo");
        assert_eq!(hunk.lines[2].original_line_number, Some(2));
        assert!(!hunk.lines[2].no_trailing_new_line);
    }

    #[test]
    fn parses_a_diff_where_neither_version_has_a_trailing_newline() {
        let diff_text = concat!(
            "diff --git a/test b/test\n",
            "index 1910281..ba0e162 100644\n",
            "--- a/test\n",
            "+++ b/test\n",
            "@@ -1 +1 @@\n",
            "-foo\n",
            "\\ No newline at end of file\n",
            "+bar\n",
            "\\ No newline at end of file\n",
        );

        let diff = parse(diff_text);
        let hunk = &diff.hunks[0];
        assert_eq!(hunk.lines.len(), 3);

        assert_eq!(hunk.lines[1].original_line_number, Some(1));
        assert!(hunk.lines[1].no_trailing_new_line);
        assert_eq!(hunk.lines[2].original_line_number, Some(2));
        assert!(hunk.lines[2].no_trailing_new_line);
    }

    #[test]
    fn parses_binary_diffs() {
        let diff_text = concat!(
            "diff --git a/IMG_2306.CR2 b/IMG_2306.CR2\n",
            "new file mode 100644\n",
            "index 0000000..4bf3a64\n",
            "Binary files /dev/null and b/IMG_2306.CR2 differ\n",
        );

        let diff = parse(diff_text);
        assert!(diff.hunks.is_empty());
        assert!(diff.is_binary);
    }

    #[test]
    fn parses_the_diff_of_an_empty_file() {
        // Produced by `git diff --no-index --patch-with-raw -z -- /dev/null foo` on an empty file.
        // There is no `+++` line, which is legitimate rather than an error.
        let diff_text = concat!("new file mode 100644\n", "index 0000000..e69de29\n");

        let diff = parse(diff_text);
        assert!(diff.hunks.is_empty());
        assert!(!diff.is_binary);
    }

    #[test]
    fn parses_hunk_headers_with_an_omitted_count_on_the_new_side() {
        let diff_text = concat!(
            "diff --git a/testste b/testste\n",
            "new file mode 100644\n",
            "index 0000000..f13588b\n",
            "--- /dev/null\n",
            "+++ b/testste\n",
            "@@ -0,0 +1 @@\n",
            "+asdfasdf\n",
        );

        let header = parse(diff_text).hunks[0].header;
        assert_eq!(header.old_start_line, 0);
        assert_eq!(header.old_line_count, 0);
        assert_eq!(header.new_start_line, 1);
        assert_eq!(header.new_line_count, 1, "an omitted count means 1");
    }

    #[test]
    fn parses_hunk_headers_with_an_omitted_count_on_the_old_side() {
        let diff_text = concat!(
            "diff --git a/testste b/testste\n",
            "new file mode 100644\n",
            "index 0000000..f13588b\n",
            "--- /dev/null\n",
            "+++ b/testste\n",
            "@@ -1 +0,0 @@\n",
            "-asdfasdf\n",
        );

        let header = parse(diff_text).hunks[0].header;
        assert_eq!(header.old_start_line, 1);
        assert_eq!(header.old_line_count, 1, "an omitted count means 1");
        assert_eq!(header.new_start_line, 0);
        assert_eq!(header.new_line_count, 0);
    }

    // --- coverage the original lacked ---

    #[test]
    fn a_zero_count_is_kept_rather_than_defaulted() {
        // Worth pinning because the original's `numberFromGroup` guarded with `if (!str)`, and it is
        // only correct by accident: the *string* "0" is truthy in JavaScript, so a captured zero
        // survives. Had the guard tested the parsed number instead, `-0,0` would have become `1`.
        let header = Parser::parse_hunk_header("@@ -0,0 +1 @@").expect("should parse");
        assert_eq!(header.old_start_line, 0);
        assert_eq!(header.old_line_count, 0);
    }

    #[test]
    fn a_hunk_heading_after_the_closing_marker_is_ignored() {
        let header = Parser::parse_hunk_header("@@ -1,2 +3,4 @@ fn something(a: u32) -> @@ weird")
            .expect("ok");
        assert_eq!(
            (
                header.old_start_line,
                header.old_line_count,
                header.new_start_line,
                header.new_line_count
            ),
            (1, 2, 3, 4)
        );
    }

    #[test]
    fn a_malformed_hunk_header_is_a_parse_error() {
        for line in [
            "@@ nonsense @@",
            "not a header at all",
            "@@ -a,b +c,d @@",
            "@@ -1,2 +3,4",
        ] {
            assert!(
                matches!(Parser::parse_hunk_header(line), Err(GitError::Parse { .. })),
                "{line:?} should not parse"
            );
        }
    }

    #[test]
    fn detects_hidden_bidi_characters() {
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -1 +1 @@\n",
            "-plain\n",
            "+sneaky\u{202E}reversed\n",
        );

        assert!(parse(diff_text).has_hidden_bidi_chars);
    }

    #[test]
    fn a_plain_diff_has_no_hidden_bidi_characters() {
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -1 +1 @@\n",
            "-plain\n",
            "+also plain\n",
        );

        assert!(!parse(diff_text).has_hidden_bidi_chars);
    }

    #[test]
    fn reports_the_largest_line_number() {
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -10,2 +10,3 @@\n",
            " context\n",
            "+added\n",
            " more context\n",
        );

        let diff = parse(diff_text);
        assert_eq!(diff.max_line_number, 12);
    }

    #[test]
    fn an_empty_diff_has_no_largest_line_number() {
        assert_eq!(get_largest_line_number(&[]), 0);
    }

    #[test]
    fn strips_no_newline_markers_from_the_contents() {
        let diff_text = concat!(
            "diff --git a/test b/test\n",
            "index 1..2 100644\n",
            "--- a/test\n",
            "+++ b/test\n",
            "@@ -1 +1 @@\n",
            "-foo\n",
            "\\ No newline at end of file\n",
            "+bar\n",
        );

        let diff = parse(diff_text);
        assert!(
            !diff.contents.contains("No newline"),
            "the marker belongs on the line, not in the contents: {:?}",
            diff.contents
        );
        assert!(diff.contents.contains("-foo"));
        assert!(diff.contents.contains("+bar"));
    }

    #[test]
    fn the_header_stops_at_the_first_hunk() {
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -1 +1 @@\n",
            "-x\n",
            "+y\n",
        );

        let diff = parse(diff_text);
        assert!(diff.header.starts_with("diff --git"));
        assert!(diff.header.ends_with("+++ b/a"));
        assert!(!diff.header.contains("@@"));
    }

    #[test]
    fn a_truncated_no_newline_marker_is_rejected() {
        // git's own apply.c enforces the same 12-byte minimum.
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -1 +1 @@\n",
            "+x\n",
            "\\ short\n",
        );

        assert!(matches!(parse_diff(diff_text), Err(GitError::Parse { .. })));
    }

    #[test]
    fn an_empty_hunk_is_rejected() {
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -1 +1 @@\n",
            "no prefix so the hunk has no lines\n",
        );

        assert!(matches!(parse_diff(diff_text), Err(GitError::Parse { .. })));
    }

    // --- expansion types ---

    #[test]
    fn the_first_hunk_can_expand_up_when_there_is_content_above_it() {
        let header = DiffHunkHeader {
            old_start_line: 10,
            old_line_count: 2,
            new_start_line: 10,
            new_line_count: 2,
        };
        assert_eq!(
            get_hunk_header_expansion_type(0, &header, None),
            DiffHunkExpansionType::Up
        );
    }

    #[test]
    fn a_first_hunk_at_the_top_of_the_file_cannot_expand() {
        let header = DiffHunkHeader {
            old_start_line: 1,
            old_line_count: 2,
            new_start_line: 1,
            new_line_count: 2,
        };
        assert_eq!(
            get_hunk_header_expansion_type(0, &header, None),
            DiffHunkExpansionType::None
        );
    }

    #[test]
    fn a_wide_gap_expands_both_ways_and_a_narrow_one_is_short() {
        let previous = DiffHunk {
            header: DiffHunkHeader {
                old_start_line: 1,
                old_line_count: 5,
                new_start_line: 1,
                new_line_count: 5,
            },
            lines: Vec::new(),
            unified_diff_start: 0,
            unified_diff_end: 0,
            expansion_type: DiffHunkExpansionType::None,
        };

        // A gap of exactly the expansion step is still "short" — expanding it would merge the hunks.
        let boundary = DiffHunkHeader {
            old_start_line: 6 + DEFAULT_DIFF_EXPANSION_STEP,
            old_line_count: 2,
            new_start_line: 6 + DEFAULT_DIFF_EXPANSION_STEP,
            new_line_count: 2,
        };
        assert_eq!(
            get_hunk_header_expansion_type(1, &boundary, Some(&previous)),
            DiffHunkExpansionType::Short
        );

        let wide = DiffHunkHeader {
            old_start_line: 7 + DEFAULT_DIFF_EXPANSION_STEP,
            old_line_count: 2,
            new_start_line: 7 + DEFAULT_DIFF_EXPANSION_STEP,
            new_line_count: 2,
        };
        assert_eq!(
            get_hunk_header_expansion_type(1, &wide, Some(&previous)),
            DiffHunkExpansionType::Both
        );
    }

    #[test]
    fn a_multi_hunk_diff_gets_expansion_types_assigned_in_order() {
        let diff_text = concat!(
            "diff --git a/a b/a\n",
            "index 1..2 100644\n",
            "--- a/a\n",
            "+++ b/a\n",
            "@@ -10,2 +10,2 @@\n",
            " one\n",
            "-two\n",
            "+TWO\n",
            "@@ -100,2 +100,2 @@\n",
            " three\n",
            "-four\n",
            "+FOUR\n",
        );

        let diff = parse(diff_text);
        assert_eq!(diff.hunks.len(), 2);
        assert_eq!(diff.hunks[0].expansion_type, DiffHunkExpansionType::Up);
        assert_eq!(diff.hunks[1].expansion_type, DiffHunkExpansionType::Both);
    }

    #[test]
    fn renders_a_header_back_into_unified_diff_form() {
        let header = DiffHunkHeader {
            old_start_line: 18,
            old_line_count: 6,
            new_start_line: 18,
            new_line_count: 7,
        };
        assert_eq!(header.to_diff_line_representation(), "@@ -18,6 +18,7 @@");
    }
}
