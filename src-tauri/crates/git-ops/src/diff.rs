//! Diff queries.
//!
//! Ported from `desktop-plus/app/src/lib/git/diff.ts`, which is 1,032 lines.
//!
//! # What is here
//!
//! The **text diff path**: `get_working_directory_diff`, `get_commit_diff`, `get_commit_range_diff`,
//! the size guards that decide whether a diff is renderable, submodule diffs, and `get_binary_paths`
//! (ported earlier, because `status` needed it).
//!
//! # What is deferred, and why
//!
//! **Image diffs.** `getImageDiff`/`getBlobImage` read blob bytes and base64-encode them into a data
//! URI. That needs the "how do raw bytes cross IPC" decision noted in [`crate::show`], and the UI
//! that would consume it is Phase 7. Consequences, both deliberate and both visible:
//!
//! - A binary file with a known image extension currently reports [`DiffType::Binary`] rather than an
//!   image preview.
//! - An SVG reports a plain text diff. The original returned an *image* diff carrying the text diff
//!   in a `textDiff` field so the viewer could offer both; the text half is what this produces, so no
//!   information is lost — only the second view mode is missing.
//!
//! **`getFilesDiffText`, `getResolutionDiff`, LFS.** The first two need temp-file plumbing and
//! `getPartialBlobContents`; LFS needs its own module. None are on the path to rendering a change.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::get_config_value;
use crate::diff_index::NULL_TREE_SHA;
use crate::diff_parser::{parse_diff, DiffHunk, RawDiff};
use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_delimiter_parser::LogParser;
use crate::git_error_kind::GitErrorKind;
use crate::status::AppFileStatus;
use crate::status_parser::SubmoduleStatus;

/// Paths that should be treated as binary when diffing against `reference`.
///
/// Two independent reasons a path counts as binary, matching the original:
/// 1. git itself reports no line counts for it (`-` / `-` in `--numstat`).
/// 2. it is configured to use a binary merge driver, which matters for conflicts where git will
///    not have produced conflict markers.
///
/// `conflicted_paths` is only used for the second check. The original took `IStatusEntry[]` and
/// mapped to `.path`; taking paths keeps this module independent of the status parser's types.
pub async fn get_binary_paths(
    repository: impl AsRef<Path>,
    reference: &str,
    conflicted_paths: &[String],
) -> Result<Vec<String>, GitError> {
    let repository = repository.as_ref();

    let detected = get_detected_binary_files(repository, reference).await?;
    let merge_driver = get_files_using_binary_merge_driver(repository, conflicted_paths).await?;

    // BTreeSet rather than the original's insertion-ordered Set: the result is only ever membership
    // -tested, and a deterministic order makes it easier to assert on.
    let combined: BTreeSet<String> = detected.into_iter().chain(merge_driver).collect();
    Ok(combined.into_iter().collect())
}

/// Paths git reports as binary in `--numstat` output.
async fn get_detected_binary_files(
    repository: &Path,
    reference: &str,
) -> Result<Vec<String>, GitError> {
    let output = git(
        &["diff", "--numstat", "-z", reference],
        repository,
        "getBinaryPaths",
        GitOptions::default(),
    )
    .await?;

    Ok(binary_list_pattern()
        .captures_iter(&output.stdout_lossy())
        .filter_map(|captures| captures.get(1).map(|m| m.as_str().to_owned()))
        // Defensive: a path is never empty, and an empty entry in this list would make
        // `binary_file_paths.contains(path)` behave unpredictably downstream.
        .filter(|path| !path.is_empty())
        .collect())
}

/// Matches the path of a binary file in `--numstat -z` output.
///
/// A binary file has `-` for both line counts. The optional group handles renames, where git emits
/// the old and new paths as separate NUL-terminated fields, so the capture lands on the new path.
///
/// # Upstream bug, fixed here
///
/// The original is `-\t-\t(?:\0.+\0)?([^\0]*)`. For a renamed binary the real output is
/// `-\t-\t\0old.bin\0new.bin\0`, and the greedy `.+` swallows *both* paths (`\0` is not a line
/// terminator, so `.` matches it) before the trailing `\0` — leaving the capture group empty.
/// Verified against Node: the upstream regex yields `[""]` for that input, where this one yields
/// `["new.bin"]`.
///
/// The consequence upstream is that a renamed binary file is not recognized as binary, so a
/// conflict involving one is treated as text and the UI looks for conflict markers that cannot be
/// there. `[^\x00]*` instead of `.+` keeps the group from crossing a field boundary.
fn binary_list_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"-\t-\t(?:\x00[^\x00]*\x00)?([^\x00]*)").expect("pattern is valid")
    })
}

