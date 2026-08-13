//! Squashing commits together.
//!
//! Ported from `desktop-plus/app/src/lib/git/squash.ts`.
//!
//! # The point of the algorithm
//!
//! Squashing is done by handing git an interactive-rebase todo list, so the work here is entirely in
//! *building that list* — and the ordering rules are what make it non-obvious.
//!
//! Given history `A, B, C, D, E` (oldest first) and a request to squash `A` and `E` onto `C`, the result
//! must be `B, A-C-E, D`. Two things follow:
//!
//! - **The replay order is the log's, not the caller's.** `A` came before `C` and `E` came after, so the
//!   fold is `A`, then `C`, then `E`. Trusting the order the caller passed would reorder the content and
//!   invite conflicts. The original said as much: "not trust that what was sent is in the order of the
//!   log".
//! - **The squash lands where `squashOnto` was.** Commits after that point can't simply be picked as
//!   they're encountered, because a later commit might itself be one being squashed — so they're held
//!   back and replayed at the end.
//!
//! A consequence worth knowing: squashing the last two commits gives the same result whichever one the
//! user selects as the target, because the log order decides.

use std::path::Path;

use crate::error::GitError;
use crate::log::get_commits;
use crate::exec::ExecutionControl;
use crate::rebase::{
    rebase_interactive_controlled, MultiCommitOperationProgress, RebaseResult, TodoStep,
};
use crate::rev_list::CommitOneLine;

/// Why a squash couldn't be attempted.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SquashError {
    #[error("no commits were provided to squash")]
    NoCommits,

    /// The target is also in the list being squashed, which would mean folding it into itself.
    #[error("the commits to squash cannot contain the commit to squash onto")]
    TargetInSource,

    #[error("could not find any commits in the log for the given range")]
    NoCommitsInLog,

    /// Going ahead would silently drop the commits being squashed.
    #[error("the commit to squash onto was not found in the log")]
    TargetNotInLog,
}

/// Builds the todo list that performs the squash.
///
/// `commits` must be newest-first, as `git log` reports them. Separated from [`squash`] so the ordering
/// rules can be tested without running git.
pub fn build_squash_todo(
    commits: &[CommitOneLine],
    to_squash: &[String],
    squash_onto: &str,
) -> Result<Vec<TodoStep>, SquashError> {
    if to_squash.is_empty() {
        return Err(SquashError::NoCommits);
    }
    if to_squash.iter().any(|sha| sha == squash_onto) {
        return Err(SquashError::TargetInSource);
    }
    if commits.is_empty() {
        return Err(SquashError::NoCommitsInLog);
    }

    let mut todo = Vec::new();
    let mut found_target = false;
    // Commits to fold, gathered in log order rather than the caller's.
    let mut to_replay_at_squash: Vec<&CommitOneLine> = Vec::new();
    // Commits after the target, held back in case a later one is also being squashed.
    let mut to_replay_after: Vec<&CommitOneLine> = Vec::new();

    // Reversed, so we walk oldest to newest — the order git will replay them in.
    for commit in commits.iter().rev() {
        if to_squash.contains(&commit.sha) {
            if found_target {
                // The target is already placed, so this can be folded straight in.
                todo.push(TodoStep::squash(commit));
            } else {
                to_replay_at_squash.push(commit);
            }
            continue;
        }

        if commit.sha == squash_onto {
            found_target = true;
            to_replay_at_squash.push(commit);

            // The first becomes the pick that the rest fold into.
            for (index, held) in to_replay_at_squash.iter().enumerate() {
                todo.push(if index == 0 {
                    TodoStep::pick(held)
                } else {
                    TodoStep::squash(held)
                });
            }
            continue;
        }

        if found_target {
            to_replay_after.push(commit);
            continue;
        }

        todo.push(TodoStep::pick(commit));
    }

    todo.extend(to_replay_after.iter().map(|commit| TodoStep::pick(commit)));

    if !found_target {
        // Checked last, as the original did, so the error is raised only once the whole log has been
        // examined — and before the list is used, since continuing would drop every squashed commit.
        return Err(SquashError::TargetNotInLog);
    }

    Ok(todo)
}

