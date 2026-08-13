//! Cherry-picking commits.
//!
//! Ported from `desktop-plus/app/src/lib/git/cherry-pick.ts`.
//!
//! # Progress arrives on stdout, not stderr
//!
//! Unlike `checkout`, `rebase`, `fetch` and the rest, `cherry-pick` reports what it did on **stdout**:
//! one `[branch sha] summary` line per commit applied, followed by a few detail lines. That is why
//! [`crate::exec::git_with_stdout`] exists.
//!
//! # Two dead guards in the original
//!
//! `getCherryPickSnapshot` wrote `if (!isCherryPickHeadFound(repository))` and `continueCherryPick`
//! wrote `if (await !isCherryPickHeadFound(repository))`. That function is `async`, so the first
//! negates a `Promise` (always truthy, so the guard never fires) and the second awaits `false`. Both
//! checks were dead. They are real checks here — see `MIGRATION_MAP.md` §8.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{
    git, git_streaming_controlled, git_with_stdout, ExecutionControl, GitOptions, GitOutput,
};
use crate::git_error_kind::GitErrorKind;
use crate::operation_state::is_cherry_pick_head_found;
use crate::rebase::{MultiCommitOperationProgress, MultiCommitOperationProgressKind};
use crate::rev_list::CommitOneLine;
use crate::rev_parse::resolve_git_dir;
use crate::stage::ManualConflictResolution;
use crate::status::AppFileStatus;
use crate::update_index::{stage_files, FileToStage};

/// How a cherry-pick ended.
///
/// Matches the original's `CherryPickResult`, serialized as its variant names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CherryPickResult {
    /// Every commit applied.
    CompletedWithoutError,
    /// Conflicts need resolving before continuing.
    ConflictsEncountered,
    /// A continue was attempted with tracked changes still unstaged.
    OutstandingFilesNotStaged,
    /// Nothing was attempted — no commits, or no cherry-pick in progress to continue.
    UnableToStart,
    /// git failed in a way that isn't one of the above.
    Error,
}

/// An interrupted cherry-pick, reconstructed from git's sequencer files.
///
/// Mirrors `ICherryPickSnapshot` in `desktop-plus/app/src/models/cherry-pick.ts`, which isn't ported —
/// its only consumer is this operation, and the frontend receives the assembled value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickSnapshot {
    /// Commits still queued, oldest first.
    pub remaining_commits: Vec<CommitOneLine>,
    /// Every commit in the operation, so progress can be reported after a restart.
    pub commits: Vec<CommitOneLine>,
    pub progress: MultiCommitOperationProgress,
    /// Where the target branch was before the cherry-pick, so it can be undone.
    #[serde(rename = "targetBranchUndoSha")]
    pub target_branch_undo_sha: String,
    /// How many commits have already been applied.
    pub cherry_picked_count: usize,
}

/// Counts the commits git reports having applied, on stdout.
///
/// A successfully applied commit begins a block like:
///
/// ```text
/// [main 1a2b3c4] the commit summary
///  Date: …
///  1 file changed, 1 insertion(+)
/// ```
///
/// Only that first line is counted; the detail lines are skipped.
#[derive(Debug)]
struct CherryPickProgressParser<'a> {
    commits: &'a [CommitOneLine],
    count: usize,
    pending: Vec<u8>,
}

impl<'a> CherryPickProgressParser<'a> {
    fn new(commits: &'a [CommitOneLine], already_applied: usize) -> Self {
        Self {
            commits,
            count: already_applied,
            pending: Vec::new(),
        }
    }

    /// Feeds a chunk, returning progress for each commit it saw completed.
    fn push(&mut self, chunk: &[u8]) -> Vec<MultiCommitOperationProgress> {
        self.pending.extend_from_slice(chunk);

        let mut updates = Vec::new();
        while let Some(position) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line);