/// Conflicted paths configured to use a binary merge driver.
async fn get_files_using_binary_merge_driver(
    repository: &Path,
    conflicted_paths: &[String],
) -> Result<Vec<String>, GitError> {
    // Nothing to ask about, and `check-attr --stdin` with empty input would just be a wasted spawn.
    if conflicted_paths.is_empty() {
        return Ok(Vec::new());
    }

    let output = git(
        &["check-attr", "--stdin", "-z", "merge"],
        repository,
        "getConflictedFilesUsingBinaryMergeDriver",
        GitOptions::default().with_stdin(conflicted_paths.join("\0")),
    )
    .await?;

    // check-attr -z emits <path>\0<attr>\0<value>\0 per file, with no record separator.
    let parser = LogParser::new(&["", "", ""]);
    Ok(parser
        .parse(&output.stdout_lossy())
        .into_iter()
        .filter_map(|fields| match fields.as_slice() {
            [path, attr, value] if attr == "merge" && value == "binary" => Some(path.clone()),
            _ => None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

    #[tokio::test]
    async fn reports_no_binary_paths_for_a_text_only_diff() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "text\n", "first");
        commit_file(&repo.path(), "foo", "more text\n", "second");

        let binary = get_binary_paths(repo.path(), "HEAD~1", &[])
            .await
            .expect("should succeed");
        assert!(binary.is_empty(), "got {binary:?}");
    }

    #[tokio::test]
    async fn detects_a_binary_file_from_numstat() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "readme", "text\n", "first");

        // A NUL byte makes git treat the file as binary.
        std::fs::write(repo.path().join("blob.bin"), [0u8, 1, 2, 3, 0, 255])
            .expect("failed to write a binary file");
        git(
            &["add", "--", "blob.bin"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        git(
            &["commit", "-m", "add binary"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("commit should succeed");

        let binary = get_binary_paths(repo.path(), "HEAD~1", &[])
            .await
            .expect("should succeed");
        assert_eq!(binary, ["blob.bin"]);
    }

    #[tokio::test]
    async fn detects_a_renamed_binary_file() {
        // End-to-end cover for the upstream regex bug, driven by real git rather than a
        // hand-written fixture: upstream this returned an empty path and the rename was never
        // recognized as binary.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("old.bin"), [0u8, 1, 2, 3])
            .expect("failed to write a binary file");
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");
        git(
            &["commit", "-m", "add binary"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("commit should succeed");

        git(
            &["mv", "old.bin", "new.bin"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("mv should succeed");
        git(
            &["commit", "-m", "rename binary"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("commit should succeed");

        let binary = get_binary_paths(repo.path(), "HEAD~1", &[])
            .await
            .expect("should succeed");
        assert_eq!(
            binary,
            ["new.bin"],
            "a renamed binary should be reported under its new path"
        );
    }

    #[tokio::test]
    async fn detects_a_path_using_a_binary_merge_driver() {
        let repo = conflicted_repository().await;

        // Without the attribute, `foo` conflicts as text.
        let before = get_binary_paths(repo.path(), "MERGE_HEAD", &["foo".to_owned()])
            .await
            .expect("should succeed");
        assert!(
            !before.contains(&"foo".to_owned()),
            "text conflict should not be binary, got {before:?}"
        );

        std::fs::write(repo.path().join(".gitattributes"), "foo merge=binary\n")
            .expect("failed to write .gitattributes");

        let after = get_binary_paths(repo.path(), "MERGE_HEAD", &["foo".to_owned()])
            .await
            .expect("should succeed");
        assert!(
            after.contains(&"foo".to_owned()),
            "a binary merge driver should mark the path binary, got {after:?}"
        );
    }

    #[tokio::test]
    async fn ignores_conflicted_paths_when_none_are_given() {
        // Guards the short-circuit: no paths means no check-attr call and no results from it.
        let repo = conflicted_repository().await;
        std::fs::write(repo.path().join(".gitattributes"), "foo merge=binary\n")
            .expect("failed to write .gitattributes");

        let binary = get_binary_paths(repo.path(), "MERGE_HEAD", &[])
            .await
            .expect("should succeed");
        assert!(
            !binary.contains(&"foo".to_owned()),
            "the merge-driver check needs the path passed in, got {binary:?}"
        );
    }

    #[test]
    fn numstat_pattern_captures_a_plain_binary_path() {
        let stdout = "-\t-\tblob.bin\0";
        let captured: Vec<&str> = binary_list_pattern()
            .captures_iter(stdout)
            .filter_map(|c| c.get(1).map(|m| m.as_str()))
            .collect();
        assert_eq!(captured, ["blob.bin"]);
    }

    #[test]
    fn numstat_pattern_captures_the_new_path_of_a_renamed_binary() {
        // Regression test for the upstream bug documented on `binary_list_pattern`: the original
        // regex captured an empty string here, so a renamed binary was never recognized as binary.
        // The input is exactly what `git diff --numstat -z` emits for a renamed binary, verified
        // against real git.
        let stdout = "-\t-\t\0old.bin\0new.bin\0";
        let captured: Vec<&str> = binary_list_pattern()
            .captures_iter(stdout)
            .filter_map(|c| c.get(1).map(|m| m.as_str()))
            .collect();
        assert_eq!(captured, ["new.bin"]);
    }

    #[test]
    fn numstat_pattern_ignores_text_files() {
        let stdout = "1\t2\ttext.txt\0";
        assert_eq!(binary_list_pattern().captures_iter(stdout).count(), 0);
    }
}

// ---------------------------------------------------------------------------
// The text diff path
// ---------------------------------------------------------------------------

/// V8's limit on the size of string it can create, in bytes.
///
/// A hard ceiling: past this the original couldn't even decode the buffer, so the diff is reported as
/// [`DiffType::Unrenderable`] without being parsed. Kept as the original's decimal 70MB rather than
/// being "corrected" to a power of two, because the number is a property of the runtime it was
/// measured against and nothing here should silently widen it.
const MAX_DIFF_BUFFER_SIZE: usize = 70_000_000;

/// A soft ceiling: bigger than this renders, but slowly, so the UI asks first.
const MAX_REASONABLE_DIFF_SIZE: usize = MAX_DIFF_BUFFER_SIZE / 16;

/// The longest line worth trying to display.
const MAX_CHARACTERS_PER_LINE: usize = 5000;

/// How a diff should be presented.
///
/// A **numeric** enum in TypeScript (`Text = 0`), like `DiffLineType` and `IndexStatus`, so it
/// serializes as its discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffType {
    /// A text file, whose lines can be individually selected for commit.
    Text = 0,
    /// A file the app can render as an image.
    Image = 1,
    /// A format git can't present in a human-readable way.
    Binary = 2,
    /// A submodule pointer.
    Submodule = 3,
    /// Renderable, but large enough that the UI should ask first.
    LargeText = 4,
    /// Too large to render at all.
    Unrenderable = 5,
}

impl Serialize for DiffType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for DiffType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(Self::Text),
            1 => Ok(Self::Image),
            2 => Ok(Self::Binary),
            3 => Ok(Self::Submodule),
            4 => Ok(Self::LargeText),
            5 => Ok(Self::Unrenderable),
            other => Err(serde::de::Error::custom(format!(
                "unknown DiffType discriminant: {other}"
            ))),
        }
    }
}

/// A line ending style, as git names it in its warnings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineEnding {
    CR,
    LF,
    CRLF,
}

impl LineEnding {
    /// Parses one of git's line-ending names, or `None` for anything else.
    fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "CR" => Some(Self::CR),
            "LF" => Some(Self::LF),
            "CRLF" => Some(Self::CRLF),
            _ => None,
        }
    }
}

/// A line-ending conversion git will apply when the file is committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineEndingsChange {
    pub from: LineEnding,
    pub to: LineEnding,
}

/// The payload shared by [`DiffType::Text`] and [`DiffType::LargeText`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDiffData {
    /// The unified diff body, headers and context included.
    pub text: String,
    pub hunks: Vec<DiffHunk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_endings_change: Option<LineEndingsChange>,
    pub max_line_number: u32,
    pub has_hidden_bidi_chars: bool,
}

