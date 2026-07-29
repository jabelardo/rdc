//! Applying patches, for partial staging and partial discards.
//!
//! Ported from `desktop-plus/app/src/lib/git/apply.ts`.
//!
//! This is what closes `update_index`'s deferral: staging *some* lines of a file works by generating a
//! patch describing only those lines (see [`crate::patch_formatter`]) and applying it to the index.

use std::path::Path;

use crate::diff::{get_working_directory_diff, Diff, TextDiffData};
use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::patch_formatter::{format_patch, format_patch_to_discard_changes, LineSelection};
use crate::status::AppFileStatus;

/// Stages only the selected lines of a file.
///
/// The diff is fetched here rather than taken from the caller, matching the original: the patch has to
/// describe the file as it is *now*, and a stale diff would produce one `git apply` rejects.
///
/// The three `apply` flags all matter:
///
/// - **`--cached`** applies to the index only, leaving the working tree alone — the whole point of
///   partial staging.
/// - **`--unidiff-zero`** stops git looking for surrounding context to confirm the patch's position. A
///   partial patch legitimately has hunks whose context was rewritten (an unselected deletion turned into
///   context), so the usual check would reject it.
/// - **`--whitespace=nowarn`** keeps git from complaining about whitespace it would normally flag; the
///   content came from the file itself, so there is nothing for the user to act on.
///
/// Fails for a binary, submodule or oversized diff. A partial commit needs lines to select, and those
/// have none — the caller should stage the whole file instead.
pub async fn apply_patch_to_index(
    repository: impl AsRef<Path>,
    path: &str,
    status: &AppFileStatus,
    selection: &LineSelection,
) -> Result<(), GitError> {
    let repository = repository.as_ref();

    if let AppFileStatus::Renamed { old_path, .. } = status {
        recreate_rename_in_index(repository, path, old_path).await?;
    }

    // No `BlobUrls`: a patch is built from text, and an image diff has no lines to select — the arm below
    // rejects it either way.
    let diff = get_working_directory_diff(repository, path, status, false, None).await?;

    let text = match &diff {
        Diff::Text(data) | Diff::LargeText(data) => data,
        Diff::Unrenderable => {
            return Err(GitError::Parse {
                context: "applyPatchToIndex".to_owned(),
                message: format!("the diff for {path} is too large to build a partial commit from"),
            });
        }
        other => {
            return Err(GitError::Parse {
                context: "applyPatchToIndex".to_owned(),
                message: format!(
                    "cannot build a partial commit for {path}: it has no selectable lines ({:?})",
                    other.kind()
                ),
            });
        }
    };

    let patch = format_patch(path, status, text, selection)?;

    git(
        &[
            "apply",
            "--cached",
            "--unidiff-zero",
            "--whitespace=nowarn",
            "-",
        ],
        repository,
        "applyPatchToIndex",
        GitOptions::default().with_stdin(patch),
    )
    .await?;

    Ok(())
}