            if let Some(progress) = self.parse_line(line.trim_end()) {
                updates.push(progress);
            }
        }

        updates
    }

    fn parse_line(&mut self, line: &str) -> Option<MultiCommitOperationProgress> {
        if !commit_line_pattern().is_match(line) {
            return None;
        }

        self.count += 1;
        let total = self.commits.len();

        Some(MultiCommitOperationProgress {
            kind: MultiCommitOperationProgressKind::MultiCommitOperation,
            // Rounded to two places as the original did, so the UI doesn't jitter.
            value: round_to_two((self.count as f64) / (total.max(1) as f64)),
            position: self.count,
            total_commit_count: total,
            current_commit_summary: self
                .commits
                .get(self.count - 1)
                .map(|commit| commit.summary.clone())
                .unwrap_or_default(),
        })
    }
}

fn round_to_two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Matches the first line of an applied commit: `[<something with a space>]`.
///
/// The space requirement is the original's, and it is what distinguishes `[main 1a2b3c4]` from a
/// bracketed line with no space in it.
fn commit_line_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\[(.*\s.*)\]").expect("pattern is valid"))
}

/// The failures a cherry-pick expects and reports rather than raising.
fn expected_errors() -> [GitErrorKind; 3] {
    [
        GitErrorKind::MergeConflicts,
        GitErrorKind::ConflictModifyDeletedInBranch,
        GitErrorKind::UnresolvedConflicts,
    ]
}

/// Interprets a finished cherry-pick.
///
/// Unlike the original this returns [`CherryPickResult::Error`] for an unrecognised failure instead of
/// throwing. A cherry-pick that failed in an unexpected way still leaves the repository in a state the
/// UI has to describe, and the enum already has a variant for exactly that.
fn parse_cherry_pick_result(output: &GitOutput) -> CherryPickResult {
    if output.exit_code == 0 {
        return CherryPickResult::CompletedWithoutError;
    }

    match output.git_error {
        Some(GitErrorKind::MergeConflicts | GitErrorKind::ConflictModifyDeletedInBranch) => {
            CherryPickResult::ConflictsEncountered
        }
        Some(GitErrorKind::UnresolvedConflicts) => CherryPickResult::OutstandingFilesNotStaged,
        _ => CherryPickResult::Error,
    }
}

/// How to tell this git to keep a commit that cherry-picks to nothing.
///
/// `--empty=keep` is the modern spelling and needs git **2.45**; `--keep-redundant-commits` is its
/// documented deprecated synonym and works as far back as this crate is tested. Behaviour is identical —
/// verified on 2.39 and 2.53, both keeping the empty commit.
///
/// The check is not hypothetical: **Ubuntu 24.04 LTS ships git 2.43**, so passing `--empty=keep`
/// unconditionally — as upstream does, since it bundles its own git — makes every cherry-pick on that
/// distro fail with exit 129 and a usage dump. The modern spelling is still preferred where it exists,
/// because the synonym is deprecated and will eventually go.
async fn keep_empty_flag(repository: &Path) -> &'static str {
    static MODERN: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();

    let modern = *MODERN
        .get_or_init(|| crate::exec::supports_flag(repository, &["cherry-pick"], "--empty"))
        .await;

    if modern {
        "--empty=keep"
    } else {
        "--keep-redundant-commits"
    }
}

/// Cherry-picks `commits` onto the current branch, oldest first.
///
/// Order matters only for conflict avoidance — the original noted that ascending order is best
/// practice — so the caller decides it.
///
/// Two flags carried over with their reasons:
///
/// - **`--empty=keep`** so a commit whose changes are already present still appears in the target
///   branch's history rather than vanishing. It also makes `--allow-empty` unnecessary.
/// - **`-m 1`** so cherry-picking a *merge* commit takes the first parent's side. Without it git
///   refuses a merge commit outright. The original passed `"-m 1"` as a single argument, which git
///   happens to tolerate; it is split properly here.
pub async fn cherry_pick<F>(
    repository: impl AsRef<Path>,
    commits: &[CommitOneLine],
    on_progress: Option<F>,
) -> Result<CherryPickResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    cherry_pick_controlled(repository, commits, on_progress, None).await
}

