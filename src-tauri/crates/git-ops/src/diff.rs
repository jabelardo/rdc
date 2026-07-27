//! Diff queries.
//!
//! Ported from `desktop-plus/app/src/lib/git/diff.ts`, which is 1,032 lines. Only
//! `getBinaryPaths` and its two private helpers are ported here — that is all `status` needs. The
//! rest (diff rendering, image diffs, blob fetching) lands when the diff UI is ported.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_delimiter_parser::LogParser;

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