/// A submodule pointer change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleDiffData {
    /// The submodule's absolute path.
    pub full_path: String,
    /// Its path within the containing repository.
    pub path: String,
    pub url: Option<String>,
    pub status: SubmoduleStatus,
    /// `None` when the pointer itself didn't move.
    #[serde(rename = "oldSHA")]
    pub old_sha: Option<String>,
    #[serde(rename = "newSHA")]
    pub new_sha: Option<String>,
}

/// A diff, ready to render.
///
/// Mirrors the TypeScript `IDiff` union, which discriminates on a **numeric** `kind`. Serde's
/// internally-tagged representation writes the *variant name* as the tag, so this implements
/// `Serialize`/`Deserialize` by hand — a `"kind": "Text"` string would not match
/// `DiffType.Text === 0` on the other side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Diff {
    Text(TextDiffData),
    /// Renderable but large; the UI shows it on request. Carries the same payload as `Text`.
    LargeText(TextDiffData),
    Binary,
    Submodule(SubmoduleDiffData),
    Unrenderable,
}

impl Diff {
    /// The discriminator the frontend switches on.
    pub fn kind(&self) -> DiffType {
        match self {
            Self::Text(_) => DiffType::Text,
            Self::LargeText(_) => DiffType::LargeText,
            Self::Binary => DiffType::Binary,
            Self::Submodule(_) => DiffType::Submodule,
            Self::Unrenderable => DiffType::Unrenderable,
        }
    }

    /// The text payload, for `Text` and `LargeText`.
    pub fn text_data(&self) -> Option<&TextDiffData> {
        match self {
            Self::Text(data) | Self::LargeText(data) => Some(data),
            _ => None,
        }
    }
}

impl Serialize for Diff {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;

        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", &self.kind())?;

        match self {
            Self::Text(data) | Self::LargeText(data) => {
                map.serialize_entry("text", &data.text)?;
                map.serialize_entry("hunks", &data.hunks)?;
                // Omitted rather than null, matching the optional property on `ITextDiffData`.
                if let Some(change) = &data.line_endings_change {
                    map.serialize_entry("lineEndingsChange", change)?;
                }
                map.serialize_entry("maxLineNumber", &data.max_line_number)?;
                map.serialize_entry("hasHiddenBidiChars", &data.has_hidden_bidi_chars)?;
            }
            Self::Submodule(data) => {
                map.serialize_entry("fullPath", &data.full_path)?;
                map.serialize_entry("path", &data.path)?;
                map.serialize_entry("url", &data.url)?;
                map.serialize_entry("status", &data.status)?;
                map.serialize_entry("oldSHA", &data.old_sha)?;
                map.serialize_entry("newSHA", &data.new_sha)?;
            }
            Self::Binary | Self::Unrenderable => {}
        }

        map.end()
    }
}

impl<'de> Deserialize<'de> for Diff {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        /// Every field any variant might carry, so `kind` can be read before deciding.
        ///
        /// An untagged enum can't do this job: `Text` and `LargeText` are structurally identical and
        /// differ only in `kind`, so untagged deserialization would always pick whichever came first.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AnyDiff {
            kind: DiffType,
            text: Option<String>,
            hunks: Option<Vec<DiffHunk>>,
            line_endings_change: Option<LineEndingsChange>,
            max_line_number: Option<u32>,
            has_hidden_bidi_chars: Option<bool>,
            full_path: Option<String>,
            path: Option<String>,
            url: Option<String>,
            status: Option<SubmoduleStatus>,
            #[serde(rename = "oldSHA")]
            old_sha: Option<String>,
            #[serde(rename = "newSHA")]
            new_sha: Option<String>,
        }

        let any = AnyDiff::deserialize(deserializer)?;
        let missing = |field: &str| serde::de::Error::custom(format!("missing field {field}"));

        let text_data = |any: &AnyDiff| -> Result<TextDiffData, D::Error> {
            Ok(TextDiffData {
                text: any.text.clone().ok_or_else(|| missing("text"))?,
                hunks: any.hunks.clone().ok_or_else(|| missing("hunks"))?,
                line_endings_change: any.line_endings_change,
                max_line_number: any
                    .max_line_number
                    .ok_or_else(|| missing("maxLineNumber"))?,
                has_hidden_bidi_chars: any
                    .has_hidden_bidi_chars
                    .ok_or_else(|| missing("hasHiddenBidiChars"))?,
            })
        };

        match any.kind {
            DiffType::Text => Ok(Self::Text(text_data(&any)?)),
            DiffType::LargeText => Ok(Self::LargeText(text_data(&any)?)),
            DiffType::Binary => Ok(Self::Binary),
            DiffType::Unrenderable => Ok(Self::Unrenderable),
            DiffType::Submodule => Ok(Self::Submodule(SubmoduleDiffData {
                full_path: any.full_path.ok_or_else(|| missing("fullPath"))?,
                path: any.path.ok_or_else(|| missing("path"))?,
                url: any.url,
                status: any.status.ok_or_else(|| missing("status"))?,
                old_sha: any.old_sha,
                new_sha: any.new_sha,
            })),
            DiffType::Image => Err(serde::de::Error::custom(
                "image diffs are not produced yet; see the module docs",
            )),
        }
    }
}

