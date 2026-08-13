//! Moving commits within history.
//!
//! Ported from `desktop-plus/app/src/lib/git/reorder.ts`.
//!
//! # The point of the algorithm
//!
//! Like [`crate::squash`], this works by handing git an interactive-rebase todo list, so all the work is
//! in building it.
//!
//! Given history `A, B, C, D, E` (oldest first) and a request to move `A` and `E` before `C`, the result
//! must be `B, A, E, C, D`. The rules that follow:
//!
//! - **The moved commits keep their relative log order.** `A` came before `E`, so it stays that way,
//!   whatever order the caller listed them in.
//! - **They land immediately before the anchor**, which means the anchor itself and everything after it
//!   has to be held back and replayed afterwards — a commit later in history might also be one being
//!   moved.
//! - **A `None` anchor moves them to the end**, which is the one case where the held-back list is
//!   emitted last rather than at an anchor.

use std::path::Path;

use crate::error::GitError;
use crate::exec::ExecutionControl;
use crate::log::get_commits;
use crate::rebase::{
    rebase_interactive_controlled, MultiCommitOperationProgress, RebaseResult, TodoStep,
};
use crate::rev_list::CommitOneLine;

/// Why a reorder couldn't be attempted.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReorderError {
    #[error("no commits were provided to reorder")]
    NoCommits,

    #[error("could not find any commits in the log for the given range")]
    NoCommitsInLog,

    /// Going ahead would silently drop the commits being moved.
    #[error("the commit to reorder before was not found in the log")]
    AnchorNotInLog,
}

/// Builds the todo list that performs the reorder.
///
/// `commits` must be newest-first, as `git log` reports them. `before` is the commit the moved ones
/// should end up in front of; `None` moves them to the end of history.
///
/// Separated from [`reorder`] so the ordering rules can be tested without running git.
pub fn build_reorder_todo(
    commits: &[CommitOneLine],
    to_move: &[String],
    before: Option<&str>,
) -> Result<Vec<TodoStep>, ReorderError> {
    if to_move.is_empty() {
        return Err(ReorderError::NoCommits);
    }
    if commits.is_empty() {
        return Err(ReorderError::NoCommitsInLog);
    }

    let mut todo = Vec::new();
    let mut found_anchor = false;
    // Moved commits seen before the anchor, kept in log order.
    let mut to_replay_before_anchor: Vec<&CommitOneLine> = Vec::new();
    // The anchor and everything after it.
    let mut to_replay_after: Vec<&CommitOneLine> = Vec::new();

    // Reversed, so we walk oldest to newest — the order git will replay them in.
    for commit in commits.iter().rev() {
        if to_move.contains(&commit.sha) {
            if found_anchor {
                // The anchor is already held back, so this can go straight in — it lands before the
                // anchor because the anchor comes out of `to_replay_after` later.
                todo.push(TodoStep::pick(commit));
            } else {
                to_replay_before_anchor.push(commit);
            }
            continue;
        }

        if before.is_some_and(|anchor| commit.sha == anchor) {
            found_anchor = true;
            // Held back so the moved commits precede it.
            to_replay_after.push(commit);

            for held in &to_replay_before_anchor {
                todo.push(TodoStep::pick(held));
            }
            continue;
        }

        if found_anchor {
            to_replay_after.push(commit);
            continue;
        }

        todo.push(TodoStep::pick(commit));
    }

    todo.extend(to_replay_after.iter().map(|commit| TodoStep::pick(commit)));

    if before.is_none() {
        // No anchor: the moved commits go last.
        todo.extend(
            to_replay_before_anchor
                .iter()
                .map(|commit| TodoStep::pick(commit)),
        );
    } else if !found_anchor {
        // Checked after the walk, as the original did, and before the list is used — continuing would
        // drop every commit being moved.
        return Err(ReorderError::AnchorNotInLog);
    }

    Ok(todo)
}

/// Moves `to_move` so they sit immediately before `before`.
///
/// `before` of `None` moves them to the end of history.
///
/// `last_retained_commit_ref` is the commit *before* the range being rewritten; `None` means the range
/// reaches the root of the branch, which becomes `--root`.
///
/// A validation failure returns [`RebaseResult::Error`] rather than an `Err`, matching the original.
/// Use [`build_reorder_todo`] directly when the specific reason matters.
pub async fn reorder<F>(
    repository: impl AsRef<Path>,
    to_move: &[String],
    before: Option<&str>,
    last_retained_commit_ref: Option<&str>,
    on_progress: Option<F>,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    reorder_controlled(
        repository,
        to_move,
        before,
        last_retained_commit_ref,
        on_progress,
        None,
    )
    .await
}