/// Cherry-picks with operation-owned process control. A termination error is returned to the
/// command layer before any sequencer recovery is attempted.
pub async fn cherry_pick_controlled<F>(
    repository: impl AsRef<Path>,
    commits: &[CommitOneLine],
    on_progress: Option<F>,
    control: Option<ExecutionControl>,
) -> Result<CherryPickResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    if commits.is_empty() {
        return Ok(CherryPickResult::UnableToStart);
    }

    let mut args = vec!["cherry-pick".to_owned()];
    args.extend(commits.iter().map(|commit| commit.sha.clone()));
    args.extend([
        keep_empty_flag(repository.as_ref()).await.to_owned(),
        "-m".to_owned(),
        "1".to_owned(),
    ]);

    // Deliberately *not* `with_success_exit_codes([1])`. An accepted exit code makes `exec` return
    // before classifying, so `git_error` would be `None` and a conflict would look like an unknown
    // failure. `expected_errors` is the mechanism that turns a recognised failure into an `Ok` the
    // caller can branch on — and it keeps the classification.
    let options = GitOptions::default().with_expected_errors(expected_errors());

    let output = match on_progress {
        Some(mut on_progress) => {
            let mut parser = CherryPickProgressParser::new(commits, 0);
            git_streaming_controlled(&args, repository, "cherryPick", options, control, |chunk| {
                for progress in parser.push(chunk) {
                    on_progress(progress);
                }
            }, |_| {})
            .await?
        }
        None => {
            git_streaming_controlled(&args, repository, "cherryPick", options, control, |_| {}, |_| {})
                .await?
        }
    };

    Ok(parse_cherry_pick_result(&output))
}

/// Reconstructs an interrupted cherry-pick from git's sequencer files.
///
/// `None` when there is no cherry-pick in progress, or when the files can't be read — which happens
/// legitimately if the operation is aborted or finished while this is reading them.
///
/// Unlike the original, the "is there a cherry-pick at all?" check actually runs; see the module docs.
pub async fn get_cherry_pick_snapshot(
    repository: impl AsRef<Path>,
) -> Result<Option<CherryPickSnapshot>, GitError> {
    let repository = repository.as_ref();
    let git_dir = resolve_git_dir(repository).await?;

    if !is_cherry_pick_head_found(&git_dir).await {
        return Ok(None);
    }

    let sequencer = git_dir.join("sequencer");

    // `abort-safety` holds the last cherry-picked commit, or the target branch tip if none have been
    // applied yet. `head` holds where the target branch was before the operation.
    let Some(_abort_safety) = read_trimmed(&sequencer.join("abort-safety")) else {
        return Ok(None);
    };
    let Some(head) = read_trimmed(&sequencer.join("head")) else {
        return Ok(None);
    };
    let Some(todo) = read_trimmed(&sequencer.join("todo")) else {
        return Ok(None);
    };

    let remaining_commits = parse_todo(&todo);
    if remaining_commits.is_empty() {
        // Only reachable with corrupt sequencer files.
        return Ok(None);
    }

    // git only records what is *left*, so the total has to be recovered by counting what the target
    // branch has gained since `head`.
    let cherry_picked_count = count_commits_since(repository, &head).await?;
    let total = cherry_picked_count + remaining_commits.len();

    // The applied commits' summaries are no longer in the sequencer, so the replay list is the ones
    // already on the branch followed by the ones still queued.
    let mut commits = commits_since(repository, &head).await?;
    commits.extend(remaining_commits.iter().cloned());

    Ok(Some(CherryPickSnapshot {
        remaining_commits,
        progress: MultiCommitOperationProgress {
            kind: MultiCommitOperationProgressKind::MultiCommitOperation,
            value: round_to_two((cherry_picked_count as f64) / (total.max(1) as f64)),
            position: cherry_picked_count,
            total_commit_count: total,
            current_commit_summary: commits
                .get(cherry_picked_count)
                .map(|commit| commit.summary.clone())
                .unwrap_or_default(),
        },
        commits,
        target_branch_undo_sha: head,
        cherry_picked_count,
    }))
}