/// Guards a pathspec against being mistaken for an option or a revision.
///
/// An absolute path is wrapped in git's `:(top,literal)` pathspec magic. Without it, a path that
/// *looks* absolute on one platform but not another would be interpreted differently — see
/// <https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-top>.
fn ensure_relative_path(path: &str) -> String {
    if Path::new(path).is_absolute() {
        format!(":(top,literal){path}")
    } else {
        path.to_owned()
    }
}

/// Extracts git's line-endings warning from stderr, if it emitted one.
///
/// git reports these on stderr while still succeeding, so the caller has to look for it rather than
/// being told.
fn parse_line_endings_warning(stderr: &str) -> Option<LineEndingsChange> {
    let captures = line_endings_pattern().captures(stderr)?;
    let from = LineEnding::parse(captures.get(1)?.as_str())?;
    let to = LineEnding::parse(captures.get(2)?.as_str())?;
    Some(LineEndingsChange { from, to })
}

fn line_endings_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"', (CRLF|CR|LF) will be replaced by (CRLF|CR|LF) the ")
            .expect("pattern is valid")
    })
}

/// Parses the patch out of `--patch-with-raw -z` output.
///
/// The raw records come first, NUL-separated, then the patch — so the patch is the **last** field.
/// A `--no-index` diff has no raw section at all, and taking the last field handles both.
fn diff_from_raw_diff_output(output: &[u8]) -> Result<RawDiff, GitError> {
    // Decoded lossily, as the original did: it assumed UTF-8 while noting the raw buffer leaves the
    // door open to other encodings.
    let text = String::from_utf8_lossy(output);
    let patch = text.rsplit('\0').next().unwrap_or_default();
    parse_diff(patch)
}

/// Whether any line is too long to lay out.
fn is_diff_too_large(diff: &RawDiff) -> bool {
    diff.hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .any(|line| line.text.chars().count() > MAX_CHARACTERS_PER_LINE)
}

/// Decides how a diff should be presented, applying the size guards.
///
/// Order matters: the hard buffer limit is checked **before parsing**, because past it the original
/// couldn't decode the buffer at all.
async fn build_diff(
    output: &[u8],
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    newest_commitish: &str,
    oldest_commitish: &str,
    line_endings_change: Option<LineEndingsChange>,
) -> Result<Diff, GitError> {
    if let Some(submodule_status) = submodule_status_of(status) {
        return build_submodule_diff(output, repository, path, status, submodule_status).await;
    }

    if output.len() > MAX_DIFF_BUFFER_SIZE {
        return Ok(Diff::Unrenderable);
    }

    let raw = diff_from_raw_diff_output(output)?;

    let data = TextDiffData {
        text: raw.contents.clone(),
        hunks: raw.hunks.clone(),
        line_endings_change,
        max_line_number: raw.max_line_number,
        has_hidden_bidi_chars: raw.has_hidden_bidi_chars,
    };

    if output.len() >= MAX_REASONABLE_DIFF_SIZE || is_diff_too_large(&raw) {
        // Still carries text and hunks, so the UI can offer to render it anyway.
        return Ok(Diff::LargeText(data));
    }

    Ok(convert_diff(
        &raw,
        path,
        data,
        newest_commitish,
        oldest_commitish,
    ))
}

/// Classifies a parsed diff as text or binary.
///
/// See the module docs for why a known image extension still yields [`Diff::Binary`] and why an SVG
/// yields plain text: both cases want the image path, which isn't ported.
fn convert_diff(
    raw: &RawDiff,
    _path: &str,
    data: TextDiffData,
    _newest_commitish: &str,
    _oldest_commitish: &str,
) -> Diff {
    if raw.is_binary {
        return Diff::Binary;
    }

    Diff::Text(data)
}

/// The submodule status a change carries, if any.
fn submodule_status_of(status: &AppFileStatus) -> Option<SubmoduleStatus> {
    match status {
        AppFileStatus::New { submodule_status }
        | AppFileStatus::Modified { submodule_status }
        | AppFileStatus::Deleted { submodule_status }
        | AppFileStatus::Untracked { submodule_status }
        | AppFileStatus::Copied {
            submodule_status, ..
        }
        | AppFileStatus::Renamed {
            submodule_status, ..
        } => *submodule_status,
        // A conflict carries its submodule status inside the entry.
        AppFileStatus::Conflicted(conflict) => match conflict {
            crate::status::ConflictedFileStatus::WithMarkers { entry, .. }
            | crate::status::ConflictedFileStatus::Manual { entry } => entry.submodule_status,
        },
    }
}

/// Describes a submodule pointer change.
///
/// The SHAs are read out of the patch text: a submodule diff's body is a pair of
/// `Subproject commit <sha>` lines. They are only looked for when the pointer could have moved —
/// `commitChanged`, or the submodule being added or removed — because otherwise the diff describes
/// the submodule's dirty working tree and contains no such lines.
async fn build_submodule_diff(
    output: &[u8],
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    submodule_status: SubmoduleStatus,
) -> Result<Diff, GitError> {
    let url = get_config_value(repository, &format!("submodule.{path}.url"), true).await?;

    let pointer_could_have_moved = submodule_status.commit_changed
        || matches!(
            status,
            AppFileStatus::New { .. } | AppFileStatus::Deleted { .. }
        );

    let (old_sha, new_sha) = if pointer_could_have_moved {
        let text = String::from_utf8_lossy(output);
        (
            find_subproject_commit(&text, '-'),
            find_subproject_commit(&text, '+'),
        )
    } else {
        (None, None)
    };

    let full_path: PathBuf = repository.join(path);

    Ok(Diff::Submodule(SubmoduleDiffData {
        full_path: full_path.to_string_lossy().into_owned(),
        path: path.to_owned(),
        url,
        status: submodule_status,
        old_sha,
        new_sha,
    }))
}

