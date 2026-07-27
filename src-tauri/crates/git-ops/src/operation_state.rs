//! Detecting in-progress merge, squash, cherry-pick and rebase operations.
//!
//! These are the marker files git writes into the git directory while an operation is underway.
//! In `desktop-plus` they were scattered across `lib/git/merge.ts` (`isMergeHeadSet`,
//! `isSquashMsgSet`), `lib/git/cherry-pick.ts` (`isCherryPickHeadFound`) and `lib/git/rebase.ts`
//! (`isRebaseHeadSet`, `getRebaseInternalState`) — each a couple of lines within a much larger
//! module. They are collected here because `status` needs exactly this set and nothing else from
//! those files; the rest of each module lands with its own port.
//!
//! Every function takes the **git directory**, not the repository path. The originals each
//! recomputed `repository.resolvedGitDir` internally; taking it as a parameter means `get_status`
//! resolves it once (see [`crate::rev_parse::resolve_git_dir`]) and these stay pure filesystem
//! checks with no process spawning.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::fs;

/// Whether a merge is in progress (`MERGE_HEAD` exists).
pub async fn is_merge_head_set(git_dir: impl AsRef<Path>) -> bool {
    path_exists(git_dir.as_ref().join("MERGE_HEAD")).await
}

/// Whether a `merge --squash` has been started (`SQUASH_MSG` exists).
pub async fn is_squash_msg_set(git_dir: impl AsRef<Path>) -> bool {
    path_exists(git_dir.as_ref().join("SQUASH_MSG")).await
}

/// Whether a cherry-pick is in progress (`CHERRY_PICK_HEAD` exists).
pub async fn is_cherry_pick_head_found(git_dir: impl AsRef<Path>) -> bool {
    path_exists(git_dir.as_ref().join("CHERRY_PICK_HEAD")).await
}

/// Whether a rebase is in progress (`REBASE_HEAD` exists).
pub async fn is_rebase_head_set(git_dir: impl AsRef<Path>) -> bool {
    path_exists(git_dir.as_ref().join("REBASE_HEAD")).await
}

/// Any error is treated as "not present".
///
/// Matches the originals: `isCherryPickHeadFound` explicitly caught and warned, on the grounds
/// that if the marker can't be read it isn't safe to assume an operation is underway.
async fn path_exists(path: impl AsRef<Path>) -> bool {
    fs::metadata(path).await.is_ok()
}

/// What git records about an in-progress rebase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseInternalState {
    /// The branch whose commits are being rebased.
    pub target_branch: String,
    /// The commit the rebase is replaying onto.
    pub base_branch_tip: String,
    /// Where the target branch pointed before the rebase started.
    pub original_branch_tip: String,
}

/// Reads the state of an in-progress rebase, or `None` if there isn't one.
///
/// Returns `None` rather than an error when the marker exists but the `rebase-merge` files can't
/// be read or are incomplete: the original swallowed those failures and treated the rebase state
/// as unresolvable, which is the safer answer — a half-read rebase state would be worse than
/// admitting we don't know.
pub async fn get_rebase_internal_state(git_dir: impl AsRef<Path>) -> Option<RebaseInternalState> {
    let git_dir = git_dir.as_ref();

    if !is_rebase_head_set(git_dir).await {
        return None;
    }

    let rebase_merge = git_dir.join("rebase-merge");
    let original_branch_tip = read_trimmed(rebase_merge.join("orig-head")).await?;
    let head_name = read_trimmed(rebase_merge.join("head-name")).await?;
    let base_branch_tip = read_trimmed(rebase_merge.join("onto")).await?;

    // head-name is a full ref; the app wants the short branch name.
    let target_branch = head_name
        .strip_prefix("refs/heads/")
        .unwrap_or(&head_name)
        .to_owned();

    Some(RebaseInternalState {
        target_branch,
        base_branch_tip,
        original_branch_tip,
    })
}

async fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    let contents = fs::read_to_string(path).await.ok()?;
    Some(contents.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

    async fn git_dir(repo: &Path) -> std::path::PathBuf {
        crate::rev_parse::resolve_git_dir(repo)
            .await
            .expect("resolving the git dir should succeed")
    }

    #[tokio::test]
    async fn reports_no_operation_in_a_clean_repository() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");
        let git_dir = git_dir(&repo.path()).await;

        assert!(!is_merge_head_set(&git_dir).await);
        assert!(!is_squash_msg_set(&git_dir).await);
        assert!(!is_cherry_pick_head_found(&git_dir).await);
        assert!(!is_rebase_head_set(&git_dir).await);
        assert_eq!(get_rebase_internal_state(&git_dir).await, None);
    }

    #[tokio::test]
    async fn detects_a_merge_in_progress() {
        let repo = conflicted_repository().await;
        let git_dir = git_dir(&repo.path()).await;

        assert!(
            is_merge_head_set(&git_dir).await,
            "a conflicted merge leaves MERGE_HEAD behind"
        );
    }

    #[tokio::test]
    async fn detects_a_squash_merge_in_progress() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "base", "first");
        git(
            &["branch", "other"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");
        commit_file(&repo.path(), "foo", "on main", "second");
        git(
            &["checkout", "other"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "bar", "on other", "third");

        // --squash --no-commit leaves SQUASH_MSG for the pending commit message.
        git(
            &["merge", "--squash", "--no-commit", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("a squash merge of an unrelated file should apply cleanly");

        let git_dir = git_dir(&repo.path()).await;
        assert!(is_squash_msg_set(&git_dir).await);
    }

    #[tokio::test]
    async fn reads_the_state_of_an_in_progress_rebase() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "base", "first");
        let base = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        // Diverge, then rebase into a conflict so the rebase stays in progress.
        git(
            &["checkout", "-b", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout -b should succeed");
        commit_file(&repo.path(), "foo", "feature side", "on feature");
        let feature_tip = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        git(
            &["checkout", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "foo", "main side", "on main");
        let main_tip = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        git(
            &["checkout", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        // Expected to stop with a conflict, which is the point.
        let _ = git(
            &["rebase", "main"],
            repo.path(),
            "test",
            GitOptions::default().with_success_exit_codes([1, 128]),
        )
        .await;

        let git_dir = git_dir(&repo.path()).await;
        let state = get_rebase_internal_state(&git_dir)
            .await
            .expect("a stopped rebase should report its state");

        assert_eq!(state.target_branch, "feature", "short name, not a full ref");
        assert_eq!(state.original_branch_tip, feature_tip);
        assert_eq!(state.base_branch_tip, main_tip);
        assert_ne!(state.base_branch_tip, base);
    }

    #[tokio::test]
    async fn reports_no_rebase_state_when_the_marker_is_absent() {
        // Guards the early return: without REBASE_HEAD the rebase-merge files aren't consulted.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");
        let git_dir = git_dir(&repo.path()).await;

        std::fs::create_dir_all(git_dir.join("rebase-merge")).expect("failed to create dir");
        std::fs::write(git_dir.join("rebase-merge/orig-head"), "deadbeef\n")
            .expect("failed to write");
        std::fs::write(
            git_dir.join("rebase-merge/head-name"),
            "refs/heads/whatever\n",
        )
        .expect("failed to write");
        std::fs::write(git_dir.join("rebase-merge/onto"), "cafebabe\n").expect("failed to write");

        assert_eq!(get_rebase_internal_state(&git_dir).await, None);
    }

    #[tokio::test]
    async fn reports_no_rebase_state_when_the_files_are_incomplete() {
        // A present marker but missing files means we can't resolve the state; None is the answer
        // rather than a partially-filled struct.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");
        let git_dir = git_dir(&repo.path()).await;

        std::fs::write(git_dir.join("REBASE_HEAD"), "deadbeef\n").expect("failed to write");
        std::fs::create_dir_all(git_dir.join("rebase-merge")).expect("failed to create dir");
        std::fs::write(git_dir.join("rebase-merge/orig-head"), "deadbeef\n")
            .expect("failed to write");
        // head-name and onto deliberately absent.

        assert_eq!(get_rebase_internal_state(&git_dir).await, None);
    }
}