/// Reorders commits with operation-owned process control.
pub async fn reorder_controlled<F>(
    repository: impl AsRef<Path>,
    to_move: &[String],
    before: Option<&str>,
    last_retained_commit_ref: Option<&str>,
    on_progress: Option<F>,
    control: Option<ExecutionControl>,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    let repository = repository.as_ref();

    let range = last_retained_commit_ref.map(|reference| format!("{reference}..HEAD"));
    let commits: Vec<CommitOneLine> = get_commits(repository, range.as_deref(), None, None, &[])
        .await?
        .into_iter()
        .map(|commit| CommitOneLine {
            sha: commit.sha,
            summary: commit.summary,
        })
        .collect();

    let Ok(todo) = build_reorder_todo(&commits, to_move, before) else {
        return Ok(RebaseResult::Error);
    };

    // The original passed the whole range for progress, since a reorder replays all of it.
    let mut replayed = commits.clone();
    replayed.reverse();

    rebase_interactive_controlled(
        repository,
        &todo,
        last_retained_commit_ref,
        &replayed,
        None,
        on_progress,
        control,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    /// Commits newest-first, as `git log` reports them.
    fn log(summaries: &[&str]) -> Vec<CommitOneLine> {
        summaries
            .iter()
            .rev()
            .map(|summary| CommitOneLine {
                sha: format!("sha-{summary}"),
                summary: (*summary).to_owned(),
            })
            .collect()
    }

    fn sha(summary: &str) -> String {
        format!("sha-{summary}")
    }

    /// The replay order the todo describes, oldest first.
    fn order(todo: &[TodoStep]) -> Vec<&str> {
        todo.iter().map(|step| step.summary.as_str()).collect()
    }

    // --- validation ---

    #[test]
    fn refuses_an_empty_move_list() {
        assert_eq!(
            build_reorder_todo(&log(&["A"]), &[], Some(&sha("A"))),
            Err(ReorderError::NoCommits)
        );
    }

    #[test]
    fn refuses_when_the_log_is_empty() {
        assert_eq!(
            build_reorder_todo(&[], &[sha("A")], None),
            Err(ReorderError::NoCommitsInLog)
        );
    }

    #[test]
    fn refuses_when_the_anchor_is_not_in_the_log() {
        // Continuing would drop the commits being moved.
        assert_eq!(
            build_reorder_todo(&log(&["A", "B"]), &[sha("A")], Some(&sha("Z"))),
            Err(ReorderError::AnchorNotInLog)
        );
    }

    // --- ordering ---

    #[test]
    fn moves_commits_from_both_sides_of_the_anchor_in_front_of_it() {
        // The example from the original: A, B, C, D, E with A and E moved before C gives B, A, E, C, D.
        let todo = build_reorder_todo(
            &log(&["A", "B", "C", "D", "E"]),
            &[sha("A"), sha("E")],
            Some(&sha("C")),
        )
        .expect("should build");

        assert_eq!(order(&todo), vec!["B", "A", "E", "C", "D"]);
        assert!(todo
            .iter()
            .all(|step| step.action == crate::rebase::TodoAction::Pick));
    }

    #[test]
    fn ignores_the_order_the_caller_passed() {
        // The moved commits keep their *log* order, so passing E first changes nothing.
        let todo = build_reorder_todo(
            &log(&["A", "B", "C", "D", "E"]),
            &[sha("E"), sha("A")],
            Some(&sha("C")),
        )
        .expect("should build");

        assert_eq!(order(&todo), vec!["B", "A", "E", "C", "D"]);
    }

    #[test]
    fn moves_a_later_commit_earlier() {
        let todo = build_reorder_todo(&log(&["A", "B", "C"]), &[sha("C")], Some(&sha("B")))
            .expect("should build");

        assert_eq!(order(&todo), vec!["A", "C", "B"]);
    }

    #[test]
    fn moves_an_earlier_commit_later_with_no_anchor() {
        // `None` means "to the end of history", the one case where the held-back list is emitted last.
        let todo =
            build_reorder_todo(&log(&["A", "B", "C"]), &[sha("A")], None).expect("should build");

        assert_eq!(order(&todo), vec!["B", "C", "A"]);
    }

    #[test]
    fn moves_several_commits_to_the_end_keeping_their_order() {
        let todo = build_reorder_todo(&log(&["A", "B", "C", "D"]), &[sha("A"), sha("C")], None)
            .expect("should build");

        assert_eq!(order(&todo), vec!["B", "D", "A", "C"]);
    }

    #[test]
    fn moving_a_commit_before_its_own_successor_is_a_no_op_in_effect() {
        // A already sits immediately before B, so the replay order is unchanged.
        let todo = build_reorder_todo(&log(&["A", "B", "C"]), &[sha("A")], Some(&sha("B")))
            .expect("should build");

        assert_eq!(order(&todo), vec!["A", "B", "C"]);
    }

    #[test]
    fn keeps_every_commit_exactly_once() {
        // The property that matters most: a reorder must never drop or duplicate a commit.
        let commits = log(&["A", "B", "C", "D", "E"]);
        let todo = build_reorder_todo(&commits, &[sha("B"), sha("D")], Some(&sha("A")))
            .expect("should build");

        let mut moved: Vec<&str> = order(&todo);
        moved.sort_unstable();
        assert_eq!(moved, vec!["A", "B", "C", "D", "E"]);
    }

    // --- against a real repository ---

    async fn repo_with_four_commits() -> (crate::test_support::TempRepository, Vec<String>) {
        let repo = empty_repository().await;
        for name in ["first", "second", "third", "fourth"] {
            commit_file(&repo.path(), &format!("{name}.txt"), "x\n", name);
        }

        let shas: Vec<String> = git(
            &["log", "--format=%H", "--reverse"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_lossy()
        .lines()
        .map(str::to_owned)
        .collect();

        (repo, shas)
    }

    async fn summaries(repo: &Path) -> Vec<String> {
        git(
            &["log", "--format=%s", "--reverse"],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_lossy()
        .lines()
        .map(str::to_owned)
        .collect()
    }

    #[tokio::test]
    async fn reorders_commits_in_a_real_repository() {
        let (repo, shas) = repo_with_four_commits().await;

        // Move the fourth before the third, retaining the first.
        let result = reorder(
            repo.path(),
            &[shas[3].clone()],
            Some(&shas[2]),
            Some(&shas[0]),
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("reordering should succeed");

        assert_eq!(result, RebaseResult::CompletedWithoutError);
        assert_eq!(
            summaries(&repo.path()).await,
            vec![
                "first".to_owned(),
                "second".to_owned(),
                "fourth".to_owned(),
                "third".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn cancelled_reorder_does_not_change_head() {
        let (repo, shas) = repo_with_four_commits().await;
        let original_head = shas[3].clone();
        let control = ExecutionControl::new();
        control.cancel(crate::error::TerminationReason::Cancelled);

        let result = reorder_controlled(
            repo.path(),
            &[shas[3].clone()],
            Some(&shas[2]),
            Some(&shas[0]),
            None::<fn(MultiCommitOperationProgress)>,
            Some(control),
        )
        .await;

        assert!(matches!(result, Err(GitError::OperationTerminated { .. })));
        let current_head = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("HEAD should resolve")
        .stdout_trimmed();
        assert_eq!(current_head, original_head);
    }

    #[tokio::test]
    async fn moves_a_commit_to_the_end_of_history() {
        let (repo, shas) = repo_with_four_commits().await;

        let result = reorder(
            repo.path(),
            &[shas[1].clone()],
            None,
            Some(&shas[0]),
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("reordering should succeed");

        assert_eq!(result, RebaseResult::CompletedWithoutError);
        assert_eq!(
            summaries(&repo.path()).await,
            vec![
                "first".to_owned(),
                "third".to_owned(),
                "fourth".to_owned(),
                "second".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn keeps_every_file_after_a_reorder() {
        // Rewriting history must not lose content.
        let (repo, shas) = repo_with_four_commits().await;

        reorder(
            repo.path(),
            &[shas[3].clone()],
            Some(&shas[1]),
            Some(&shas[0]),
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("reordering should succeed");

        for name in ["first.txt", "second.txt", "third.txt", "fourth.txt"] {
            assert!(repo.path().join(name).exists(), "{name} should still exist");
        }
    }

    #[tokio::test]
    async fn reorders_down_to_the_root_commit() {
        let (repo, shas) = repo_with_four_commits().await;

        let result = reorder(
            repo.path(),
            &[shas[0].clone()],
            None,
            None,
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("reordering should succeed");

        assert_eq!(result, RebaseResult::CompletedWithoutError);
        let summaries = summaries(&repo.path()).await;
        assert_eq!(
            summaries.last().map(String::as_str),
            Some("first"),
            "the root commit moved to the end: {summaries:?}"
        );
    }

    #[tokio::test]
    async fn a_validation_failure_reports_error_rather_than_raising() {
        let (repo, _shas) = repo_with_four_commits().await;

        let result = reorder(
            repo.path(),
            &[],
            None,
            None,
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("should not raise");

        assert_eq!(result, RebaseResult::Error);
    }

    #[tokio::test]
    async fn reports_progress_while_reordering() {
        let (repo, shas) = repo_with_four_commits().await;
        let mut updates: Vec<MultiCommitOperationProgress> = Vec::new();

        reorder(
            repo.path(),
            &[shas[3].clone()],
            Some(&shas[2]),
            Some(&shas[0]),
            Some(|progress: MultiCommitOperationProgress| updates.push(progress)),
        )
        .await
        .expect("reordering should succeed");

        assert!(!updates.is_empty(), "expected progress events");
        for pair in updates.windows(2) {
            assert!(
                pair[1].position >= pair[0].position,
                "progress went backwards: {updates:?}"
            );
        }
    }
}