/// Finds the first `<prefix>Subproject commit <sha>` line's SHA.
///
/// The trailing `-dirty` git appends for a modified submodule working tree is excluded, matching the
/// original's `([^-]+)(-dirty)?$` — note that also means a SHA is read up to the first `-`, which is
/// safe because a hex SHA contains none.
fn find_subproject_commit(text: &str, prefix: char) -> Option<String> {
    text.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix(prefix)?;
            let rest = rest.strip_prefix("Subproject commit ")?;
            let sha = rest.split('-').next()?.trim_end();
            (!sha.is_empty()).then(|| sha.to_owned())
        })
        .next()
}

/// Appends the pathspec arguments for a file, including a rename or copy's source.
fn push_pathspecs(args: &mut Vec<String>, path: &str, status: &AppFileStatus) {
    args.push(ensure_relative_path(path));

    if let AppFileStatus::Renamed { old_path, .. } | AppFileStatus::Copied { old_path, .. } = status
    {
        args.push(ensure_relative_path(old_path));
    }
}

/// Diffs a file in the working directory against the index or `HEAD`.
///
/// Three shapes, following the original:
///
/// - A **new or untracked** file (that isn't a submodule) has nothing to compare against, so it is
///   diffed against `/dev/null` with `--no-index`, presenting the whole file as additions. That mode
///   emulates `diff(1)`'s exit codes, where **1 means "differences found"** rather than failure, so 1
///   is accepted as success.
/// - A **renamed** file is diffed against the index rather than `HEAD`. The original called this
///   "technically incorrect, the best kind of incorrect": showing exactly what will be committed
///   would need a blob-to-blob diff against `HEAD`, so changes already staged to the renamed file
///   don't appear here the way they do in other diffs.
/// - Everything else is diffed against `HEAD`.
///
/// `--no-ext-diff` is passed so a user's configured `diff.external` program is ignored.
pub async fn get_working_directory_diff(
    repository: impl AsRef<Path>,
    path: &str,
    status: &AppFileStatus,
    hide_whitespace: bool,
) -> Result<Diff, GitError> {
    let repository = repository.as_ref();

    let mut args: Vec<String> = vec!["diff".to_owned()];
    if hide_whitespace {
        args.push("-w".to_owned());
    }
    args.extend([
        "--no-ext-diff".to_owned(),
        "--patch-with-raw".to_owned(),
        "-z".to_owned(),
        "--no-color".to_owned(),
    ]);

    let is_submodule = submodule_status_of(status).is_some();
    let is_new = matches!(
        status,
        AppFileStatus::New { .. } | AppFileStatus::Untracked { .. }
    );

    let mut options = GitOptions::default();

    if is_new && !is_submodule {
        options = options.with_success_exit_codes([1]);
        args.extend([
            "--no-index".to_owned(),
            "--".to_owned(),
            "/dev/null".to_owned(),
            // Deliberately not `ensure_relative_path`: with `--no-index` git treats both operands as
            // filenames rather than pathspecs, so the magic prefix would be taken literally.
            path.to_owned(),
        ]);
    } else if matches!(status, AppFileStatus::Renamed { .. }) {
        args.push("--".to_owned());
        args.push(ensure_relative_path(path));
    } else {
        args.extend(["HEAD".to_owned(), "--".to_owned()]);
        args.push(ensure_relative_path(path));
    }

    let output = git(&args, repository, "getWorkingDirectoryDiff", options).await?;
    let line_endings_change = parse_line_endings_warning(&output.stderr);

    build_diff(
        &output.stdout,
        repository,
        path,
        status,
        "HEAD",
        "HEAD",
        line_endings_change,
    )
    .await
}

/// Diffs a file in a commit against that commit's first parent.
pub async fn get_commit_diff(
    repository: impl AsRef<Path>,
    path: &str,
    status: &AppFileStatus,
    commitish: &str,
    hide_whitespace: bool,
) -> Result<Diff, GitError> {
    let repository = repository.as_ref();

    let mut args: Vec<String> = vec!["log".to_owned(), commitish.to_owned()];
    if hide_whitespace {
        args.push("-w".to_owned());
    }
    // `-m -1 --first-parent` so a merge commit produces one diff against its first parent rather
    // than one per parent.
    args.extend([
        "-m".to_owned(),
        "-1".to_owned(),
        "--first-parent".to_owned(),
        "--patch-with-raw".to_owned(),
        "--format=".to_owned(),
        "-z".to_owned(),
        "--no-color".to_owned(),
        "--".to_owned(),
    ]);
    push_pathspecs(&mut args, path, status);

    let output = git(&args, repository, "getCommitDiff", GitOptions::default()).await?;

    build_diff(
        &output.stdout,
        repository,
        path,
        status,
        commitish,
        commitish,
        None,
    )
    .await
}