/// Reads a sequencer file, or `None` if it is missing or empty.
fn read_trimmed(path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    let trimmed = contents.trim().to_owned();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Parses `.git/sequencer/todo`, whose lines read `pick <sha> <summary>`.
fn parse_todo(todo: &str) -> Vec<CommitOneLine> {
    todo.lines()
        .filter_map(|line| {
            let line = line.strip_prefix("pick ").unwrap_or(line);
            let (sha, summary) = line.split_once(' ')?;

            (!sha.is_empty()).then(|| CommitOneLine {
                sha: sha.to_owned(),
                summary: summary.to_owned(),
            })
        })
        .collect()
}

async fn count_commits_since(repository: &Path, since: &str) -> Result<usize, GitError> {
    let output = git(
        &["rev-list", "--count", &format!("{since}..HEAD")],
        repository,
        "cherryPickSnapshot",
        GitOptions::default(),
    )
    .await?;

    Ok(output.stdout_trimmed().parse().unwrap_or(0))
}

async fn commits_since(repository: &Path, since: &str) -> Result<Vec<CommitOneLine>, GitError> {
    let output = git(
        &[
            "log",
            "--format=%H %s",
            "--reverse",
            &format!("{since}..HEAD"),
        ],
        repository,
        "cherryPickSnapshot",
        GitOptions::default(),
    )
    .await?;

    Ok(output
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let (sha, summary) = line.split_once(' ')?;
            Some(CommitOneLine {
                sha: sha.to_owned(),
                summary: summary.to_owned(),
            })
        })
        .collect())
}

/// Continues a cherry-pick once conflicts are resolved.
///
/// `files` is the conflicted set; **untracked files are excluded**, because a cherry-pick only concerns
/// tracked content and staging an untracked file would sweep unrelated work into the commit.
///
/// When nothing tracked remains staged the current commit is committed **empty** rather than skipped,
/// so its summary still appears in the target branch's history — consistent with `--empty=keep` on the
/// initial pick.
///
/// `GIT_EDITOR=:` because git would otherwise open an editor for the commit message and the operation
/// would appear to hang. The original's comment put it as "if we don't provide editor, we can't detect
/// git errors".
pub async fn continue_cherry_pick<F>(
    repository: impl AsRef<Path>,
    files: &[(String, AppFileStatus)],
    manual_resolutions: &[(String, ManualConflictResolution)],
    on_progress: Option<F>,
) -> Result<CherryPickResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    let repository = repository.as_ref();

    for (path, resolution) in manual_resolutions {
        crate::stage::stage_manual_conflict_resolution(repository, path, *resolution).await?;
    }

    let to_stage: Vec<FileToStage> = files
        .iter()
        .filter(|(path, status)| {
            !matches!(status, AppFileStatus::Untracked { .. })
                && !manual_resolutions
                    .iter()
                    .any(|(resolved, _)| resolved == path)
        })
        .map(|(path, _)| FileToStage::new(path.clone()))
        .collect();

    stage_files(repository, &to_stage).await?;

    let git_dir = resolve_git_dir(repository).await?;
    if !is_cherry_pick_head_found(&git_dir).await {
        // The check the original's `await !…` made dead.
        return Ok(CherryPickResult::UnableToStart);
    }

    let options = GitOptions::default()
        .with_expected_errors(expected_errors())
        .with_env("GIT_EDITOR", ":");

    // Whether anything is actually staged decides which command continues the operation.
    let staged = crate::update_index::staged_paths(repository).await;
    let args: Vec<String> = if staged.is_empty() {
        vec!["commit".to_owned(), "--allow-empty".to_owned()]
    } else {
        vec!["cherry-pick".to_owned(), "--continue".to_owned()]
    };

    let output = match on_progress {
        Some(mut on_progress) => {
            let snapshot = get_cherry_pick_snapshot(repository).await?;
            let Some(snapshot) = snapshot else {
                return Ok(CherryPickResult::UnableToStart);
            };

            let mut parser =
                CherryPickProgressParser::new(&snapshot.commits, snapshot.cherry_picked_count);
            git_with_stdout(&args, repository, "continueCherryPick", options, |chunk| {
                for progress in parser.push(chunk) {
                    on_progress(progress);
                }
            })
            .await?
        }
        None => git(&args, repository, "continueCherryPick", options).await?,
    };

    Ok(parse_cherry_pick_result(&output))
}

