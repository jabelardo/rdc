//! Setting up the index to match what the user selected.
//!
//! Ported from `desktop-plus/app/src/lib/git/update-index.ts`.
//!
//! # What the frontend passes, and why
//!
//! The original's `stageFiles` took `WorkingDirectoryFileChange`, which carries a `DiffSelection` —
//! the per-line ticks the user has made in the UI. That is view state, so it doesn't belong in this
//! crate (the same reasoning as in [`crate::status`]). Instead the frontend sends a
//! [`FileToStage`] per fully-selected file, which is everything the index needs.
//!
//! # Deferred: partial selections
//!
//! The original routed partially-selected files through `applyPatchToIndex`, which builds a patch
//! from the `DiffSelection` and pipes it to `git apply --cached`. That needs the patch formatter
//! (`lib/patch-formatter.ts`) ported too, so it is **not implemented here** — see
//! `MIGRATION_MAP.md` §9. [`stage_files`] handles whole-file staging, which is what every
//! non-partial commit path needs.

use std::ffi::OsStr;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// A file the user has selected for staging in full.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileToStage {
    /// Path relative to the repository root.
    pub path: String,

    /// The path this file was renamed *from*, when the change is a rename or a copy.
    ///
    /// Renames need the old path removed from the index explicitly — see [`stage_files`].
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub old_path: Option<String>,

    /// Whether the file is gone from the working tree.
    #[serde(default)]
    pub deleted: bool,
}

impl FileToStage {
    /// A plain added or modified file.
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            old_path: None,
            deleted: false,
        }
    }

    /// A file that has been deleted from the working tree.
    pub fn deleted(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            old_path: None,
            deleted: true,
        }
    }

    /// A file renamed from `old_path` to `path`.
    pub fn renamed(path: impl Into<String>, old_path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            old_path: Some(old_path.into()),
            deleted: false,
        }
    }
}

/// How [`update_index`] should treat the paths it's given.
#[derive(Debug, Default, Clone, Copy)]
struct UpdateIndexOptions {
    /// Drop the paths from the index even if they still exist in the working tree.
    force_remove: bool,
}

/// Updates the index from the working tree for the given paths.
///
/// A no-op when `paths` is empty, matching the original — and necessary, because
/// `update-index --stdin` with no input would otherwise still run.
///
/// Paths go over stdin NUL-separated rather than as arguments: a repository can easily have more
/// changed paths than the platform's argument limit allows, and NUL framing is the only way to pass
/// a path containing a newline.
async fn update_index(
    repository: impl AsRef<Path>,
    paths: &[String],
    options: UpdateIndexOptions,
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut args: Vec<&OsStr> = vec![OsStr::new("update-index")];

    // The original computed these from an options struct whose fields all defaulted to "on"; only
    // `force_remove` ever varied, so the flags are spelled out here instead.
    args.push(OsStr::new("--add"));
    args.push(OsStr::new("--remove"));
    if options.force_remove {
        args.push(OsStr::new("--force-remove"));
    }
    args.push(OsStr::new("--replace"));
    args.push(OsStr::new("-z"));
    args.push(OsStr::new("--stdin"));

    let mut stdin = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if index > 0 {
            stdin.push(0);
        }
        stdin.extend_from_slice(path.as_bytes());
    }

    git(
        &args,
        repository,
        "updateIndex",
        GitOptions::default().with_stdin(stdin),
    )
    .await?;

    Ok(())
}

/// Stages the given files, so the index reflects what the user selected.
///
/// Assumes the index has just been cleared by [`crate::reset::unstage_all`]; its job is to build the
/// intended state up from nothing rather than to reconcile with what was there.
///
/// The three passes are the original's, and the order matters:
///
/// 1. **Force-remove the source of every rename.** Consider `git mv foo bar` followed by creating a
///    new `foo`. The change is `Renamed { path: "bar", old_path: "foo" }`, and there is *also* an
///    untracked `foo`. If the user staged the rename but not the new file, adding `bar` alone would
///    leave the old `foo` in the index, so the rename wouldn't be recorded. Removing `foo` first,
///    forcibly (it exists in the working tree again), reproduces the move.
/// 2. **Update the index from the working tree** for every selected path, which stages adds,
///    modifications, copies, and the destination of renames.
/// 3. **Force-remove deleted paths.** Step 2 can resurrect a deletion: `--remove` only drops a path
///    git considers gone, and a staged delete alongside an untracked file at the same path is
///    ambiguous. This pass makes the deletion stick.
pub async fn stage_files(
    repository: impl AsRef<Path>,
    files: &[FileToStage],
) -> Result<(), GitError> {
    let repository = repository.as_ref();

    let mut normal = Vec::new();
    let mut old_renamed = Vec::new();
    let mut deleted = Vec::new();

    for file in files {
        normal.push(file.path.clone());

        if let Some(old_path) = &file.old_path {
            old_renamed.push(old_path.clone());
        } else if file.deleted {
            deleted.push(file.path.clone());
        }
    }

    update_index(
        repository,
        &old_renamed,
        UpdateIndexOptions { force_remove: true },
    )
    .await?;

    update_index(repository, &normal, UpdateIndexOptions::default()).await?;

    update_index(
        repository,
        &deleted,
        UpdateIndexOptions { force_remove: true },
    )
    .await?;

    Ok(())
}