/// Diffs a file across a range of commits.
///
/// Compares `commits[0]^` with the last commit. When the oldest commit has no parent — the first
/// commit on a branch — `SHA^` doesn't resolve and git reports a bad revision; the diff is then
/// retried against git's empty tree, which presents the file as entirely added.
///
/// Errors when `commits` is empty rather than silently diffing nothing.
pub async fn get_commit_range_diff(
    repository: impl AsRef<Path>,
    path: &str,
    status: &AppFileStatus,
    commits: &[String],
    hide_whitespace: bool,
) -> Result<Diff, GitError> {
    let repository = repository.as_ref();

    let (Some(first), Some(latest)) = (commits.first(), commits.last()) else {
        return Err(GitError::Parse {
            context: "getCommitRangeDiff".to_owned(),
            message: "no commits to diff".to_owned(),
        });
    };

    // The original recursed with a `useNullTreeSHA` flag; a loop makes it obvious the retry happens
    // at most once.
    for use_null_tree in [false, true] {
        let (oldest_ref, oldest_commitish) = if use_null_tree {
            (NULL_TREE_SHA.to_owned(), NULL_TREE_SHA.to_owned())
        } else {
            (format!("{first}^"), first.clone())
        };

        let mut args: Vec<String> = vec!["diff".to_owned(), oldest_ref, latest.clone()];
        if hide_whitespace {
            args.push("-w".to_owned());
        }
        args.extend([
            "--patch-with-raw".to_owned(),
            "--format=".to_owned(),
            "-z".to_owned(),
            "--no-color".to_owned(),
            "--".to_owned(),
        ]);
        push_pathspecs(&mut args, path, status);

        let output = git(
            &args,
            repository,
            "getCommitRangeDiff",
            GitOptions::default().with_expected_errors([GitErrorKind::BadRevision]),
        )
        .await?;

        if output.git_error == Some(GitErrorKind::BadRevision) && !use_null_tree {
            continue;
        }

        return build_diff(
            &output.stdout,
            repository,
            path,
            status,
            latest,
            &oldest_commitish,
            None,
        )
        .await;
    }

    unreachable!("the loop returns on its second iteration")
}

#[cfg(test)]
mod text_diff_tests {
    use super::*;
    use crate::diff_parser::DiffLineType;
    use crate::test_support::{commit_file, empty_repository};

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

    /// The text payload, or a panic naming what was produced instead.
    fn expect_text(diff: &Diff) -> &TextDiffData {
        match diff {
            Diff::Text(data) => data,
            other => panic!("expected a text diff, got {:?}", other.kind()),
        }
    }

    // --- pathspec handling ---

    #[test]
    fn leaves_a_relative_path_alone() {
        assert_eq!(ensure_relative_path("src/thing.ts"), "src/thing.ts");
    }

    #[test]
    fn wraps_an_absolute_path_in_pathspec_magic() {
        // Without this a path that looks absolute is interpreted differently across platforms.
        assert_eq!(
            ensure_relative_path("/tmp/thing.ts"),
            ":(top,literal)/tmp/thing.ts"
        );
    }

    #[test]
    fn adds_the_source_pathspec_for_a_rename() {
        let mut args = Vec::new();
        push_pathspecs(
            &mut args,
            "after",
            &AppFileStatus::Renamed {
                old_path: "before".to_owned(),
                submodule_status: None,
                rename_includes_modifications: false,
            },
        );
        assert_eq!(args, vec!["after".to_owned(), "before".to_owned()]);
    }

    #[test]
    fn adds_only_one_pathspec_for_an_ordinary_change() {
        let mut args = Vec::new();
        push_pathspecs(&mut args, "thing.ts", &modified());
        assert_eq!(args, vec!["thing.ts".to_owned()]);
    }

    // --- line-endings warning ---

    #[test]
    fn parses_a_line_endings_warning() {
        let stderr = "warning: in the working copy of 'a.txt', LF will be replaced by CRLF the next time Git touches it\n";
        assert_eq!(
            parse_line_endings_warning(stderr),
            Some(LineEndingsChange {
                from: LineEnding::LF,
                to: LineEnding::CRLF
            })
        );
    }

    #[test]
    fn ignores_unrelated_stderr() {
        assert_eq!(parse_line_endings_warning(""), None);
        assert_eq!(
            parse_line_endings_warning("warning: something else\n"),
            None
        );
    }

    #[test]
    fn line_endings_serialize_as_the_names_git_uses() {
        // A string union in TypeScript, so the names are the wire values.
        assert_eq!(
            serde_json::to_string(&LineEndingsChange {
                from: LineEnding::CR,
                to: LineEnding::LF
            })
            .expect("serializes"),
            r#"{"from":"CR","to":"LF"}"#
        );
    }

    // --- output splitting ---

    #[test]
    fn takes_the_patch_from_the_last_field_of_patch_with_raw_output() {
        // `--patch-with-raw -z` puts the raw records first, then the patch.
        let output = b":100644 100644 aaa bbb M\0a.txt\0diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let raw = diff_from_raw_diff_output(output).expect("should parse");

        assert_eq!(raw.hunks.len(), 1);
        assert!(raw.header.starts_with("diff --git"));
    }

    #[test]
    fn handles_output_with_no_raw_section() {
        // `--no-index` produces no raw records, so the whole output is the patch.
        let output =
            b"diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
        assert_eq!(
            diff_from_raw_diff_output(output)
                .expect("should parse")
                .hunks
                .len(),
            1
        );
    }

    // --- size guards ---

    #[test]
    fn a_long_line_makes_a_diff_too_large() {
        let long = "+".to_owned() + &"x".repeat(MAX_CHARACTERS_PER_LINE + 1);
        let text = format!(
            "diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n{long}\n"
        );
        let raw = parse_diff(&text).expect("should parse");
        assert!(is_diff_too_large(&raw));
    }

    #[test]
    fn ordinary_lines_are_not_too_large() {
        let text =
            "diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
        let raw = parse_diff(text).expect("should parse");
        assert!(!is_diff_too_large(&raw));
    }

    #[test]
    fn measures_line_length_in_characters_not_bytes() {
        // A multi-byte character must not count several times over, or a file of CJK text would be
        // declared unrenderable at a third of the real limit.
        let line = "+".to_owned() + &"語".repeat(MAX_CHARACTERS_PER_LINE - 1);
        let text = format!(
            "diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n{line}\n"
        );
        let raw = parse_diff(&text).expect("should parse");

        assert!(
            raw.hunks[0].lines[1].text.len() > MAX_CHARACTERS_PER_LINE,
            "the fixture must exceed the limit when measured in bytes"
        );
        assert!(!is_diff_too_large(&raw), "but not when measured in chars");
    }

