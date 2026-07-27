//! Detecting leftover conflict markers.
//!
//! Ported from `desktop-plus/app/src/lib/git/diff-check.ts`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Files containing leftover conflict markers, and how many each has.
///
/// `git diff --check` exits 2 when it finds problems, which is the interesting case rather than a
/// failure — hence it being declared a success code.
pub async fn get_files_with_conflict_markers(
    repository: impl AsRef<Path>,
) -> Result<HashMap<String, usize>, GitError> {
    let output = git(
        &["diff", "--check"],
        repository,
        "getFilesWithConflictMarkers",
        GitOptions::default().with_success_exit_codes([2]),
    )
    .await?;

    let mut files = HashMap::new();
    for captures in marker_pattern().captures_iter(&output.stdout_lossy()) {
        if let Some(path) = captures.get(1) {
            *files.entry(path.as_str().to_owned()).or_insert(0) += 1;
        }
    }

    Ok(files)
}

/// `^(.+):\d+: leftover conflict marker` per line.
///
/// `(?m)` so `^` anchors per line, matching the original's `/gm` flags.
fn marker_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?m)^(.+):\d+: leftover conflict marker").expect("pattern is valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

    #[tokio::test]
    async fn finds_no_markers_in_a_clean_repository() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let files = get_files_with_conflict_markers(repo.path())
            .await
            .expect("diff --check should succeed");
        assert!(files.is_empty(), "got {files:?}");
    }

    #[tokio::test]
    async fn counts_markers_in_a_conflicted_file() {
        let repo = conflicted_repository().await;

        let files = get_files_with_conflict_markers(repo.path())
            .await
            .expect("diff --check should succeed and report markers");

        // The conflicted file is `foo`; git reports one line per marker it finds.
        assert!(
            files.contains_key("foo"),
            "expected 'foo' to have markers, got {files:?}"
        );
        assert!(
            files["foo"] >= 1,
            "expected at least one marker, got {}",
            files["foo"]
        );
    }

    #[test]
    fn parses_multiple_markers_across_files() {
        // The counting is the part worth pinning down, and it's easier to be exact about it
        // against known output than against whatever git emits for a given conflict.
        let stdout = "\
a.txt:3: leftover conflict marker
a.txt:7: leftover conflict marker
b.txt:1: leftover conflict marker
";
        let mut files: HashMap<String, usize> = HashMap::new();
        for captures in marker_pattern().captures_iter(stdout) {
            if let Some(path) = captures.get(1) {
                *files.entry(path.as_str().to_owned()).or_insert(0) += 1;
            }
        }

        assert_eq!(files.get("a.txt"), Some(&2));
        assert_eq!(files.get("b.txt"), Some(&1));
    }

    #[test]
    fn ignores_other_diff_check_complaints() {
        // `diff --check` also reports whitespace errors, which are not conflict markers.
        let stdout = "a.txt:3: trailing whitespace.\n+foo \n";
        assert_eq!(marker_pattern().captures_iter(stdout).count(), 0);
    }
}
