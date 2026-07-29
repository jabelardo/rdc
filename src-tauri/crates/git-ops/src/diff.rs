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
//! **`getFilesDiffText`.** This remains with its store consumer. [`get_resolution_diff`] is
//! backend-local and complete; it needs full blob contents, so [`crate::show::get_blob_contents`] rather
//! than the capped read.
//! Git LFS installation, attributes, and transfer progress live in [`crate::lfs`] and
//! [`crate::progress`]; image previews remain deferred with the raw-bytes IPC decision above.

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
use crate::log::{parse_raw_log_with_numstat, ChangesetData};
use crate::merge::get_merge_base;
use crate::show::get_blob_contents;
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

/// Which version of a file a URL should serve.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum BlobSource {
    /// As of a commit, tag or anything else git resolves.
    Commit(String),

    /// As it is on disk right now.
    WorkingTree,
}

/// Mints URLs the webview can fetch a blob's bytes from.
///
/// # Why this is a trait
///
/// An image diff has to name bytes, and this crate cannot: a URL's shape belongs to the webview host, and
/// the table that maps a URL back to a blob is application state. So the app injects the minting — the same
/// arrangement as `HookSupport` in [`crate::hooks`], and for the same reason.
///
/// The alternative, base64 in the payload, is what upstream did and what this port deliberately does not:
/// a 4 MB PNG becomes ~5.5 MB of JSON, copied twice, resident for as long as the diff is open.
pub trait BlobUrls: Send + Sync {
    /// A URL serving `path` in `repository`, as of `source`.
    fn url_for(&self, repository: &Path, path: &str, source: BlobSource) -> String;
}

/// One side of an image diff.
///
/// Mirrors the `Image` class in `src/models/diff/image.ts`, which this port **changed**: upstream carried
/// base64 `contents` plus an `ArrayBuffer`, and it now carries a URL. Its only consumer builds an
/// `<img src>` from it — or, for a DirectDraw Surface texture, fetches the bytes to convert them — so a URL
/// serves both cases without either paying for base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    /// Where the webview can fetch the bytes.
    pub url: String,

    /// So the viewer can tell a DirectDraw Surface from something it can render directly.
    pub media_type: String,

    /// Size in bytes. The two-up view shows both sides' sizes and the difference between them, which is why
    /// this is worth a `cat-file -s` rather than being left out.
    pub bytes: u64,
}

/// An image diff: the file before, the file after, or both.
///
/// A side is absent when it does not exist — no `previous` for an added file, no `current` for a deleted
/// one. **Both** are absent for a conflicted binary, which is upstream's answer too: it would take showing
/// three versions and asking the user which they mean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDiffData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<ImageData>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<ImageData>,

    /// The text diff as well, for an SVG — which is text that can also be rendered.
    ///
    /// When present the viewer offers a "Code" tab first, which is upstream's behaviour; nothing is lost by
    /// showing an SVG both ways.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_diff: Option<TextDiffData>,
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
    /// A file the app can show as a picture — and an SVG, which it can show both ways.
    Image(ImageDiffData),
    Binary,
    Submodule(SubmoduleDiffData),
    Unrenderable,
}

/// The candidate resolution to compare with the conflict-marker file on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionDiffTarget<'a> {
    /// Caller-supplied resolved content, such as a Copilot suggestion.
    Content(&'a str),
    /// Stage 2 in Git's unmerged index.
    Ours,
    /// Stage 3 in Git's unmerged index.
    Theirs,
}

/// A resolution diff and the exact content of both sides used to produce it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionDiff {
    pub diff: Diff,
    pub old_contents: String,
    pub new_contents: String,
}

impl Diff {
    /// The discriminator the frontend switches on.
    pub fn kind(&self) -> DiffType {
        match self {
            Self::Text(_) => DiffType::Text,
            Self::LargeText(_) => DiffType::LargeText,
            Self::Image(_) => DiffType::Image,
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
            Self::Image(data) => {
                // Omitted rather than null: `previous` and `current` are optional properties on
                // `IImageDiff`, and a side that doesn't exist is absent rather than empty.
                if let Some(previous) = &data.previous {
                    map.serialize_entry("previous", previous)?;
                }
                if let Some(current) = &data.current {
                    map.serialize_entry("current", current)?;
                }
                if let Some(text) = &data.text_diff {
                    map.serialize_entry("textDiff", text)?;
                }
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
            previous: Option<ImageData>,
            current: Option<ImageData>,
            text_diff: Option<TextDiffData>,
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
            DiffType::Image => Ok(Self::Image(ImageDiffData {
                previous: any.previous,
                current: any.current,
                text_diff: any.text_diff,
            })),
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
#[allow(clippy::too_many_arguments)]
async fn build_diff(
    output: &[u8],
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    newest_commitish: &str,
    oldest_commitish: &str,
    line_endings_change: Option<LineEndingsChange>,
    side: DiffSide,
    blobs: Option<&dyn BlobUrls>,
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
        repository,
        path,
        status,
        data,
        newest_commitish,
        oldest_commitish,
        side,
        blobs,
    )
    .await)
}

/// Extensions the app can show as a picture.
///
/// `.dds` is **not** here, matching upstream's default: it gates DirectDraw Surface previews behind a
/// feature flag, and its converter is frontend code. Until that lands a `.dds` file is a binary diff, which
/// is what upstream shows with the flag off.
const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "avif"];

/// Whether `path` names something the app can show as a picture.
fn is_image_path(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    IMAGE_EXTENSIONS.contains(&extension.as_str())
}

/// Whether `path` is an SVG — text that can also be rendered.
fn is_svg_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
}