    // --- Diff serialization ---

    #[test]
    fn a_diff_serializes_with_a_numeric_kind() {
        let value = serde_json::to_value(Diff::Binary).expect("serializes");
        assert_eq!(value, serde_json::json!({ "kind": 2 }));

        let value = serde_json::to_value(Diff::Unrenderable).expect("serializes");
        assert_eq!(value, serde_json::json!({ "kind": 5 }));
    }

    #[test]
    fn text_and_large_text_differ_only_in_their_kind() {
        let data = TextDiffData {
            text: "body".to_owned(),
            hunks: Vec::new(),
            line_endings_change: None,
            max_line_number: 7,
            has_hidden_bidi_chars: false,
        };

        let text = serde_json::to_value(Diff::Text(data.clone())).expect("serializes");
        let large = serde_json::to_value(Diff::LargeText(data)).expect("serializes");

        assert_eq!(text["kind"], 0);
        assert_eq!(large["kind"], 4);
        assert_eq!(text["text"], large["text"]);
        assert_eq!(text["maxLineNumber"], large["maxLineNumber"]);
    }

    #[test]
    fn an_absent_line_endings_change_is_omitted_not_null() {
        let value = serde_json::to_value(Diff::Text(TextDiffData {
            text: String::new(),
            hunks: Vec::new(),
            line_endings_change: None,
            max_line_number: 0,
            has_hidden_bidi_chars: false,
        }))
        .expect("serializes");

        assert!(
            value.get("lineEndingsChange").is_none(),
            "`ITextDiffData` declares it optional, so it must be absent rather than null"
        );
    }

    #[test]
    fn a_diff_round_trips_through_json() {
        // The reason `Deserialize` is hand-written: an untagged enum could never tell Text from
        // LargeText, since they are structurally identical.
        for original in [
            Diff::Binary,
            Diff::Unrenderable,
            Diff::Text(TextDiffData {
                text: "t".to_owned(),
                hunks: Vec::new(),
                line_endings_change: Some(LineEndingsChange {
                    from: LineEnding::LF,
                    to: LineEnding::CRLF,
                }),
                max_line_number: 3,
                has_hidden_bidi_chars: true,
            }),
            Diff::LargeText(TextDiffData {
                text: "t".to_owned(),
                hunks: Vec::new(),
                line_endings_change: None,
                max_line_number: 3,
                has_hidden_bidi_chars: false,
            }),
            Diff::Submodule(SubmoduleDiffData {
                full_path: "/repo/sub".to_owned(),
                path: "sub".to_owned(),
                url: Some("https://example.invalid/sub.git".to_owned()),
                status: SubmoduleStatus {
                    commit_changed: true,
                    modified_changes: false,
                    untracked_changes: false,
                },
                old_sha: Some("a".repeat(40)),
                new_sha: Some("b".repeat(40)),
            }),
        ] {
            let json = serde_json::to_string(&original).expect("serializes");
            let back: Diff = serde_json::from_str(&json).expect("deserializes");
            assert_eq!(back, original, "round trip failed for {json}");
        }
    }

    // --- subproject commit extraction ---

    #[test]
    fn finds_the_submodule_shas() {
        let patch = "-Subproject commit aaaaaaa\n+Subproject commit bbbbbbb\n";
        assert_eq!(
            find_subproject_commit(patch, '-').as_deref(),
            Some("aaaaaaa")
        );
        assert_eq!(
            find_subproject_commit(patch, '+').as_deref(),
            Some("bbbbbbb")
        );
    }

    #[test]
    fn strips_the_dirty_marker_from_a_submodule_sha() {
        // git appends `-dirty` when the submodule's working tree has changes.
        let patch = "+Subproject commit bbbbbbb-dirty\n";
        assert_eq!(
            find_subproject_commit(patch, '+').as_deref(),
            Some("bbbbbbb")
        );
    }

    #[test]
    fn finds_no_sha_when_the_pointer_did_not_move() {
        assert_eq!(find_subproject_commit("some other patch\n", '-'), None);
    }

    // --- against real repositories ---

    #[tokio::test]
    async fn diffs_a_modified_file_against_head() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\ntwo\n", "first");
        std::fs::write(repo.path().join("a.txt"), "one\nTWO\n").expect("failed to write");

        let diff = get_working_directory_diff(repo.path(), "a.txt", &modified(), false)
            .await
            .expect("should diff");

        let data = expect_text(&diff);
        assert_eq!(data.hunks.len(), 1);