/// Paths currently staged, as `git diff --cached` reports them.
///
/// Used by `continue_cherry_pick` to decide whether anything remains to commit, as well as by tests.
pub(crate) async fn staged_paths(repository: impl AsRef<Path>) -> Vec<String> {
    let args: [&OsStr; 4] = [
        OsStr::new("diff"),
        OsStr::new("--cached"),
        OsStr::new("--name-only"),
        OsStr::new("-z"),
    ];

    let output = git(&args, repository, "test", GitOptions::default())
        .await
        .expect("diff --cached should succeed");

    output
        .stdout_lossy()
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The staged mode and path pairs, for asserting on renames and deletions.
#[cfg(test)]
async fn staged_status(repository: impl AsRef<Path>) -> Vec<(String, String)> {
    let output = git(
        &["diff", "--cached", "--name-status", "-M"],
        repository,
        "test",
        GitOptions::default(),
    )
    .await
    .expect("diff --cached should succeed");

    output
        .stdout_lossy()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            let status = parts.next().unwrap_or_default().to_owned();
            let path = parts.next_back().unwrap_or_default().to_owned();
            (status, path)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn stages_nothing_when_given_no_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");
        std::fs::write(repo.path().join("tracked"), "changed\n").expect("failed to write");

        stage_files(repo.path(), &[]).await.expect("should succeed");

        assert!(
            staged_paths(repo.path()).await.is_empty(),
            "an empty selection stages nothing"
        );
    }

    #[tokio::test]
    async fn stages_a_new_file() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");
        std::fs::write(repo.path().join("added"), "new\n").expect("failed to write");

        stage_files(repo.path(), &[FileToStage::new("added")])
            .await
            .expect("should succeed");

        assert_eq!(staged_paths(repo.path()).await, vec!["added".to_owned()]);
    }

    #[tokio::test]
    async fn stages_only_the_selected_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");
        std::fs::write(repo.path().join("wanted"), "yes\n").expect("failed to write");
        std::fs::write(repo.path().join("unwanted"), "no\n").expect("failed to write");

        stage_files(repo.path(), &[FileToStage::new("wanted")])
            .await
            .expect("should succeed");

        assert_eq!(staged_paths(repo.path()).await, vec!["wanted".to_owned()]);
    }

    #[tokio::test]
    async fn stages_a_deletion() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "doomed", "contents\n", "first");
        std::fs::remove_file(repo.path().join("doomed")).expect("failed to remove");

        stage_files(repo.path(), &[FileToStage::deleted("doomed")])
            .await
            .expect("should succeed");

        assert_eq!(
            staged_status(repo.path()).await,
            vec![("D".to_owned(), "doomed".to_owned())]
        );
    }

    #[tokio::test]
    async fn stages_a_rename_as_a_rename() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "before", "contents\n", "first");
        std::fs::rename(repo.path().join("before"), repo.path().join("after"))
            .expect("failed to rename");

        stage_files(repo.path(), &[FileToStage::renamed("after", "before")])
            .await
            .expect("should succeed");

        assert_eq!(
            staged_status(repo.path()).await,
            vec![("R100".to_owned(), "after".to_owned())],
            "git should recognize this as a rename, not an add plus a delete"
        );
    }

    #[tokio::test]
    async fn records_a_rename_even_when_a_new_file_takes_the_old_path() {
        // The scenario the first pass exists for, straight from the original's comment:
        //
        //     git mv foo bar && echo "I'm a new foo" > foo
        //
        // Staging only the rename must not pull the new `foo` into the commit, and must still
        // record that `foo` moved to `bar`.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "original\n", "first");
        std::fs::rename(repo.path().join("foo"), repo.path().join("bar"))
            .expect("failed to rename");
        std::fs::write(repo.path().join("foo"), "I'm a new foo\n").expect("failed to write");

        stage_files(repo.path(), &[FileToStage::renamed("bar", "foo")])
            .await
            .expect("should succeed");

        assert_eq!(
            staged_status(repo.path()).await,
            vec![("R100".to_owned(), "bar".to_owned())],
            "only the rename should be staged, and it should still read as a rename"
        );
    }

    #[tokio::test]
    async fn stages_a_deletion_even_when_an_untracked_file_takes_its_place() {
        // The third pass. Without it the second pass re-adds the path from the working tree and the
        // deletion is lost.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "doomed", "original\n", "first");
        std::fs::remove_file(repo.path().join("doomed")).expect("failed to remove");
        stage_files(repo.path(), &[FileToStage::deleted("doomed")])
            .await
            .expect("staging the delete should succeed");
        // An untracked file appears at the same path afterwards.
        std::fs::write(repo.path().join("doomed"), "reborn\n").expect("failed to write");

        stage_files(repo.path(), &[FileToStage::deleted("doomed")])
            .await
            .expect("should succeed");

        assert_eq!(
            staged_status(repo.path()).await,
            vec![("D".to_owned(), "doomed".to_owned())],
            "the deletion must survive the working-tree file reappearing"
        );
    }

    #[tokio::test]
    async fn handles_a_path_containing_a_newline() {
        // Why stdin is NUL-separated rather than newline-separated. git allows this path; a
        // line-based protocol would split it into two.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");

        let awkward = "we\nird";
        std::fs::write(repo.path().join(awkward), "contents\n").expect("failed to write");

        stage_files(repo.path(), &[FileToStage::new(awkward)])
            .await
            .expect("should succeed");

        assert_eq!(
            staged_paths(repo.path()).await,
            vec![awkward.to_owned()],
            "a newline in a path must survive the round trip"
        );
        // Guard the assertion itself: reading this back needed -z, so prove the path really does
        // contain the newline rather than the helper having split it away.
        assert!(awkward.contains('\n'));
    }
}
