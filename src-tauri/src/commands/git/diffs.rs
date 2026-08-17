//! Diff queries.
//!
//! One module rather than a split across `changes` and `history`, mirroring the frontend's
//! `lib/diff/`: both features ask for diffs, and the commands answering them are the same shape
//! whichever view asked.

use crate::blob_protocol::BlobRegistry;
use crate::commands::CommandError;
use git_ops::diff::Diff;
use git_ops::log::ChangesetData;
use git_ops::status::AppFileStatus;
use tauri::State;

/// Diffs a file between two branches, from where they diverged.
///
/// ```js
/// await invoke('get_branch_merge_base_diff', {
///   repositoryPath, path, status, baseBranch: 'main', comparisonBranch: 'topic',
///   latestCommit: sha, hideWhitespace: false,
/// })
/// ```
///
/// `--merge-base` is what makes this a comparison rather than a difference: commits the base branch gained
/// after the two diverged would otherwise read as though the comparison branch removed them.
///
/// `latestCommit` labels the result — it names the version of the file being shown, which the diff itself does
/// not carry.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_branch_merge_base_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    base_branch: String,
    comparison_branch: String,
    latest_commit: String,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_branch_merge_base_diff(
        &repository_path,
        &path,
        &status,
        &base_branch,
        &comparison_branch,
        hide_whitespace.unwrap_or(false),
        &latest_commit,
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

/// What changed between two branches, from where they diverged.
///
/// ```js
/// await invoke('get_branch_merge_base_changed_files', {
///   repositoryPath, baseBranch: 'main', comparisonBranch: 'topic', latestComparisonCommit: sha,
/// })
/// ```
///
/// `null` means the branches have **no common ancestor** — unrelated histories, which is a real state rather
/// than a failure, and there is no point to compare from.
#[tauri::command]
pub async fn get_branch_merge_base_changed_files(
    repository_path: String,
    base_branch: String,
    comparison_branch: String,
    latest_comparison_commit: String,
) -> Result<Option<ChangesetData>, CommandError> {
    git_ops::diff::get_branch_merge_base_changed_files(
        &repository_path,
        &base_branch,
        &comparison_branch,
        &latest_comparison_commit,
    )
    .await
    .map_err(CommandError::from)
}

/// What changed across a range of commits, oldest first.
///
/// ```js
/// await invoke('get_commit_range_changed_files', { repositoryPath, shas: [oldest, newest] })
/// ```
///
/// The oldest commit's **parent** is the starting point, so the range includes its own change. A branch's first
/// commit works without the caller doing anything: `<sha>^` doesn't resolve there, and the Rust side retries
/// against git's empty tree.
#[tauri::command]
pub async fn get_commit_range_changed_files(
    repository_path: String,
    shas: Vec<String>,
) -> Result<ChangesetData, CommandError> {
    git_ops::diff::get_commit_range_changed_files(&repository_path, &shas)
        .await
        .map_err(CommandError::from)
}

/// Diffs a file in the working directory.
///
/// ```js
/// await invoke('get_working_directory_diff', {
///   repositoryPath,
///   path: 'src/thing.ts',
///   status: file.status,     // the AppFileStatus from getStatus()
///   hideWhitespace: false,
/// })
/// ```
///
/// `status` is passed straight back from `get_status`, because how a file is diffed depends on it: a
/// new or untracked file has nothing to compare against, a rename needs its source path, and a
/// submodule is described rather than diffed.
///
/// `kind` in the result is a **number** — `DiffType` is a numeric enum in `src/models/diff`.
#[tauri::command]
pub async fn get_working_directory_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_working_directory_diff(
        &repository_path,
        &path,
        &status,
        hide_whitespace.unwrap_or(false),
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

/// Diffs a file in a commit against that commit's first parent.
///
/// ```js
/// await invoke('get_commit_diff', { repositoryPath, path, status, commitish: sha })
/// ```
#[tauri::command]
pub async fn get_commit_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    commitish: String,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_commit_diff(
        &repository_path,
        &path,
        &status,
        &commitish,
        hide_whitespace.unwrap_or(false),
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}

/// Diffs a file across a range of commits.
///
/// ```js
/// await invoke('get_commit_range_diff', { repositoryPath, path, status, commits: [oldest, newest] })
/// ```
///
/// `commits` must be non-empty and ordered oldest first. When the oldest has no parent the Rust side
/// retries against git's empty tree, so a branch's first commit works without the caller knowing.
#[tauri::command]
pub async fn get_commit_range_diff(
    blobs: State<'_, BlobRegistry>,
    repository_path: String,
    path: String,
    status: AppFileStatus,
    commits: Vec<String>,
    hide_whitespace: Option<bool>,
) -> Result<Diff, CommandError> {
    git_ops::diff::get_commit_range_diff(
        &repository_path,
        &path,
        &status,
        &commits,
        hide_whitespace.unwrap_or(false),
        Some(&*blobs),
    )
    .await
    .map_err(CommandError::from)
}