        let texts: Vec<&str> = data.hunks[0]
            .lines
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert!(texts.contains(&"-two"), "got {texts:?}");
        assert!(texts.contains(&"+TWO"), "got {texts:?}");
    }

    #[tokio::test]
    async fn diffs_an_untracked_file_as_all_additions() {
        // The `--no-index` path, where exit code 1 means "differences found".
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "x\n", "first");
        std::fs::write(repo.path().join("new.txt"), "alpha\nbeta\n").expect("failed to write");

        let diff = get_working_directory_diff(repo.path(), "new.txt", &untracked(), false)
            .await
            .expect("an untracked file should diff, not fail");

        let data = expect_text(&diff);
        let added: Vec<&str> = data.hunks[0]
            .lines
            .iter()
            .filter(|line| line.line_type == DiffLineType::Add)
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(added, vec!["+alpha", "+beta"]);
    }

    #[tokio::test]
    async fn reports_no_hunks_for_an_unchanged_file() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let diff = get_working_directory_diff(repo.path(), "a.txt", &modified(), false)
            .await
            .expect("should diff");

        assert!(expect_text(&diff).hunks.is_empty());
    }

    #[tokio::test]
    async fn hides_whitespace_changes_when_asked() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        std::fs::write(repo.path().join("a.txt"), "one   \n").expect("failed to write");

        let shown = get_working_directory_diff(repo.path(), "a.txt", &modified(), false)
            .await
            .expect("should diff");
        assert!(
            !expect_text(&shown).hunks.is_empty(),
            "a whitespace-only change is a change by default"
        );

        let hidden = get_working_directory_diff(repo.path(), "a.txt", &modified(), true)
            .await
            .expect("should diff");
        assert!(
            expect_text(&hidden).hunks.is_empty(),
            "and is suppressed with -w"
        );
    }

    #[tokio::test]
    async fn reports_a_binary_file_as_binary() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "x\n", "first");
        std::fs::write(repo.path().join("blob.bin"), [0_u8, 1, 2, 0, 255])
            .expect("failed to write");
        git(
            &["add", "--", "blob.bin"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("binary\n"),
        )
        .await
        .expect("commit should succeed");
        std::fs::write(repo.path().join("blob.bin"), [3_u8, 4, 5, 0, 254])
            .expect("failed to write");

        let diff = get_working_directory_diff(repo.path(), "blob.bin", &modified(), false)
            .await
            .expect("should diff");

        assert_eq!(diff.kind(), DiffType::Binary);
    }

    #[tokio::test]
    async fn diffs_a_file_in_a_commit_against_its_parent() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        let diff = get_commit_diff(repo.path(), "a.txt", &modified(), "HEAD", false)
            .await
            .expect("should diff");

        let texts: Vec<&str> = expect_text(&diff).hunks[0]
            .lines
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert!(texts.contains(&"-one"), "got {texts:?}");
        assert!(texts.contains(&"+two"), "got {texts:?}");
    }

    #[tokio::test]
    async fn diffs_a_renamed_file_in_a_commit_using_both_paths() {
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
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("renamed\n"),
        )
        .await
        .expect("commit should succeed");

        let status = AppFileStatus::Renamed {
            old_path: "before".to_owned(),
            submodule_status: None,
            rename_includes_modifications: false,
        };

        let diff = get_commit_diff(repo.path(), "after", &status, "HEAD", false)
            .await
            .expect("should diff");

        // A pure rename has no content change, so the diff carries a header and no hunks. Without the
        // source pathspec git would report nothing at all for the new path.
        assert!(expect_text(&diff).text.is_empty() || expect_text(&diff).hunks.is_empty());
    }

    #[tokio::test]
    async fn diffs_a_range_of_commits() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");
        commit_file(&repo.path(), "a.txt", "three\n", "third");

        let shas: Vec<String> = {
            let output = git(
                &["log", "--format=%H", "--reverse"],
                repo.path(),
                "test",
                GitOptions::default(),
            )
            .await
            .expect("log should succeed");
            output.stdout_lossy().lines().map(str::to_owned).collect()
        };

        // Second and third commits: the diff spans `second^` (the first) to the third.
        let diff = get_commit_range_diff(repo.path(), "a.txt", &modified(), &shas[1..], false)
            .await
            .expect("should diff");

        let texts: Vec<&str> = expect_text(&diff).hunks[0]
            .lines
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert!(texts.contains(&"-one"), "got {texts:?}");
        assert!(texts.contains(&"+three"), "got {texts:?}");
    }

    #[tokio::test]
    async fn falls_back_to_the_null_tree_when_the_oldest_commit_has_no_parent() {
        // `<root>^` doesn't resolve, so the first attempt reports a bad revision and the retry diffs
        // against the empty tree instead — presenting the file as entirely added.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\ntwo\n", "first");

        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        let diff = get_commit_range_diff(repo.path(), "a.txt", &modified(), &[sha], false)
            .await
            .expect("a root commit should fall back to the null tree");

        let data = expect_text(&diff);
        let added: Vec<&str> = data.hunks[0]
            .lines
            .iter()
            .filter(|line| line.line_type == DiffLineType::Add)
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(added, vec!["+one", "+two"]);
    }

    #[tokio::test]
    async fn diffing_no_commits_is_an_error() {
        let repo = empty_repository().await;
        assert!(matches!(
            get_commit_range_diff(repo.path(), "a.txt", &modified(), &[], false).await,
            Err(GitError::Parse { .. })
        ));
    }

    #[tokio::test]
    async fn reports_a_submodule_pointer_change() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "x\n", "first");

        // A second repository to embed. `file://` and the protocol allowance keep this offline.
        let sub = empty_repository().await;
        commit_file(&sub.path(), "inner", "one\n", "first");

        let url = format!("file://{}", sub.path().display());
        git(
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--",
                &url,
                "sub",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("submodule add should succeed");
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("add submodule\n"),
        )
        .await
        .expect("commit should succeed");

        // Move the submodule's pointer by committing inside it.
        commit_file(&sub.path(), "inner", "two\n", "second");
        git(
            &["-c", "protocol.file.allow=always", "fetch", "origin"],
            &repo.path().join("sub"),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("fetch should succeed");
        git(
            &["checkout", "FETCH_HEAD"],
            &repo.path().join("sub"),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        let status = AppFileStatus::Modified {
            submodule_status: Some(SubmoduleStatus {
                commit_changed: true,
                modified_changes: false,
                untracked_changes: false,
            }),
        };

        let diff = get_working_directory_diff(repo.path(), "sub", &status, false)
            .await
            .expect("should diff");

        match &diff {
            Diff::Submodule(data) => {
                assert_eq!(data.path, "sub");
                assert_eq!(data.url.as_deref(), Some(url.as_str()));
                assert!(data.full_path.ends_with("sub"));
                assert!(
                    data.old_sha.is_some() && data.new_sha.is_some(),
                    "a moved pointer should report both SHAs, got {data:?}"
                );
                assert_ne!(data.old_sha, data.new_sha);
            }
            other => panic!("expected a submodule diff, got {:?}", other.kind()),
        }
    }
}