/// Abandons the cherry-pick, restoring the branch to where it started.
pub async fn abort_cherry_pick(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["cherry-pick", "--abort"],
        repository,
        "abortCherryPick",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    // --- progress parsing ---

    fn commits(count: usize) -> Vec<CommitOneLine> {
        (0..count)
            .map(|index| CommitOneLine {
                sha: format!("{index}").repeat(40),
                summary: format!("commit {index}"),
            })
            .collect()
    }

    #[test]
    fn counts_a_line_reporting_an_applied_commit() {
        let all = commits(2);
        let mut parser = CherryPickProgressParser::new(&all, 0);

        let updates = parser.push(b"[main 1a2b3c4] commit 0\n Date: whenever\n 1 file changed\n");

        assert_eq!(updates.len(), 1, "only the bracketed line counts");
        assert_eq!(updates[0].position, 1);
        assert_eq!(updates[0].total_commit_count, 2);
        assert_eq!(updates[0].value, 0.5);
        assert_eq!(updates[0].current_commit_summary, "commit 0");
    }

    #[test]
    fn parses_across_arbitrary_chunk_boundaries() {
        let all = commits(2);
        let mut parser = CherryPickProgressParser::new(&all, 0);

        assert!(parser.push(b"[main 1a2b").is_empty());
        let updates = parser.push(b"c4] commit 0\n[main 5d6e7f8] commit 1\n");

        assert_eq!(updates.len(), 2);
        assert_eq!(updates[1].position, 2);
        assert_eq!(updates[1].value, 1.0);
    }

    #[test]
    fn resumes_from_an_already_applied_count() {
        // What a continue needs: the commits before the conflict are already done.
        let all = commits(3);
        let mut parser = CherryPickProgressParser::new(&all, 2);

        let updates = parser.push(b"[main abc1234] commit 2\n");
        assert_eq!(updates[0].position, 3);
        assert_eq!(updates[0].current_commit_summary, "commit 2");
    }

    #[test]
    fn ignores_a_bracketed_line_with_no_space() {
        // The original's pattern required a space inside the brackets.
        let all = commits(1);
        let mut parser = CherryPickProgressParser::new(&all, 0);
        assert!(parser.push(b"[nospace]\n").is_empty());
    }

    #[test]
    fn ignores_detail_lines() {
        let all = commits(1);
        let mut parser = CherryPickProgressParser::new(&all, 0);
        assert!(parser
            .push(b" Date: whenever\n 1 file changed, 1 insertion(+)\n create mode 100644 f\n")
            .is_empty());
    }

    #[test]
    fn rounds_progress_to_two_places() {
        let all = commits(3);
        let mut parser = CherryPickProgressParser::new(&all, 0);
        let updates = parser.push(b"[main abc1234] commit 0\n");
        assert_eq!(updates[0].value, 0.33);
    }

    // --- todo parsing ---

    #[test]
    fn parses_the_sequencer_todo() {
        let todo = "pick abc1234 first commit\npick def5678 second commit\n";
        assert_eq!(
            parse_todo(todo),
            vec![
                CommitOneLine {
                    sha: "abc1234".to_owned(),
                    summary: "first commit".to_owned()
                },
                CommitOneLine {
                    sha: "def5678".to_owned(),
                    summary: "second commit".to_owned()
                },
            ]
        );
    }

    #[test]
    fn skips_a_todo_line_with_no_summary() {
        // The original required a space after the sha.
        assert!(parse_todo("pick abc1234\n").is_empty());
    }

    #[test]
    fn keeps_a_summary_containing_spaces() {
        let parsed = parse_todo("pick abc1234 a summary with spaces\n");
        assert_eq!(parsed[0].summary, "a summary with spaces");
    }

    // --- result classification ---

    #[test]
    fn classifies_results_by_git_error() {
        let make = |exit_code, git_error| GitOutput {
            stdout: Vec::new(),
            stderr: String::new(),
            exit_code,
            git_error,
            path: std::path::PathBuf::new(),
        };

        assert_eq!(
            parse_cherry_pick_result(&make(0, None)),
            CherryPickResult::CompletedWithoutError
        );
        assert_eq!(
            parse_cherry_pick_result(&make(1, Some(GitErrorKind::MergeConflicts))),
            CherryPickResult::ConflictsEncountered
        );
        assert_eq!(
            parse_cherry_pick_result(&make(1, Some(GitErrorKind::ConflictModifyDeletedInBranch))),
            CherryPickResult::ConflictsEncountered
        );
        assert_eq!(
            parse_cherry_pick_result(&make(1, Some(GitErrorKind::UnresolvedConflicts))),
            CherryPickResult::OutstandingFilesNotStaged
        );
    }

    #[test]
    fn an_unrecognized_failure_is_an_error_rather_than_a_panic() {
        // The original threw here. A cherry-pick that failed unexpectedly still leaves state the UI has
        // to describe, and the enum already has a variant for it.
        let output = GitOutput {
            stdout: Vec::new(),
            stderr: "something else".to_owned(),
            exit_code: 1,
            git_error: None,
            path: std::path::PathBuf::new(),
        };
        assert_eq!(parse_cherry_pick_result(&output), CherryPickResult::Error);
    }

    // --- against real repositories ---

    /// `main` with one commit, and a `side` branch with two more to pick from.
    async fn repo_with_commits_to_pick() -> (TempRepository, Vec<CommitOneLine>) {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "base.txt", "base\n", "base");

        git(
            &["checkout", "-b", "side", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "one.txt", "one\n", "first pick");
        commit_file(&repo.path(), "two.txt", "two\n", "second pick");

        let output = git(
            &["log", "--format=%H %s", "--reverse", "main..side"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed");
        let picks: Vec<CommitOneLine> = output
            .stdout_lossy()
            .lines()
            .filter_map(|line| {
                let (sha, summary) = line.split_once(' ')?;
                Some(CommitOneLine {
                    sha: sha.to_owned(),
                    summary: summary.to_owned(),
                })
            })
            .collect();

        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        (repo, picks)
    }

    #[tokio::test]
    async fn picking_no_commits_does_nothing() {
        let repo = empty_repository().await;
        assert_eq!(
            cherry_pick(repo.path(), &[], None::<fn(MultiCommitOperationProgress)>)
                .await
                .expect("should succeed"),
            CherryPickResult::UnableToStart
        );
    }

    #[tokio::test]
    async fn picks_commits_onto_the_current_branch() {
        let (repo, picks) = repo_with_commits_to_pick().await;

        let result = cherry_pick(
            repo.path(),
            &picks,
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("should succeed");

        assert_eq!(result, CherryPickResult::CompletedWithoutError);
        assert!(repo.path().join("one.txt").exists());
        assert!(repo.path().join("two.txt").exists());
    }

    #[tokio::test]
    async fn reports_progress_for_each_commit() {
        let (repo, picks) = repo_with_commits_to_pick().await;
        let mut updates: Vec<MultiCommitOperationProgress> = Vec::new();

        cherry_pick(
            repo.path(),
            &picks,
            Some(|progress: MultiCommitOperationProgress| updates.push(progress)),
        )
        .await
        .expect("should succeed");

        assert_eq!(updates.len(), 2, "got {updates:?}");
        assert_eq!(updates[0].position, 1);
        assert_eq!(updates[1].position, 2);
        assert_eq!(updates[1].value, 1.0);
        assert_eq!(updates[0].current_commit_summary, "first pick");
        assert_eq!(updates[1].current_commit_summary, "second pick");
    }

    #[tokio::test]
    async fn reports_conflicts_rather_than_failing() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "f.txt", "base\n", "base");
        git(
            &["checkout", "-b", "side", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "f.txt", "theirs\n", "their change");

        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "f.txt", "ours\n", "our change");

        let result = cherry_pick(
            repo.path(),
            &[CommitOneLine {
                sha,
                summary: "their change".to_owned(),
            }],
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("a conflict is not an error");

        assert_eq!(result, CherryPickResult::ConflictsEncountered);
    }

    #[tokio::test]
    async fn no_snapshot_when_nothing_is_in_progress() {
        // The check the original's missing `await` made dead.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "f.txt", "base\n", "base");

        assert_eq!(
            get_cherry_pick_snapshot(repo.path())
                .await
                .expect("should succeed"),
            None
        );
    }

    #[tokio::test]
    async fn reconstructs_a_snapshot_from_an_interrupted_pick() {
        // Two commits to pick, the *second* of which conflicts, so git stops with one applied and one
        // left in the sequencer.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "base.txt", "base\n", "base");
        commit_file(&repo.path(), "shared.txt", "base\n", "shared base");

        git(
            &["checkout", "-b", "side", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "clean.txt", "clean\n", "clean pick");
        commit_file(&repo.path(), "shared.txt", "theirs\n", "conflicting pick");

        let output = git(
            &["log", "--format=%H %s", "--reverse", "main..side"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed");
        let picks: Vec<CommitOneLine> = output
            .stdout_lossy()
            .lines()
            .filter_map(|line| {
                let (sha, summary) = line.split_once(' ')?;
                Some(CommitOneLine {
                    sha: sha.to_owned(),
                    summary: summary.to_owned(),
                })
            })
            .collect();

        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "shared.txt", "ours\n", "our change");

        let result = cherry_pick(
            repo.path(),
            &picks,
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("should succeed");
        assert_eq!(result, CherryPickResult::ConflictsEncountered);

        let snapshot = get_cherry_pick_snapshot(repo.path())
            .await
            .expect("should succeed")
            .expect("a cherry-pick is in progress");

        assert_eq!(snapshot.cherry_picked_count, 1, "the clean one applied");
        assert_eq!(snapshot.remaining_commits.len(), 1);
        assert_eq!(snapshot.progress.total_commit_count, 2);
        assert_eq!(snapshot.progress.position, 1);
        assert!(!snapshot.target_branch_undo_sha.is_empty());
    }

    #[tokio::test]
    async fn aborting_restores_the_branch() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "f.txt", "base\n", "base");
        git(
            &["checkout", "-b", "side", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "f.txt", "theirs\n", "their change");
        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "f.txt", "ours\n", "our change");
        let before = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        cherry_pick(
            repo.path(),
            &[CommitOneLine {
                sha,
                summary: "their change".to_owned(),
            }],
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("should succeed");

        abort_cherry_pick(repo.path())
            .await
            .expect("aborting should succeed");

        let after = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        assert_eq!(before, after);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("f.txt")).expect("failed to read"),
            "ours\n"
        );
    }

    #[tokio::test]
    async fn continuing_without_a_pick_in_progress_does_nothing() {
        // The check the original's `await !…` made dead.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "f.txt", "base\n", "base");

        assert_eq!(
            continue_cherry_pick(
                repo.path(),
                &[],
                &[],
                None::<fn(MultiCommitOperationProgress)>
            )
            .await
            .expect("should succeed"),
            CherryPickResult::UnableToStart
        );
    }

    #[tokio::test]
    async fn continues_after_a_conflict_is_resolved() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "f.txt", "base\n", "base");
        git(
            &["checkout", "-b", "side", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "f.txt", "theirs\n", "their change");
        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        git(
            &["checkout", "main", "--"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "f.txt", "ours\n", "our change");

        cherry_pick(
            repo.path(),
            &[CommitOneLine {
                sha,
                summary: "their change".to_owned(),
            }],
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("should succeed");

        // Resolve as a user would.
        std::fs::write(repo.path().join("f.txt"), "resolved\n").expect("failed to write");

        let result = continue_cherry_pick(
            repo.path(),
            &[(
                "f.txt".to_owned(),
                AppFileStatus::Modified {
                    submodule_status: None,
                },
            )],
            &[],
            None::<fn(MultiCommitOperationProgress)>,
        )
        .await
        .expect("continuing should succeed");

        assert_eq!(result, CherryPickResult::CompletedWithoutError);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("f.txt")).expect("failed to read"),
            "resolved\n"
        );
    }
}