/// Re-stages a rename that clearing the index destroyed.
///
/// `create_commit` resets the index before staging, which loses the rename, so it has to be rebuilt
/// before a content patch can target the new path. Effectively a hand-rolled `git mv` against the index.
///
/// **`add --update` rather than `update-index --force-remove`**, and the original explained why: someone
/// may have staged a rename and then recreated a file at the *original* path, and there is no guarantee
/// about the order partial and whole-file staging happen in. With `add --update` the worst case is
/// re-staging something already staged; with `--force-remove` it would be deleting a file that should
/// stay.
async fn recreate_rename_in_index(
    repository: &Path,
    new_path: &str,
    old_path: &str,
) -> Result<(), GitError> {
    git(
        &["add", "--update", "--", old_path],
        repository,
        "applyPatchToIndex",
        GitOptions::default(),
    )
    .await?;

    // `<mode> SP <type> SP <object> TAB <path>`
    let listing = git(
        &["ls-tree", "HEAD", "--", old_path],
        repository,
        "applyPatchToIndex",
        GitOptions::default(),
    )
    .await?;

    let stdout = listing.stdout_lossy();
    let Some((mode, oid)) = parse_ls_tree_entry(&stdout) else {
        return Err(GitError::Parse {
            context: "applyPatchToIndex".to_owned(),
            message: format!("could not read the tree entry for {old_path}: {stdout:?}"),
        });
    };

    // Adds the *old* blob under the *new* name, which is what makes it a rename rather than a rewrite.
    git(
        &["update-index", "--add", "--cacheinfo", mode, oid, new_path],
        repository,
        "applyPatchToIndex",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

/// Extracts the mode and object id from one `git ls-tree` line.
fn parse_ls_tree_entry(stdout: &str) -> Option<(&str, &str)> {
    // Everything before the tab describes the object; the path follows it.
    let info = stdout.split('\t').next()?;
    let mut fields = info.split(' ');

    let mode = fields.next()?;
    let _object_type = fields.next()?;
    let oid = fields.next()?;

    (!mode.is_empty() && !oid.is_empty()).then_some((mode, oid))
}

/// Discards the selected lines from the working tree.
///
/// The diff is a **parameter** here, unlike [`apply_patch_to_index`], because the selection's line indices
/// only mean anything against the diff the user was looking at. Re-fetching could silently discard
/// different lines; passing it through means a file that has changed underneath makes `git apply` fail
/// instead, which is the safe outcome.
///
/// No `--cached`: this one is meant to change the working tree.
///
/// An empty selection is a no-op rather than an error — [`format_patch_to_discard_changes`] returns
/// nothing to apply and this skips git entirely.
pub async fn discard_changes_from_selection(
    repository: impl AsRef<Path>,
    path: &str,
    diff: &TextDiffData,
    selection: &LineSelection,
) -> Result<(), GitError> {
    let Some(patch) = format_patch_to_discard_changes(path, diff, selection) else {
        return Ok(());
    };

    git(
        &["apply", "--unidiff-zero", "--whitespace=nowarn", "-"],
        repository,
        "discardChangesFromSelection",
        GitOptions::default().with_stdin(patch),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, TempRepository};
    use crate::update_index::staged_paths;

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

    /// The diff of `path`, which the tests need in order to pick line indices.
    async fn text_diff(repo: &Path, path: &str, status: &AppFileStatus) -> TextDiffData {
        match get_working_directory_diff(repo, path, status, false, None)
            .await
            .expect("diffing should succeed")
        {
            Diff::Text(data) | Diff::LargeText(data) => data,
            other => panic!("expected a text diff, got {:?}", other.kind()),
        }
    }

    /// The absolute index of the first line whose text matches.
    fn index_of(diff: &TextDiffData, text: &str) -> u32 {
        for hunk in &diff.hunks {
            for (offset, line) in hunk.lines.iter().enumerate() {
                if line.text == text {
                    return hunk.unified_diff_start + u32::try_from(offset).expect("small");
                }
            }
        }
        panic!("no line {text:?} in the diff");
    }

    /// What the index holds for a path.
    async fn staged_contents(repo: &Path, path: &str) -> String {
        git(
            &["show", &format!(":{path}")],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("show should succeed")
        .stdout_lossy()
        .into_owned()
    }

    async fn repo_with_three_lines() -> TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\ntwo\nthree\n", "first");
        repo
    }

    // --- ls-tree parsing ---

    #[test]
    fn reads_the_mode_and_object_from_a_tree_entry() {
        let stdout = "100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\tbefore.txt\n";
        assert_eq!(
            parse_ls_tree_entry(stdout),
            Some(("100644", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"))
        );
    }

    #[test]
    fn reads_nothing_from_empty_ls_tree_output() {
        // What git prints when the path isn't in the tree.
        assert_eq!(parse_ls_tree_entry(""), None);
        assert_eq!(parse_ls_tree_entry("\n"), None);
    }

    // --- partial staging ---

    #[tokio::test]
    async fn stages_only_the_selected_line() {
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nTHREE\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;
        // Stage only the first change: drop "one", add "ONE".
        let selection = LineSelection::new([index_of(&diff, "-one"), index_of(&diff, "+ONE")]);

        apply_patch_to_index(repo.path(), "a.txt", &modified(), &selection)
            .await
            .expect("applying should succeed");

        assert_eq!(
            staged_contents(&repo.path(), "a.txt").await,
            "ONE\ntwo\nthree\n",
            "only the first line's change is staged"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "ONE\ntwo\nTHREE\n",
            "the working tree keeps both changes"
        );
    }

    #[tokio::test]
    async fn stages_an_addition_without_its_paired_deletion() {
        // The case that needs an unselected deletion turned into context, and the reason
        // `--unidiff-zero` is passed — the rewritten context would otherwise fail git's position check.
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "one\nTWO\nthree\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;
        let selection = LineSelection::new([index_of(&diff, "+TWO")]);

        apply_patch_to_index(repo.path(), "a.txt", &modified(), &selection)
            .await
            .expect("applying should succeed");

        assert_eq!(
            staged_contents(&repo.path(), "a.txt").await,
            "one\ntwo\nTWO\nthree\n",
            "the new line is staged while the old one is claimed to still exist"
        );
        // The order follows the diff: git emits the deletion before the addition, so the line that
        // replaces the deletion as context stays ahead of it.
    }

    #[tokio::test]
    async fn stages_some_lines_of_an_untracked_file() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "x\n", "first");
        std::fs::write(repo.path().join("new.txt"), "one\ntwo\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "new.txt", &untracked()).await;
        let selection = LineSelection::new([index_of(&diff, "+one")]);

        apply_patch_to_index(repo.path(), "new.txt", &untracked(), &selection)
            .await
            .expect("applying should succeed");

        assert_eq!(
            staged_contents(&repo.path(), "new.txt").await,
            "one\n",
            "the unselected addition is absent from the index entirely"
        );
    }

    #[tokio::test]
    async fn leaves_the_working_tree_alone_when_staging() {
        // `--cached` is what makes partial staging possible at all.
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nthree\n").expect("failed to write");
        let before = std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;
        let selection = LineSelection::new([index_of(&diff, "-one"), index_of(&diff, "+ONE")]);

        apply_patch_to_index(repo.path(), "a.txt", &modified(), &selection)
            .await
            .expect("applying should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            before
        );
    }

    #[tokio::test]
    async fn stages_a_partial_change_to_a_renamed_file() {
        // Follows what a partial commit actually does: git only reports a rename once it is staged, and
        // `create_commit` resets the index before staging, so the rename has to be rebuilt before a
        // content patch has anything to target.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "before.txt", "one\ntwo\n", "first");
        git(
            &["mv", "before.txt", "after.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("mv should succeed");
        std::fs::write(repo.path().join("after.txt"), "ONE\ntwo\n").expect("failed to write");

        let status = AppFileStatus::Renamed {
            old_path: "before.txt".to_owned(),
            submodule_status: None,
            rename_includes_modifications: true,
        };

        // The selection comes from the diff the user was shown, while the rename was still staged.
        let diff = text_diff(&repo.path(), "after.txt", &status).await;
        let selection = LineSelection::new([index_of(&diff, "-one"), index_of(&diff, "+ONE")]);

        // What `create_commit` does first, and what loses the rename.
        git(&["reset"], repo.path(), "test", GitOptions::default())
            .await
            .expect("reset should succeed");

        apply_patch_to_index(repo.path(), "after.txt", &status, &selection)
            .await
            .expect("applying should succeed");

        let staged = staged_paths(repo.path()).await;
        assert!(
            staged.contains(&"after.txt".to_owned()),
            "the new path is staged: {staged:?}"
        );
        assert!(
            !staged.contains(&"before.txt".to_owned()),
            "and the old one is gone: {staged:?}"
        );
        assert_eq!(
            staged_contents(&repo.path(), "after.txt").await,
            "ONE\ntwo\n"
        );
    }

    #[tokio::test]
    async fn refuses_a_partial_commit_of_a_binary_file() {
        // There are no lines to select, so the caller has to stage the whole file.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked.txt", "x\n", "first");
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

        let error = apply_patch_to_index(
            repo.path(),
            "blob.bin",
            &modified(),
            &LineSelection::new([1]),
        )
        .await
        .expect_err("a binary file has no selectable lines");

        assert!(matches!(error, GitError::Parse { .. }), "got {error:?}");
    }

    #[tokio::test]
    async fn refuses_to_stage_an_empty_selection() {
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nthree\n").expect("failed to write");

        assert!(matches!(
            apply_patch_to_index(repo.path(), "a.txt", &modified(), &LineSelection::default())
                .await,
            Err(GitError::Parse { .. })
        ));
    }

    // --- partial discards ---

    #[tokio::test]
    async fn discards_only_the_selected_line() {
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nTHREE\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;
        let selection = LineSelection::new([index_of(&diff, "-one"), index_of(&diff, "+ONE")]);

        discard_changes_from_selection(repo.path(), "a.txt", &diff, &selection)
            .await
            .expect("discarding should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "one\ntwo\nTHREE\n",
            "the first change is undone and the second kept"
        );
    }

    #[tokio::test]
    async fn discards_every_change_when_everything_is_selected() {
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nTHREE\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;
        let all: Vec<u32> = diff
            .hunks
            .iter()
            .flat_map(|hunk| {
                (0..hunk.lines.len()).map(move |offset| hunk.unified_diff_start + offset as u32)
            })
            .collect();

        discard_changes_from_selection(repo.path(), "a.txt", &diff, &LineSelection::new(all))
            .await
            .expect("discarding should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "one\ntwo\nthree\n"
        );
    }

    #[tokio::test]
    async fn discarding_nothing_changes_nothing_and_runs_no_git() {
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nthree\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;

        discard_changes_from_selection(repo.path(), "a.txt", &diff, &LineSelection::default())
            .await
            .expect("an empty selection is a no-op");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "ONE\ntwo\nthree\n",
            "the working tree is untouched"
        );
    }

    #[tokio::test]
    async fn a_discard_fails_rather_than_guessing_when_the_file_has_moved_on() {
        // Why the diff is a parameter: the selection's indices only mean anything against the diff the
        // user saw. If the file changed underneath, git rejects the patch instead of discarding the wrong
        // lines.
        let repo = repo_with_three_lines().await;
        std::fs::write(repo.path().join("a.txt"), "ONE\ntwo\nthree\n").expect("failed to write");

        let diff = text_diff(&repo.path(), "a.txt", &modified()).await;
        let selection = LineSelection::new([index_of(&diff, "-one"), index_of(&diff, "+ONE")]);

        // The file changes after the diff was taken.
        std::fs::write(repo.path().join("a.txt"), "something else entirely\n")
            .expect("failed to write");

        assert!(
            discard_changes_from_selection(repo.path(), "a.txt", &diff, &selection)
                .await
                .is_err(),
            "a stale patch must be rejected, not applied"
        );
    }
}