/// One side of an image diff, or `None` when that version doesn't exist.
///
/// The size comes from `git cat-file -s` for a committed blob — which answers without reading the object —
/// and from the filesystem for the working tree. Nothing here reads the bytes: that happens when the webview
/// fetches the URL, if it ever does.
///
/// A blob that can't be read yields `None` rather than an error, which also settles a TODO the original left
/// on `${oldestCommitish}^`: for a file added in a repository's first commit there is no parent to read, and
/// "no previous version" is exactly what an added file has.
async fn image_side(
    repository: &Path,
    path: &str,
    source: BlobSource,
    blobs: &dyn BlobUrls,
) -> Option<ImageData> {
    let bytes = match &source {
        BlobSource::Commit(commitish) => blob_size(repository, commitish, path).await?,
        BlobSource::WorkingTree => tokio::fs::metadata(repository.join(path)).await.ok()?.len(),
    };

    Some(ImageData {
        url: blobs.url_for(repository, path, source),
        media_type: media_type_for(path).to_owned(),
        bytes,
    })
}

/// The size of a blob, without reading it.
async fn blob_size(repository: &Path, commitish: &str, path: &str) -> Option<u64> {
    let output = git(
        &["cat-file", "-s", &format!("{commitish}:{path}")],
        repository,
        "blobSize",
        GitOptions::default(),
    )
    .await
    .ok()?;

    output.stdout_trimmed().parse().ok()
}

/// Builds an image diff for a file in the working tree.
///
/// `previous` comes from `HEAD` — of the *old* path when the file was renamed, or there would be nothing
/// there to read.
async fn working_tree_image_diff(
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    blobs: &dyn BlobUrls,
) -> ImageDiffData {
    // A conflicted binary gets neither side, which is upstream's answer as well: showing it properly would
    // mean rendering three versions and asking the user which they mean.
    if matches!(status, AppFileStatus::Conflicted(_)) {
        return ImageDiffData {
            previous: None,
            current: None,
            text_diff: None,
        };
    }

    let current = if matches!(status, AppFileStatus::Deleted { .. }) {
        None
    } else {
        image_side(repository, path, BlobSource::WorkingTree, blobs).await
    };

    let previous = if matches!(
        status,
        AppFileStatus::New { .. } | AppFileStatus::Untracked { .. }
    ) {
        None
    } else {
        let old_path = old_path_or_default(path, status);
        image_side(
            repository,
            old_path,
            BlobSource::Commit("HEAD".to_owned()),
            blobs,
        )
        .await
    };

    ImageDiffData {
        previous,
        current,
        text_diff: None,
    }
}

/// Builds an image diff for a file in a commit.
async fn commit_image_diff(
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    newest_commitish: &str,
    oldest_commitish: &str,
    blobs: &dyn BlobUrls,
) -> ImageDiffData {
    let current = if matches!(status, AppFileStatus::Deleted { .. }) {
        None
    } else {
        image_side(
            repository,
            path,
            BlobSource::Commit(newest_commitish.to_owned()),
            blobs,
        )
        .await
    };

    let old_path = old_path_or_default(path, status);
    let previous = if matches!(
        status,
        AppFileStatus::New { .. } | AppFileStatus::Untracked { .. }
    ) {
        None
    } else if matches!(status, AppFileStatus::Deleted { .. }) {
        // A deleted file exists in the commit's parent, and `oldest_commitish` is already that side of the
        // range for the caller that asks about one.
        image_side(
            repository,
            old_path,
            BlobSource::Commit(oldest_commitish.to_owned()),
            blobs,
        )
        .await
    } else {
        image_side(
            repository,
            old_path,
            BlobSource::Commit(format!("{oldest_commitish}^")),
            blobs,
        )
        .await
    };

    ImageDiffData {
        previous,
        current,
        text_diff: None,
    }
}

/// The path a change's *old* side lives at — the source of a rename, or the path itself.
fn old_path_or_default<'a>(path: &'a str, status: &'a AppFileStatus) -> &'a str {
    match status {
        AppFileStatus::Renamed { old_path, .. } | AppFileStatus::Copied { old_path, .. } => {
            old_path
        }
        _ => path,
    }
}