/// Squashes `to_squash` onto `squash_onto`.
///
/// `last_retained_commit_ref` is the commit *before* the range being rewritten; `None` means the range
/// reaches the root of the branch, which becomes `--root`.
///
/// `commit_message` becomes the folded commit's message. A blank message leaves git to combine the
/// originals as it normally would.
///
/// A validation failure returns [`RebaseResult::Error`] rather than an `Err`, matching the original's
/// `catch`: the caller has one thing to branch on, and the reason is logged rather than propagated. Use
/// [`build_squash_todo`] directly when the specific reason matters.
pub async fn squash<F>(
    repository: impl AsRef<Path>,
    to_squash: &[String],
    squash_onto: &str,
    last_retained_commit_ref: Option<&str>,
    commit_message: &str,
    on_progress: Option<F>,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    squash_controlled(
        repository,
        to_squash,
        squash_onto,
        last_retained_commit_ref,
        commit_message,
        on_progress,
        None,
    )
    .await
}

/// Squashes commits with operation-owned process control.
pub async fn squash_controlled<F>(
    repository: impl AsRef<Path>,
    to_squash: &[String],
    squash_onto: &str,
    last_retained_commit_ref: Option<&str>,
    commit_message: &str,
    on_progress: Option<F>,
    control: Option<ExecutionControl>,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    let repository = repository.as_ref();

    let range = last_retained_commit_ref.map(|reference| format!("{reference}..HEAD"));
    let commits = get_commits(repository, range.as_deref(), None, None, &[]).await?;

    let commits: Vec<CommitOneLine> = commits
        .into_iter()
        .map(|commit| CommitOneLine {
            sha: commit.sha,
            summary: commit.summary,
        })
        .collect();

    let Ok(todo) = build_squash_todo(&commits, to_squash, squash_onto) else {
        return Ok(RebaseResult::Error);
    };

    // The commits the progress parser counts are the ones being folded plus the target.
    let mut involved: Vec<CommitOneLine> = commits
        .iter()
        .filter(|commit| to_squash.contains(&commit.sha) || commit.sha == squash_onto)
        .cloned()
        .collect();
    involved.reverse();

    // `cat <file> >` supplies the message, which is how the original avoided opening an editor while
    // still setting one. A blank message leaves git's own default in place.
    let message_file = if commit_message.trim().is_empty() {
        None
    } else {
        Some(crate::rebase::write_temp_file(
            "squash-message",
            commit_message,
        )?)
    };
    // Same shell-safety check as the todo path; see `cat_editor_command`.
    let git_editor = match &message_file {
        Some(file) => Some(crate::rebase::cat_editor_command(file.path())?),
        None => None,
    };

    rebase_interactive_controlled(
        repository,
        &todo,
        last_retained_commit_ref,
        &involved,
        git_editor.as_deref(),
        on_progress,
        control,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::rebase::{render_todo, TodoAction};
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

    fn actions(todo: &[TodoStep]) -> Vec<(TodoAction, &str)> {
        todo.iter()
            .map(|step| (step.action, step.summary.as_str()))
            .collect()
    }

    // --- validation ---

    #[test]
    fn refuses_an_empty_squash_list() {
        assert_eq!(
            build_squash_todo(&log(&["A"]), &[], &sha("A")),
            Err(SquashError::NoCommits)
        );
    }

    #[test]
    fn refuses_to_squash_a_commit_onto_itself() {
        assert_eq!(
            build_squash_todo(&log(&["A", "B"]), &[sha("B")], &sha("B")),
            Err(SquashError::TargetInSource)
        );
    }

    #[test]
    fn refuses_when_the_log_is_empty() {
        assert_eq!(
            build_squash_todo(&[], &[sha("A")], &sha("B")),
            Err(SquashError::NoCommitsInLog)
        );
    }

    #[test]
    fn refuses_when_the_target_is_not_in_the_log() {
        // Going ahead would drop every commit being squashed, so this has to fail rather than proceed.
        assert_eq!(
            build_squash_todo(&log(&["A", "B"]), &[sha("A")], &sha("Z")),
            Err(SquashError::TargetNotInLog)
        );
    }

    // --- ordering ---

    #[test]
    fn squashes_the_commit_before_the_target_in_log_order() {
        // A, B, C with A squashed onto C: B is untouched, then A folds into C.
        let todo = build_squash_todo(&log(&["A", "B", "C"]), &[sha("A")], &sha("C"))
            .expect("should build");

        assert_eq!(
            actions(&todo),
            vec![
                (TodoAction::Pick, "B"),
                (TodoAction::Pick, "A"),
                (TodoAction::Squash, "C"),
            ]
        );
    }

    #[test]
    fn places_the_squash_where_the_target_was_and_replays_the_rest_after() {
        // The example from the original: A, B, C, D, E with A and E squashed onto C gives B, A-C-E, D.
        let todo = build_squash_todo(
            &log(&["A", "B", "C", "D", "E"]),
            &[sha("A"), sha("E")],
            &sha("C"),
        )
        .expect("should build");

        assert_eq!(
            actions(&todo),
            vec![
                (TodoAction::Pick, "B"),
                (TodoAction::Pick, "A"),
                (TodoAction::Squash, "C"),
                (TodoAction::Squash, "E"),
                (TodoAction::Pick, "D"),
            ]
        );
    }

    #[test]
    fn ignores_the_order_the_caller_passed() {
        // The replay order is the log's. Passing E before A must produce the same list as the test above,
        // because reordering the content would change the result and invite conflicts.
        let todo = build_squash_todo(
            &log(&["A", "B", "C", "D", "E"]),
            &[sha("E"), sha("A")],
            &sha("C"),
        )
        .expect("should build");

        assert_eq!(
            actions(&todo),
            vec![
                (TodoAction::Pick, "B"),
                (TodoAction::Pick, "A"),
                (TodoAction::Squash, "C"),
                (TodoAction::Squash, "E"),
                (TodoAction::Pick, "D"),
            ]
        );
    }

    #[test]
    fn squashing_the_two_most_recent_commits_folds_the_newer_into_the_older() {
        // Whichever the user picks as the target, log order decides — so both directions give B into A.
        let onto_b =
            build_squash_todo(&log(&["A", "B"]), &[sha("A")], &sha("B")).expect("should build");
        let onto_a =
            build_squash_todo(&log(&["A", "B"]), &[sha("B")], &sha("A")).expect("should build");

        assert_eq!(
            actions(&onto_b),
            vec![(TodoAction::Pick, "A"), (TodoAction::Squash, "B")]
        );
        assert_eq!(
            actions(&onto_a),
            vec![(TodoAction::Pick, "A"), (TodoAction::Squash, "B")]
        );
    }

    #[test]
    fn squashes_a_commit_that_comes_after_the_target() {
        let todo = build_squash_todo(&log(&["A", "B", "C"]), &[sha("C")], &sha("A"))
            .expect("should build");

        assert_eq!(
            actions(&todo),
            vec![
                (TodoAction::Pick, "A"),
                (TodoAction::Squash, "C"),
                (TodoAction::Pick, "B"),
            ],
            "B is held back and replayed after the squash"
        );
    }

    #[test]
    fn renders_a_todo_git_can_read() {
        let todo =
            build_squash_todo(&log(&["A", "B"]), &[sha("A")], &sha("B")).expect("should build");

        assert_eq!(render_todo(&todo), "pick sha-A A\nsquash sha-B B\n");
    }

    // --- against a real repository ---

    #[tokio::test]
    async fn squashes_two_commits_in_a_real_repository() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "b.txt", "two\n", "second");
        commit_file(&repo.path(), "c.txt", "three\n", "third");

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

        // Squash the third onto the second, retaining the first.
        let result = squash(
            repo.path(),
            &[shas[2].clone()],
            &shas[1],
            Some(&shas[0]),
            "combined\n",
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("squashing should succeed");

        assert_eq!(result, RebaseResult::CompletedWithoutError);

        let summaries: Vec<String> = git(
            &["log", "--format=%s", "--reverse"],
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

        assert_eq!(
            summaries,
            vec!["first".to_owned(), "combined".to_owned()],
            "the two commits became one with the message we gave"
        );

        // All three files survive; only the history changed.
        for name in ["a.txt", "b.txt", "c.txt"] {
            assert!(repo.path().join(name).exists(), "{name} should still exist");
        }
    }

    #[tokio::test]
    async fn squashes_down_to_the_root_commit() {
        // `last_retained_commit_ref` of None means `--root`: the first commit has no parent to name.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "b.txt", "two\n", "second");

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

        let result = squash(
            repo.path(),
            &[shas[1].clone()],
            &shas[0],
            None,
            "everything\n",
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("squashing should succeed");

        assert_eq!(result, RebaseResult::CompletedWithoutError);

        let count = git(
            &["rev-list", "--count", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-list should succeed")
        .stdout_trimmed();
        assert_eq!(count, "1");
    }

    #[tokio::test]
    async fn a_validation_failure_reports_error_rather_than_raising() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let result = squash(
            repo.path(),
            &[],
            "nosuchsha",
            None,
            "",
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("should not raise");

        assert_eq!(result, RebaseResult::Error);
    }
}
