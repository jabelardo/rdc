//! Branch operations exposed to the frontend.
//!
//! Thin wrappers over `git-ops`, like the rest of `commands`. Split from `git.rs` because branches are their
//! own domain in the store layer and that module is already long; the `git-ops` side keeps the per-file
//! mapping to upstream.
//!
//! Listing branches lives in `git.rs` alongside the other read-only queries — `get_branches` and
//! `get_branches_differing_from_upstream` came over with `for-each-ref.ts`. Deleting a *remote* branch lives
//! in `remote.rs`, because it pushes.

use std::collections::HashMap;

use super::CommandError;

/// Creates a branch, without checking it out.
///
/// ```js
/// await invoke('create_branch', { repositoryPath, name: 'topic', startPoint: 'main', noTrack: false })
/// ```
///
/// `startPoint` defaults to `HEAD`. `noTrack` matters when branching from a *remote* branch: without it git
/// would set that remote branch as the upstream, which makes the rest of the app treat it as the push target
/// — likely a fork's upstream rather than the user's own.
#[tauri::command]
pub async fn create_branch(
    repository_path: String,
    name: String,
    start_point: Option<String>,
    no_track: Option<bool>,
) -> Result<(), CommandError> {
    git_ops::branch::create_branch(
        &repository_path,
        &name,
        start_point.as_deref(),
        no_track.unwrap_or(false),
    )
    .await
    .map_err(CommandError::from)
}

/// Renames a branch.
///
/// ```js
/// await invoke('rename_branch', { repositoryPath, currentName: 'topic', newName: 'feature' })
/// ```
///
/// `force` omitted is not the same as `false`: omitted lets a **case-only** rename through by retrying with
/// `-M`, which is what a user asking to change `Topic` to `topic` means on a case-insensitive filesystem.
/// Passing `false` refuses any collision, and `true` forces every one — see `git_ops::branch`.
#[tauri::command]
pub async fn rename_branch(
    repository_path: String,
    current_name: String,
    new_name: String,
    force: Option<bool>,
) -> Result<(), CommandError> {
    git_ops::branch::rename_branch(&repository_path, &current_name, &new_name, force)
        .await
        .map_err(CommandError::from)
}

/// Deletes a local branch, whether or not it has been merged.
///
/// ```js
/// await invoke('delete_local_branch', { repositoryPath, branchName: 'topic' })
/// ```
///
/// Uses `-D`, so an unmerged branch goes too: the app asks the user first, and git's own refusal would arrive
/// as a failure the UI has already ruled out.
#[tauri::command]
pub async fn delete_local_branch(
    repository_path: String,
    branch_name: String,
) -> Result<(), CommandError> {
    git_ops::branch::delete_local_branch(&repository_path, &branch_name)
        .await
        .map_err(CommandError::from)
}

/// Branch names whose tip is `committish`.
///
/// ```js
/// await invoke('get_branches_pointed_at', { repositoryPath, committish: 'HEAD' })
/// // -> ['main', 'topic']
/// ```
///
/// `null` means the committish didn't resolve, which is different from an empty array — no branch points at a
/// commit that exists is an answer, and asking about a commit that doesn't is a mistake.
#[tauri::command]
pub async fn get_branches_pointed_at(
    repository_path: String,
    committish: String,
) -> Result<Option<Vec<String>>, CommandError> {
    git_ops::branch::get_branches_pointed_at(&repository_path, &committish)
        .await
        .map_err(CommandError::from)
}

/// Branches merged into `branchName`, as `[canonicalRef, tipSha]` pairs.
///
/// ```js
/// await invoke('get_merged_branches', { repositoryPath, branchName: 'main' })
/// // -> [['refs/heads/topic', 'a1b2c3…']]
/// ```
///
/// Pairs rather than an object, because a ref name is an arbitrary string and so isn't a safe JavaScript
/// object key — the same reasoning as `manualResolutions` and the tag list.
///
/// `branchName` itself is excluded: it is trivially merged into itself, and including it would make every
/// caller filter it out.
#[tauri::command]
pub async fn get_merged_branches(
    repository_path: String,
    branch_name: String,
) -> Result<Vec<(String, String)>, CommandError> {
    let merged: HashMap<String, String> =
        git_ops::branch::get_merged_branches(&repository_path, &branch_name)
            .await
            .map_err(CommandError::from)?;

    // Sorted, because a HashMap's order is arbitrary and a list that reshuffles between calls would make the
    // UI re-render for no reason.
    let mut pairs: Vec<(String, String)> = merged.into_iter().collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));

    Ok(pairs)
}

/// Deletes a ref.
///
/// ```js
/// await invoke('delete_ref', { repositoryPath, refName: 'refs/remotes/origin/topic' })
/// ```
///
/// Deleting a ref that doesn't exist **succeeds**: git treats it as idempotent, so a caller needn't check
/// first. `reason` goes into the reflog of the ref being deleted, which is removed along with it — so it has
/// no observable effect and exists only because the original passed one; see `git_ops::update_ref`.
#[tauri::command]
pub async fn delete_ref(
    repository_path: String,
    ref_name: String,
    reason: Option<String>,
) -> Result<(), CommandError> {
    git_ops::update_ref::delete_ref(&repository_path, &ref_name, reason.as_deref())
        .await
        .map_err(CommandError::from)
}

/// What a symbolic ref points at, or `null` if it isn't one.
///
/// ```js
/// await invoke('get_symbolic_ref', { repositoryPath, refName: 'HEAD' })
/// // -> 'refs/heads/main'
/// ```
#[tauri::command]
pub async fn get_symbolic_ref(
    repository_path: String,
    ref_name: String,
) -> Result<Option<String>, CommandError> {
    git_ops::refs::get_symbolic_ref(&repository_path, &ref_name)
        .await
        .map_err(CommandError::from)
}
