//! Git commands exposed to the frontend.
//!
//! Thin wrappers over `git-ops`: they translate arguments and errors, and hold no logic of their
//! own. Anything worth testing lives in the crate, where it can be tested without a Tauri app.

use git_ops::checkout::CheckoutProgress;
use git_ops::checkout::CheckoutTarget;
use git_ops::commit::CommitOptions;
use git_ops::diff::{Diff, TextDiffData};
use git_ops::diff_index::IndexStatus;
use git_ops::for_each_ref::{Branch, TrackingBranch};
use git_ops::merge::{MergeOptions, MergeResult};
use git_ops::patch_formatter::LineSelection;
use git_ops::rebase::{
    MultiCommitOperationProgress, RebaseConflictResolution, RebaseResult, RebaseSnapshot,
};
use git_ops::stage::ManualConflictResolution;
use git_ops::status::{AppFileStatus, StatusResult};
use git_ops::status_parser::GitStatusEntry;
use git_ops::update_index::FileToStage;

use super::CommandError;
use tauri::ipc::Channel;

/// Reads the status of the repository at `repository_path`.
///
/// Returns `None` when the path isn't a git repository, which is a normal answer rather than an
/// error — see `git_ops::status::get_status`.
///
/// Invoked from the frontend as:
///
/// ```js
/// await invoke('get_status', { repositoryPath, listUntrackedFilesIndividually: true })
/// ```
///
/// Note `listUntrackedFilesIndividually` does **not** mean "include untracked files" — passing
/// `false` still reports them, just collapsing untracked directories. The parameter was renamed from
/// the original's misleading `includeUntracked` for exactly that reason.
#[tauri::command]
pub async fn get_status(
    repository_path: String,
    list_untracked_files_individually: bool,
) -> Result<Option<StatusResult>, CommandError> {
    // Owned `String` rather than `&str`: async commands can't take borrowed arguments.
    git_ops::status::get_status(&repository_path, list_untracked_files_individually)
        .await
        .map_err(CommandError::from)
}

/// Creates a commit containing exactly `files`, and returns its full SHA.
///
/// ```js
/// await invoke('create_commit', {
///   repositoryPath,
///   message: 'Fix the thing',
///   files: [{ path: 'src/thing.ts' }],
///   options: { amend: false, noVerify: false, signOff: false, allowEmpty: false },
/// })
/// ```
///
/// A file the user only partly ticked carries a `partial` selection instead of the index fields, and is
/// staged by applying a patch rather than by reading the working tree — see
/// `git_ops::update_index::PartialSelection`.
///
/// The SHA is the full 40-character one. The original returned git's abbreviation, and returned the
/// literal string `"(root-commit)"` for a repository's first commit; see `git_ops::commit`.
#[tauri::command]
pub async fn create_commit(
    repository_path: String,
    message: String,
    files: Vec<FileToStage>,
    options: Option<CommitOptions>,
) -> Result<String, CommandError> {
    // `options` is optional so the frontend can omit it entirely, matching the original's
    // `options?: { … }`. Absent means every flag off.
    git_ops::commit::create_commit(
        &repository_path,
        &message,
        &files,
        options.unwrap_or_default(),
    )
    .await
    .map_err(CommandError::from)
}

/// Creates the commit that concludes an in-progress merge, and returns its full SHA.
///
/// ```js
/// await invoke('create_merge_commit', {
///   repositoryPath,
///   files: [{ path: 'conflicted.txt' }],
///   manualResolutions: [['conflicted.txt', 'theirs']],
/// })
/// ```
///
/// `manualResolutions` is a list of pairs rather than an object because it maps paths to a choice and
/// a path is not a safe object key — it can be any byte string, including one that collides with
/// `Object.prototype` members. The original used a `Map` for the same reason.
#[tauri::command]
pub async fn create_merge_commit(
    repository_path: String,
    files: Vec<FileToStage>,
    manual_resolutions: Vec<(String, ManualConflictResolution)>,
) -> Result<String, CommandError> {
    git_ops::commit::create_merge_commit(&repository_path, &files, &manual_resolutions)
        .await
        .map_err(CommandError::from)
}

/// Checks out a local branch.
///
/// ```js
/// const onProgress = new Channel()
/// onProgress.onmessage = update => renderProgress(update)
/// await invoke('checkout_branch', { repositoryPath, name: 'topic', onProgress })
/// ```
#[tauri::command]
pub async fn checkout_branch(
    repository_path: String,
    name: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    git_ops::checkout::checkout_branch_with_progress(
        &repository_path,
        CheckoutTarget::Local(&name),
        move |progress| {
            // A closed webview must not cancel the git operation. There is no recipient anymore,
            // but checkout still needs to finish and leave the repository consistent.
            let _ = on_progress.send(progress);
        },
    )
    .await
    .map_err(CommandError::from)
}