/// Classifies a parsed diff as text, image or binary.
///
/// The order is upstream's, and the SVG case comes first for a reason: an SVG is *text* that can also be
/// rendered, so it becomes an image diff that **also carries the text diff**, and the viewer offers both.
///
/// Without a [`BlobUrls`] to name bytes with, an image is reported as [`Diff::Binary`] — which is what the
/// app showed before this existed, and what it still shows when nothing asked for image previews.
#[allow(clippy::too_many_arguments)]
async fn convert_diff(
    raw: &RawDiff,
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    data: TextDiffData,
    newest_commitish: &str,
    oldest_commitish: &str,
    side: DiffSide,
    blobs: Option<&dyn BlobUrls>,
) -> Diff {
    let Some(blobs) = blobs else {
        return if raw.is_binary {
            Diff::Binary
        } else {
            Diff::Text(data)
        };
    };

    if is_svg_path(path) {
        let mut image = image_diff(
            repository,
            path,
            status,
            newest_commitish,
            oldest_commitish,
            side,
            blobs,
        )
        .await;

        // A binary SVG is a contradiction, but git decides what is binary — so only attach the text when it
        // actually parsed as text.
        if !raw.is_binary {
            image.text_diff = Some(data);
        }

        return Diff::Image(image);
    }

    if raw.is_binary {
        return if is_image_path(path) {
            Diff::Image(
                image_diff(
                    repository,
                    path,
                    status,
                    newest_commitish,
                    oldest_commitish,
                    side,
                    blobs,
                )
                .await,
            )
        } else {
            // Some format we have no way to present. Upstream's words: "never mind".
            Diff::Binary
        };
    }

    Diff::Text(data)
}

/// Which pair of versions an image diff compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiffSide {
    /// The working tree against `HEAD`.
    WorkingTree,
    /// Two revisions.
    Commits,
}

/// Dispatches to the working-tree or commit sides.
#[allow(clippy::too_many_arguments)]
async fn image_diff(
    repository: &Path,
    path: &str,
    status: &AppFileStatus,
    newest_commitish: &str,
    oldest_commitish: &str,
    side: DiffSide,
    blobs: &dyn BlobUrls,
) -> ImageDiffData {
    match side {
        DiffSide::WorkingTree => working_tree_image_diff(repository, path, status, blobs).await,
        DiffSide::Commits => {
            commit_image_diff(
                repository,
                path,
                status,
                newest_commitish,
                oldest_commitish,
                blobs,
            )
            .await
        }
    }
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

/// Diffs the conflict-marker file on disk against a proposed resolution.
pub async fn get_resolution_diff(
    repository: impl AsRef<Path>,
    path: &str,
    target: ResolutionDiffTarget<'_>,
    hide_whitespace: bool,
) -> Result<ResolutionDiff, GitError> {
    let repository = repository.as_ref();
    let working_tree_path = repository.join(path);
    let old_contents = tokio::fs::read(&working_tree_path)
        .await
        .map_err(|source| diff_file_error("getResolutionDiff", working_tree_path, source))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())?;

    let new_contents = match target {
        ResolutionDiffTarget::Content(contents) => contents.to_owned(),
        ResolutionDiffTarget::Ours | ResolutionDiffTarget::Theirs => {
            let stage = match target {
                ResolutionDiffTarget::Ours => ":2",
                ResolutionDiffTarget::Theirs => ":3",
                ResolutionDiffTarget::Content(_) => unreachable!("matched above"),
            };

            // A missing stage means that side deleted the file. The original catches every show
            // failure here and treats it as empty content, so a modify/delete conflict renders as
            // a complete deletion rather than failing the whole resolution view.
            get_blob_contents(repository, stage, path)
                .await
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default()
        }
    };

    let temporary_directory = tempfile::tempdir()
        .map_err(|source| diff_file_error("getResolutionDiff", repository.to_path_buf(), source))?;
    let base_path = temporary_directory.path().join("resolution-diff-base");
    let target_path = temporary_directory.path().join("resolution-diff-target");

    tokio::fs::write(&base_path, &old_contents)
        .await
        .map_err(|source| diff_file_error("getResolutionDiff", base_path.clone(), source))?;
    tokio::fs::write(&target_path, &new_contents)
        .await
        .map_err(|source| diff_file_error("getResolutionDiff", target_path.clone(), source))?;

    let mut args = vec!["diff".to_owned()];
    if hide_whitespace {
        args.push("-w".to_owned());
    }
    args.extend([
        "--no-ext-diff".to_owned(),
        "--patch-with-raw".to_owned(),
        "-z".to_owned(),
        "--no-color".to_owned(),
        "--no-index".to_owned(),
        "--".to_owned(),
        base_path.to_string_lossy().into_owned(),
        target_path.to_string_lossy().into_owned(),
    ]);

    let output = git(
        &args,
        repository,
        "getResolutionDiff",
        GitOptions::default().with_success_exit_codes([1]),
    )
    .await?;

    Ok(ResolutionDiff {
        diff: build_resolution_diff(&output.stdout)?,
        old_contents,
        new_contents,
    })
}

fn build_resolution_diff(output: &[u8]) -> Result<Diff, GitError> {
    if output.len() > MAX_DIFF_BUFFER_SIZE {
        return Ok(Diff::Unrenderable);
    }

    let raw = diff_from_raw_diff_output(output)?;
    let data = TextDiffData {
        text: raw.contents.clone(),
        hunks: raw.hunks.clone(),
        line_endings_change: None,
        max_line_number: raw.max_line_number,
        has_hidden_bidi_chars: raw.has_hidden_bidi_chars,
    };

    if output.len() >= MAX_REASONABLE_DIFF_SIZE || is_diff_too_large(&raw) {
        Ok(Diff::LargeText(data))
    } else {
        Ok(Diff::Text(data))
    }
}

fn diff_file_error(name: &str, path: PathBuf, source: std::io::Error) -> GitError {
    GitError::Spawn {
        name: name.to_owned(),
        path,
        source,
    }
}

/// The media type of a path, from its extension.
///
/// Ported from `getMediaType` in `diff.ts`. Used both for the `Content-Type` of a served blob and for the
/// value carried in an image diff — one source, so the two cannot disagree.
///
/// # `image/jpeg`, where upstream said `image/jpg`
///
/// `image/jpg` is not a registered media type; `image/jpeg` is. Checked before changing it: the only place
/// any consumer *compares* a media type is the DirectDraw Surface branch of `ImageContainer`, so nothing
/// depends on the wrong spelling. Serving a real type matters more here than it did upstream, because this
/// value becomes a `Content-Type` header rather than the middle of a `data:` URI.
///
/// `text/plain` is the fallback, which is what the original called "as per the spec".
pub fn media_type_for(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        // Not a registered type either, but it is what the DDS branch of the image viewer compares against,
        // so it has to stay spelled exactly this way.
        "dds" => "image/vnd-ms.dds",
        _ => "text/plain",
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
    blobs: Option<&dyn BlobUrls>,
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
        DiffSide::WorkingTree,
        blobs,
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
    blobs: Option<&dyn BlobUrls>,
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
        DiffSide::Commits,
        blobs,
    )
    .await
}

/// Diffs a file between two branches, from where they diverged.
///
/// `--merge-base` is what makes this a comparison rather than a difference: it diffs the comparison branch
/// against the point the two branches last shared, so commits the base branch has gained since don't appear as
/// though the comparison branch removed them.
///
/// `latest_commit` is the revision the resulting diff is *labelled* with — it names the version of the file the
/// user is looking at, which the diff itself doesn't carry.
#[allow(clippy::too_many_arguments)]
pub async fn get_branch_merge_base_diff(
    repository: impl AsRef<Path>,
    path: &str,
    status: &AppFileStatus,
    base_branch: &str,
    comparison_branch: &str,
    hide_whitespace: bool,
    latest_commit: &str,
    blobs: Option<&dyn BlobUrls>,
) -> Result<Diff, GitError> {
    let repository = repository.as_ref();

    let mut args = vec![
        "diff".to_owned(),
        "--merge-base".to_owned(),
        base_branch.to_owned(),
        comparison_branch.to_owned(),
    ];
    if hide_whitespace {
        args.push("-w".to_owned());
    }
    args.extend([
        "--patch-with-raw".to_owned(),
        "-z".to_owned(),
        "--no-color".to_owned(),
        "--".to_owned(),
    ]);
    push_pathspecs(&mut args, path, status);

    let output = git(
        &args,
        repository,
        "getBranchMergeBaseDiff",
        GitOptions::default(),
    )
    .await?;

    build_diff(
        &output.stdout,
        repository,
        path,
        status,
        latest_commit,
        latest_commit,
        None,
        DiffSide::Commits,
        blobs,
    )
    .await
}

/// What changed between two branches, from where they diverged.
///
/// `None` means the branches have **no common ancestor**, so there is no point to compare from — unrelated
/// histories, which is a real state rather than a failure.
pub async fn get_branch_merge_base_changed_files(
    repository: impl AsRef<Path>,
    base_branch: &str,
    comparison_branch: &str,
    latest_comparison_commit: &str,
) -> Result<Option<ChangesetData>, GitError> {
    let repository = repository.as_ref();

    // Asked first, because its answer decides whether the diff is meaningful at all — and it is also what the
    // changed files are attributed *from*.
    let Some(merge_base) = get_merge_base(repository, base_branch, comparison_branch).await? else {
        return Ok(None);
    };

    let output = git(
        &[
            "diff",
            "--merge-base",
            base_branch,
            comparison_branch,
            // `-C` before `-M`: reversing them means copies are never detected, as `get_changed_files` also
            // notes.
            "-C",
            "-M",
            "-z",
            "--raw",
            "--numstat",
            "--",
        ],
        repository,
        "getBranchMergeBaseChangedFiles",
        GitOptions::default(),
    )
    .await?;

    parse_raw_log_with_numstat(
        &output.stdout_lossy(),
        latest_comparison_commit,
        &merge_base,
    )
    .map(Some)
}