/// Checks out a remote-tracking branch by creating a local branch from it.
///
/// ```js
/// await invoke('checkout_remote_branch', {
///   repositoryPath,
///   remoteRef: 'origin/topic',
///   localName: 'topic',
/// })
/// ```
///
/// Separate from [`checkout_branch`] rather than taking an optional `localName`, because the two are
/// genuinely different operations — this one creates a ref — and because a single command with an
/// optional field would make "which of these did I mean?" a runtime question.
///
/// Fails if `localName` already exists; git refuses to repoint an existing branch, and the UI needs
/// that failure to prompt.
#[tauri::command]
pub async fn checkout_remote_branch(
    repository_path: String,
    remote_ref: String,
    local_name: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    git_ops::checkout::checkout_branch_with_progress(
        &repository_path,
        CheckoutTarget::Remote {
            remote_ref: &remote_ref,
            local_name: &local_name,
        },
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await
    .map_err(CommandError::from)
}

/// Checks out a commit, leaving `HEAD` detached.
///
/// ```js
/// await invoke('checkout_commit', { repositoryPath, commit: sha })
/// ```
#[tauri::command]
pub async fn checkout_commit(
    repository_path: String,
    commit: String,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    git_ops::checkout::checkout_commit_with_progress(&repository_path, &commit, move |progress| {
        let _ = on_progress.send(progress);
    })
    .await
    .map_err(CommandError::from)
}

/// Restores the given paths from `HEAD`, discarding working-tree changes to them.
///
/// ```js
/// await invoke('checkout_paths', { repositoryPath, paths: ['src/thing.ts'] })
/// ```
///
/// **This discards the user's edits to those paths.** An empty list is a no-op, not "everything".
#[tauri::command]
pub async fn checkout_paths(
    repository_path: String,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    git_ops::checkout::checkout_paths(&repository_path, &paths)
        .await
        .map_err(CommandError::from)
}

/// Stages a conflicted file according to the side the user chose.
///
/// ```js
/// await invoke('stage_manual_conflict_resolution', {
///   repositoryPath,
///   path: 'conflicted.txt',
///   resolution: 'theirs',
/// })
/// ```
///
/// `entries` is the conflict's `[us, them]` index entries, from the file's `UnmergedEntry`. It is
/// optional, but supplying it is what lets a side that *deleted* the file resolve to a deletion
/// rather than to staging working-tree content.
#[tauri::command]
pub async fn stage_manual_conflict_resolution(
    repository_path: String,
    path: String,
    resolution: ManualConflictResolution,
    entries: Option<(GitStatusEntry, GitStatusEntry)>,
) -> Result<(), CommandError> {
    git_ops::stage::stage_manual_conflict_resolution_with_entries(
        &repository_path,
        &path,
        resolution,
        entries,
    )
    .await
    .map_err(CommandError::from)
}

/// Merges a branch into the current branch.
#[tauri::command]
pub async fn merge_branch(
    repository_path: String,
    branch: String,
    options: Option<MergeOptions>,
) -> Result<MergeResult, CommandError> {
    git_ops::merge::merge(&repository_path, &branch, options.unwrap_or_default())
        .await
        .map_err(CommandError::from)
}

/// Returns the common ancestor of two refs, or `None` when there isn't one or a ref is missing.
#[tauri::command]
pub async fn get_merge_base(
    repository_path: String,
    first_commitish: String,
    second_commitish: String,
) -> Result<Option<String>, CommandError> {
    git_ops::merge::get_merge_base(&repository_path, &first_commitish, &second_commitish)
        .await
        .map_err(CommandError::from)
}

/// Aborts an in-progress merge.
#[tauri::command]
pub async fn abort_merge(repository_path: String) -> Result<(), CommandError> {
    git_ops::merge::abort_merge(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Rebases `targetBranch` onto `baseBranch`.
#[tauri::command]
pub async fn rebase_branch(
    repository_path: String,
    base_branch: String,
    target_branch: String,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<RebaseResult, CommandError> {
    git_ops::rebase::rebase_with_progress(
        &repository_path,
        &base_branch,
        &target_branch,
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await
    .map_err(CommandError::from)
}

/// Stages the selected resolutions and continues an in-progress rebase.
#[tauri::command]
pub async fn continue_rebase(
    repository_path: String,
    files: Vec<FileToStage>,
    manual_resolutions: Vec<RebaseConflictResolution>,
    no_verify: bool,
    on_progress: Channel<MultiCommitOperationProgress>,
) -> Result<RebaseResult, CommandError> {
    git_ops::rebase::continue_rebase_with_progress(
        &repository_path,
        &files,
        &manual_resolutions,
        no_verify,
        move |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await
    .map_err(CommandError::from)
}

/// Aborts an in-progress rebase.
#[tauri::command]
pub async fn abort_rebase(repository_path: String) -> Result<(), CommandError> {
    git_ops::rebase::abort_rebase(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Returns recoverable progress for an in-progress rebase.
#[tauri::command]
pub async fn get_rebase_snapshot(
    repository_path: String,
) -> Result<Option<RebaseSnapshot>, CommandError> {
    git_ops::rebase::get_rebase_snapshot(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Lists branches, local and remote, in the order git reports them.
///
/// ```js
/// await invoke('get_branches', { repositoryPath, prefixes: [] })
/// // -> [{ name: 'main', upstream: 'origin/main', tip: { sha, author: { date } }, type: 0, ref: 'refs/heads/main', isGone: false }]
/// ```
///
/// `prefixes` narrows the ref namespaces; an empty list means `refs/heads` and `refs/remotes`.
///
/// The result is the **arguments `Branch`'s constructor takes**, not a `Branch` — its derived getters
/// (`remoteName`, `nameWithoutRemote`, …) stay in TypeScript. `type` is a number, since `BranchType`
/// is a numeric enum whose values also decide sort order.
///
/// A path that isn't a repository yields an empty list rather than an error.
#[tauri::command]
pub async fn get_branches(
    repository_path: String,
    prefixes: Vec<String>,
) -> Result<Vec<Branch>, CommandError> {
    git_ops::for_each_ref::get_branches(&repository_path, &prefixes)
        .await
        .map_err(CommandError::from)
}

/// Lists local branches whose tip differs from their upstream's.
///
/// ```js
/// await invoke('get_branches_differing_from_upstream', { repositoryPath })
/// ```
///
/// Feeds `fast_forward_branches`, which takes `(upstreamRef, ref)` pairs built from these. The current
/// branch and branches checked out in other worktrees are excluded — neither can be moved by a ref
/// update alone.
#[tauri::command]
pub async fn get_branches_differing_from_upstream(
    repository_path: String,
) -> Result<Vec<TrackingBranch>, CommandError> {
    git_ops::for_each_ref::get_branches_differing_from_upstream(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Lists what the index holds that `HEAD` does not, and how each path differs.
///
/// ```js
/// await invoke('get_index_changes', { repositoryPath })
/// // -> [['src/thing.ts', 4], ['added.ts', 1]]
/// ```
///
/// Pairs rather than an object, because a repository path is an arbitrary string and so is not a safe
/// JavaScript object key — the same reasoning as `manualResolutions` on `create_merge_commit`.
///
/// The status is a **number**: `IndexStatus` is a numeric enum in `src/models/index-status.ts`, and
/// the discriminant is the wire value.
///
/// A repository with no commits is handled, not rejected — the Rust side falls back to diffing
/// against the null tree, so everything staged reads as an addition.
#[tauri::command]
pub async fn get_index_changes(
    repository_path: String,
) -> Result<Vec<(String, IndexStatus)>, CommandError> {
    git_ops::diff_index::get_index_changes(&repository_path)
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
    )
    .await
    .map_err(CommandError::from)
}

/// Discards the selected lines of a file from the working tree.
///
/// ```js
/// await invoke('discard_changes_from_selection', {
///   repositoryPath,
///   filePath: 'src/thing.ts',
///   diff: dehydrateTextDiff(diff),   // the diff the user was looking at
///   selectedLines: [4, 5, 9],
/// })
/// ```
///
/// The diff is a **parameter rather than something the backend re-reads**, because `selectedLines`
/// indexes into the diff the user was shown. Re-reading could discard different lines; passing it means
/// a file that changed underneath makes git reject the patch instead.
///
/// An empty `selectedLines` is a no-op, not an error — nothing was asked for.
#[tauri::command]
pub async fn discard_changes_from_selection(
    repository_path: String,
    file_path: String,
    diff: TextDiffData,
    selected_lines: Vec<u32>,
) -> Result<(), CommandError> {
    git_ops::apply::discard_changes_from_selection(
        &repository_path,
        &file_path,
        &diff,
        &LineSelection::new(selected_lines),
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
    )
    .await
    .map_err(CommandError::from)
}