/// What changed across a range of commits, oldest first.
///
/// The oldest commit's **parent** is the starting point, since a range's first commit is part of what changed.
/// When that parent doesn't exist — the first commit of a repository — the diff is retried against git's empty
/// tree, which is what makes the range readable at all.
///
/// Written as a two-iteration loop rather than the original's recursive retry, so it is evident the retry
/// happens at most once. [`get_commit_range_diff`] made the same choice about the same pattern.
pub async fn get_commit_range_changed_files(
    repository: impl AsRef<Path>,
    shas: &[String],
) -> Result<ChangesetData, GitError> {
    let repository = repository.as_ref();

    let (Some(oldest), Some(latest)) = (shas.first(), shas.last()) else {
        return Err(GitError::Parse {
            context: "getCommitRangeChangedFiles".to_owned(),
            message: "a commit range needs at least one commit".to_owned(),
        });
    };

    for use_null_tree in [false, true] {
        let oldest_ref = if use_null_tree {
            NULL_TREE_SHA.to_owned()
        } else {
            format!("{oldest}^")
        };

        let output = git(
            &[
                "diff",
                &oldest_ref,
                latest,
                "-C",
                "-M",
                "-z",
                "--raw",
                "--numstat",
                "--",
            ],
            repository,
            "getCommitRangeChangedFiles",
            GitOptions::default().with_expected_errors([GitErrorKind::BadRevision]),
        )
        .await?;

        if output.git_error == Some(GitErrorKind::BadRevision) && !use_null_tree {
            continue;
        }

        return parse_raw_log_with_numstat(&output.stdout_lossy(), latest, &oldest_ref);
    }

    unreachable!("the loop returns on its second iteration")
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
    blobs: Option<&dyn BlobUrls>,
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
            DiffSide::Commits,
            blobs,
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

    async fn repository_with_conflict(
        base: &str,
        ours: &str,
        theirs: Option<&str>,
    ) -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file.txt", base, "base");

        git(
            &["checkout", "-b", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("feature checkout should succeed");
        match theirs {
            Some(contents) => commit_file(&repo.path(), "file.txt", contents, "feature"),
            None => {
                git(
                    &["rm", "--", "file.txt"],
                    repo.path(),
                    "test",
                    GitOptions::default(),
                )
                .await
                .expect("feature deletion should succeed");
                git(
                    &["commit", "-m", "feature deletes file"],
                    repo.path(),
                    "test",
                    GitOptions::default(),
                )
                .await
                .expect("feature deletion commit should succeed");
            }
        }

        git(
            &["checkout", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("main checkout should succeed");
        commit_file(&repo.path(), "file.txt", ours, "main");

        git(
            &["merge", "feature", "--no-commit"],
            repo.path(),
            "test",
            GitOptions::default().with_success_exit_codes([1]),
        )
        .await
        .expect("the deliberately conflicting merge should run");

        repo
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

        let diff = get_working_directory_diff(repo.path(), "a.txt", &modified(), false, None)
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

        let diff = get_working_directory_diff(repo.path(), "new.txt", &untracked(), false, None)
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

        let diff = get_working_directory_diff(repo.path(), "a.txt", &modified(), false, None)
            .await
            .expect("should diff");

        assert!(expect_text(&diff).hunks.is_empty());
    }

    #[tokio::test]
    async fn hides_whitespace_changes_when_asked() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        std::fs::write(repo.path().join("a.txt"), "one   \n").expect("failed to write");

        let shown = get_working_directory_diff(repo.path(), "a.txt", &modified(), false, None)
            .await
            .expect("should diff");
        assert!(
            !expect_text(&shown).hunks.is_empty(),
            "a whitespace-only change is a change by default"
        );

        let hidden = get_working_directory_diff(repo.path(), "a.txt", &modified(), true, None)
            .await
            .expect("should diff");
        assert!(
            expect_text(&hidden).hunks.is_empty(),
            "and is suppressed with -w"
        );
    }

    #[tokio::test]
    async fn diffs_resolved_content_against_the_on_disk_file() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file.txt", "original\n", "init");

        let result = get_resolution_diff(
            repo.path(),
            "file.txt",
            ResolutionDiffTarget::Content("modified\n"),
            false,
        )
        .await
        .expect("resolution diff should succeed");

        let text = &expect_text(&result.diff).text;
        assert!(text.contains("-original"), "got {text}");
        assert!(text.contains("+modified"), "got {text}");
        assert_eq!(result.old_contents, "original\n");
        assert_eq!(result.new_contents, "modified\n");
    }

    #[tokio::test]
    async fn diffs_ours_against_the_conflict_marker_file() {
        let repo = repository_with_conflict(
            "line 1\nline 2\nline 3\n",
            "line 1\nmain change\nline 3\n",
            Some("line 1\nfeature change\nline 3\n"),
        )
        .await;

        let result =
            get_resolution_diff(repo.path(), "file.txt", ResolutionDiffTarget::Ours, false)
                .await
                .expect("ours diff should succeed");

        let text = &expect_text(&result.diff).text;
        assert!(text.contains("-feature change"), "got {text}");
        assert!(result.old_contents.contains("<<<<<<<"));
        assert_eq!(result.new_contents, "line 1\nmain change\nline 3\n");
    }

    #[tokio::test]
    async fn diffs_theirs_against_the_conflict_marker_file() {
        let repo = repository_with_conflict(
            "line 1\nline 2\nline 3\n",
            "line 1\nmain change\nline 3\n",
            Some("line 1\nfeature change\nline 3\n"),
        )
        .await;

        let result =
            get_resolution_diff(repo.path(), "file.txt", ResolutionDiffTarget::Theirs, false)
                .await
                .expect("theirs diff should succeed");

        let text = &expect_text(&result.diff).text;
        assert!(text.contains("-main change"), "got {text}");
        assert_eq!(result.new_contents, "line 1\nfeature change\nline 3\n");
    }

    #[tokio::test]
    async fn missing_stage_blob_is_an_empty_resolution() {
        let repo = repository_with_conflict("base content\n", "main modified\n", None).await;

        let result =
            get_resolution_diff(repo.path(), "file.txt", ResolutionDiffTarget::Theirs, false)
                .await
                .expect("a deleted stage should produce a deletion diff");

        let text = &expect_text(&result.diff).text;
        assert!(text.contains("-main modified"), "got {text}");
        assert!(result.new_contents.is_empty());
    }

    #[tokio::test]
    async fn resolution_diff_can_hide_whitespace_changes() {
        let repo = repository_with_conflict(
            "hello world\n",
            "hello world\nother\n",
            Some("hello  world\nextra\n"),
        )
        .await;

        let result =
            get_resolution_diff(repo.path(), "file.txt", ResolutionDiffTarget::Theirs, true)
                .await
                .expect("whitespace-hidden resolution diff should succeed");

        let text = &expect_text(&result.diff).text;
        assert!(text.contains("extra"), "got {text}");
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

        let diff = get_working_directory_diff(repo.path(), "blob.bin", &modified(), false, None)
            .await
            .expect("should diff");

        assert_eq!(diff.kind(), DiffType::Binary);
    }

    #[tokio::test]
    async fn diffs_a_file_in_a_commit_against_its_parent() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        let diff = get_commit_diff(repo.path(), "a.txt", &modified(), "HEAD", false, None)
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

        let diff = get_commit_diff(repo.path(), "after", &status, "HEAD", false, None)
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
        let diff =
            get_commit_range_diff(repo.path(), "a.txt", &modified(), &shas[1..], false, None)
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

        let diff = get_commit_range_diff(repo.path(), "a.txt", &modified(), &[sha], false, None)
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
            get_commit_range_diff(repo.path(), "a.txt", &modified(), &[], false, None).await,
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

        let diff = get_working_directory_diff(repo.path(), "sub", &status, false, None)
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
    #[test]
    fn reports_the_media_type_of_an_image() {
        assert_eq!(media_type_for("a.png"), "image/png");
        assert_eq!(media_type_for("deep/dir/a.webp"), "image/webp");
        assert_eq!(media_type_for("icon.ico"), "image/x-icon");
    }

    #[test]
    fn spells_jpeg_the_way_the_registry_does() {
        // Upstream answered `image/jpg`, which is not a registered media type. Safe to correct: the only
        // consumer that compares a media type at all is the DirectDraw Surface branch of the image viewer.
        assert_eq!(media_type_for("a.jpg"), "image/jpeg");
        assert_eq!(media_type_for("a.jpeg"), "image/jpeg");
    }

    #[test]
    fn keeps_the_dds_spelling_a_consumer_depends_on() {
        assert_eq!(media_type_for("texture.dds"), "image/vnd-ms.dds");
    }

    #[test]
    fn ignores_the_case_of_an_extension() {
        // `.PNG` is an ordinary way to name a file, and an extension is not case-sensitive to a browser.
        assert_eq!(media_type_for("A.PNG"), "image/png");
        assert_eq!(media_type_for("A.JpG"), "image/jpeg");
    }

    #[test]
    fn falls_back_to_text_for_anything_else() {
        assert_eq!(media_type_for("notes.txt"), "text/plain");
        assert_eq!(media_type_for("Makefile"), "text/plain");
        assert_eq!(media_type_for(""), "text/plain");
    }
    // --- image diffs ---

    /// Mints predictable URLs, so a test can assert on what a diff names.
    struct TestBlobs;

    impl BlobUrls for TestBlobs {
        fn url_for(&self, _repository: &Path, path: &str, source: BlobSource) -> String {
            match source {
                BlobSource::WorkingTree => format!("test://working/{path}"),
                BlobSource::Commit(commitish) => format!("test://{commitish}/{path}"),
            }
        }
    }

    /// A tiny PNG — the signature is enough for git to call it binary.
    const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

    #[tokio::test]
    async fn a_modified_image_diffs_as_a_picture_with_both_sides() {
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("logo.png"), PNG).expect("failed to write");
        commit_all(&repo.path(), "adds a logo").await;
        std::fs::write(
            repo.path().join("logo.png"),
            [PNG.as_slice(), &[1, 2, 3]].concat(),
        )
        .expect("failed to write");

        let diff = get_working_directory_diff(
            repo.path(),
            "logo.png",
            &modified(),
            false,
            Some(&TestBlobs),
        )
        .await
        .expect("diffing should succeed");

        match diff {
            Diff::Image(image) => {
                let current = image.current.expect("the working tree has it");
                let previous = image.previous.expect("HEAD has it");
                assert_eq!(current.url, "test://working/logo.png");
                assert_eq!(previous.url, "test://HEAD/logo.png");
                assert_eq!(current.media_type, "image/png");
                // Sizes come from `cat-file -s` and the filesystem, not from reading the blobs.
                assert_eq!(previous.bytes, PNG.len() as u64);
                assert_eq!(current.bytes, PNG.len() as u64 + 3);
                assert!(image.text_diff.is_none(), "a PNG has no text to show");
            }
            other => panic!("expected an image diff, got {:?}", other.kind()),
        }
    }

    #[tokio::test]
    async fn an_added_image_has_no_previous_side() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        std::fs::write(repo.path().join("new.png"), PNG).expect("failed to write");

        let diff = get_working_directory_diff(
            repo.path(),
            "new.png",
            &untracked(),
            false,
            Some(&TestBlobs),
        )
        .await
        .expect("diffing should succeed");

        match diff {
            Diff::Image(image) => {
                assert!(image.current.is_some());
                assert!(
                    image.previous.is_none(),
                    "there is no earlier version to show"
                );
            }
            other => panic!("expected an image diff, got {:?}", other.kind()),
        }
    }

    #[tokio::test]
    async fn an_svg_is_a_picture_and_a_text_diff() {
        // Text that can also be rendered, so the viewer offers both.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "icon.svg", "<svg/>\n", "first");
        std::fs::write(repo.path().join("icon.svg"), "<svg viewBox=\"0 0 1 1\"/>\n")
            .expect("failed to write");

        let diff = get_working_directory_diff(
            repo.path(),
            "icon.svg",
            &modified(),
            false,
            Some(&TestBlobs),
        )
        .await
        .expect("diffing should succeed");

        match diff {
            Diff::Image(image) => {
                assert_eq!(
                    image.current.expect("a current side").media_type,
                    "image/svg+xml"
                );
                let text = image.text_diff.expect("an SVG carries its text diff too");
                assert!(text.text.contains("viewBox"), "{}", text.text);
            }
            other => panic!("expected an image diff, got {:?}", other.kind()),
        }
    }

    #[tokio::test]
    async fn without_url_minting_an_image_is_still_binary() {
        // What the app showed before this existed, and what it shows when nothing asked for previews.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("logo.png"), PNG).expect("failed to write");
        commit_all(&repo.path(), "adds a logo").await;
        std::fs::write(
            repo.path().join("logo.png"),
            [PNG.as_slice(), &[9]].concat(),
        )
        .expect("failed to write");

        let diff = get_working_directory_diff(repo.path(), "logo.png", &modified(), false, None)
            .await
            .expect("diffing should succeed");

        assert_eq!(diff.kind(), DiffType::Binary);
    }

    #[tokio::test]
    async fn a_binary_that_is_not_an_image_stays_binary() {
        // Upstream's words for this branch: "some extension we don't know how to parse, never mind".
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("blob.bin"), [0_u8, 1, 2, 0, 255])
            .expect("failed to write");
        commit_all(&repo.path(), "adds a blob").await;
        std::fs::write(repo.path().join("blob.bin"), [3_u8, 4, 5, 0, 254])
            .expect("failed to write");

        let diff = get_working_directory_diff(
            repo.path(),
            "blob.bin",
            &modified(),
            false,
            Some(&TestBlobs),
        )
        .await
        .expect("diffing should succeed");

        assert_eq!(diff.kind(), DiffType::Binary);
    }

    #[tokio::test]
    async fn a_renamed_image_reads_its_previous_side_from_the_old_path() {
        // The old path is where the earlier version lives; the new one has nothing at `HEAD`.
        //
        // The content changes as well as the name: a rename that changes nothing produces a diff with no
        // binary marker, so git — and therefore upstream — reports it as text. There is no picture to show
        // when neither side differs.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("before.png"), PNG).expect("failed to write");
        commit_all(&repo.path(), "adds it").await;
        std::fs::rename(
            repo.path().join("before.png"),
            repo.path().join("after.png"),
        )
        .expect("failed to rename");
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");
        std::fs::write(
            repo.path().join("after.png"),
            [PNG.as_slice(), &[7, 7, 7]].concat(),
        )
        .expect("failed to write");

        let status = AppFileStatus::Renamed {
            old_path: "before.png".to_owned(),
            submodule_status: None,
            rename_includes_modifications: true,
        };
        let diff =
            get_working_directory_diff(repo.path(), "after.png", &status, false, Some(&TestBlobs))
                .await
                .expect("diffing should succeed");

        match diff {
            Diff::Image(image) => {
                assert_eq!(
                    image.previous.expect("the old path has it").url,
                    "test://HEAD/before.png"
                );
            }
            other => panic!("expected an image diff, got {:?}", other.kind()),
        }
    }

    /// Stages and commits everything.
    async fn commit_all(repo: &Path, message: &str) {
        git(&["add", "-A"], repo, "test", GitOptions::default())
            .await
            .expect("add should succeed");
        git(
            &["commit", "-m", message],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("commit should succeed");
    }
    // --- comparing branches and ranges ---

    /// Two branches that diverged: `main` gained a commit after `topic` branched off it.
    async fn diverged_repository() -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "shared.txt", "base\n", "base");
        git(
            &["checkout", "-q", "-b", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "on-topic.txt", "topic\n", "topic work");
        git(
            &["checkout", "-q", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "on-main.txt", "main\n", "main work");
        repo
    }

    #[tokio::test]
    async fn compares_a_branch_from_where_it_diverged() {
        // What `--merge-base` buys: the commit `main` gained afterwards must not read as though `topic` deleted
        // it. Diffing the two tips directly would show exactly that.
        let repo = diverged_repository().await;

        let files = get_branch_merge_base_changed_files(repo.path(), "main", "topic", "topic")
            .await
            .expect("the query should succeed")
            .expect("the branches share an ancestor");

        let paths: Vec<&str> = files.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["on-topic.txt"], "only the topic branch's work");
        assert_eq!(files.lines_added, 1);
        assert_eq!(files.lines_deleted, 0);
    }

    #[tokio::test]
    async fn reports_none_for_branches_with_no_common_ancestor() {
        // Unrelated histories are a real state, not a failure: there is no point to compare from.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        git(
            &["checkout", "-q", "--orphan", "unrelated"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "b.txt", "two\n", "unrelated first");

        let files =
            get_branch_merge_base_changed_files(repo.path(), "main", "unrelated", "unrelated")
                .await
                .expect("no common ancestor is an answer");

        assert!(files.is_none());
    }

    #[tokio::test]
    async fn diffs_one_file_from_where_two_branches_diverged() {
        let repo = diverged_repository().await;
        // Change a file that exists on both sides, so the diff has content either way.
        git(
            &["checkout", "-q", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(
            &repo.path(),
            "shared.txt",
            "changed on topic\n",
            "edit shared",
        );

        let diff = get_branch_merge_base_diff(
            repo.path(),
            "shared.txt",
            &modified(),
            "main",
            "topic",
            false,
            "topic",
            None,
        )
        .await
        .expect("diffing should succeed");

        let text = diff.text_data().expect("a text diff");
        assert!(text.text.contains("changed on topic"), "{}", text.text);
    }

    #[tokio::test]
    async fn reports_what_changed_across_a_range() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        let first = head_sha(&repo.path()).await;
        commit_file(&repo.path(), "a.txt", "two\n", "second");
        commit_file(&repo.path(), "b.txt", "new\n", "third");
        let last = head_sha(&repo.path()).await;

        let files = get_commit_range_changed_files(repo.path(), &[first, last])
            .await
            .expect("the query should succeed");

        let mut paths: Vec<&str> = files.files.iter().map(|file| file.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            vec!["a.txt", "b.txt"],
            "the range starts at the oldest commit's parent, so its own change is included"
        );
    }

    #[tokio::test]
    async fn reads_a_range_starting_at_a_repositorys_first_commit() {
        // `<sha>^` doesn't resolve for a root commit, which is what the retry against the empty tree is for.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        let root = head_sha(&repo.path()).await;

        let files = get_commit_range_changed_files(repo.path(), &[root.clone(), root])
            .await
            .expect("a root commit's range must still be readable");

        assert_eq!(
            files.files.len(),
            1,
            "everything in the first commit reads as added"
        );
        assert_eq!(files.lines_added, 1);
    }

    #[tokio::test]
    async fn refuses_an_empty_range() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert!(get_commit_range_changed_files(repo.path(), &[])
            .await
            .is_err());
    }

    /// The SHA at `HEAD`.
    async fn head_sha(repo: &Path) -> String {
        git(&["rev-parse", "HEAD"], repo, "test", GitOptions::default())
            .await
            .expect("rev-parse should succeed")
            .stdout_trimmed()
    }
}
