//! Non-interactive rebase operations.
//!
//! Ported from `desktop-plus/app/src/lib/git/rebase.ts`. The core start/continue/abort flow lives
//! here. Progress parsing/snapshots and interactive rebase remain deferred: progress is streaming
//! output and therefore belongs on a Tauri Channel, while interactive rebase also depends on the
//! reorder/squash slice.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, git_with_stderr, GitOptions, GitOutput};
use crate::git_error_kind::GitErrorKind;
use crate::operation_state::is_rebase_head_set;
use crate::rev_list::{get_commits_between_commits, CommitOneLine};
use crate::rev_parse::{get_repository_type, resolve_git_dir, RepositoryType};
use crate::stage::{stage_manual_conflict_resolution_with_entries, ManualConflictResolution};
use crate::status::{get_status, AppFileStatus};
use crate::status_parser::GitStatusEntry;
use crate::update_index::{stage_files, FileToStage};

/// The app-specific result of attempting or continuing a rebase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RebaseResult {
    CompletedWithoutError,
    AlreadyUpToDate,
    ConflictsEncountered,
    OutstandingFilesNotStaged,
    Aborted,
    Error,
}

/// A manual resolution to apply before continuing a rebase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseConflictResolution {
    pub path: String,
    pub resolution: ManualConflictResolution,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<(GitStatusEntry, GitStatusEntry)>,
}

/// Progress applying a sequence of commits.
///
/// Matches `IMultiCommitOperationProgress` in `src/models/progress.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiCommitOperationProgress {
    pub kind: MultiCommitOperationProgressKind,
    pub value: f64,
    pub position: usize,
    pub total_commit_count: usize,
    pub current_commit_summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MultiCommitOperationProgressKind {
    MultiCommitOperation,
}

/// Recoverable progress and commit information for an in-progress rebase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseSnapshot {
    pub progress: MultiCommitOperationProgress,
    pub commits: Vec<CommitOneLine>,
}

#[derive(Debug)]
struct RebaseProgressParser<'a> {
    commits: &'a [CommitOneLine],
    pending: Vec<u8>,
}

impl<'a> RebaseProgressParser<'a> {
    fn new(commits: &'a [CommitOneLine]) -> Self {
        Self {
            commits,
            pending: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<MultiCommitOperationProgress> {
        self.pending.extend_from_slice(chunk);
        let mut progress = Vec::new();
        let mut start = 0;
        for index in 0..self.pending.len() {
            if matches!(self.pending[index], b'\r' | b'\n') {
                if index > start {
                    if let Some(value) = parse_rebase_progress_line(
                        &String::from_utf8_lossy(&self.pending[start..index]),
                        self.commits,
                    ) {
                        progress.push(value);
                    }
                }
                start = index + 1;
            }
        }
        if start > 0 {
            self.pending.drain(..start);
        }
        progress
    }

    fn finish(&mut self) -> Option<MultiCommitOperationProgress> {
        let pending = std::mem::take(&mut self.pending);
        (!pending.is_empty())
            .then(|| parse_rebase_progress_line(&String::from_utf8_lossy(&pending), self.commits))
            .flatten()
    }
}

fn parse_rebase_progress_line(
    line: &str,
    commits: &[CommitOneLine],
) -> Option<MultiCommitOperationProgress> {
    static REBASING: OnceLock<Regex> = OnceLock::new();
    let pattern = REBASING.get_or_init(|| {
        Regex::new(r"^Rebasing \((\d+)/(\d+)\)$")
            .expect("the built-in rebase progress regex should compile")
    });
    let captures = pattern.captures(line)?;
    let position: usize = captures.get(1)?.as_str().parse().ok()?;
    let total_commit_count: usize = captures.get(2)?.as_str().parse().ok()?;
    if position == 0 || total_commit_count == 0 {
        return None;
    }
    let value =
        ((position as f64 / total_commit_count as f64).clamp(0.0, 1.0) * 100.0).round() / 100.0;

    Some(MultiCommitOperationProgress {
        kind: MultiCommitOperationProgressKind::MultiCommitOperation,
        value,
        position,
        total_commit_count,
        current_commit_summary: commits
            .get(position - 1)
            .map(|commit| commit.summary.clone())
            .unwrap_or_default(),
    })
}

/// Reads recoverable state for a rebase started either by rdc or another git client.
pub async fn get_rebase_snapshot(
    repository: impl AsRef<Path>,
) -> Result<Option<RebaseSnapshot>, GitError> {
    let repository = repository.as_ref();
    if !matches!(
        get_repository_type(repository).await?,
        RepositoryType::Regular { .. }
    ) {
        return Ok(None);
    }

    let git_dir = resolve_git_dir(repository).await?;
    if !is_rebase_head_set(&git_dir).await {
        return Ok(None);
    }
    let rebase_merge = git_dir.join("rebase-merge");

    let Some(position) = read_positive_usize(rebase_merge.join("msgnum")).await else {
        return Ok(None);
    };
    let Some(total_commit_count) = read_positive_usize(rebase_merge.join("end")).await else {
        return Ok(None);
    };
    let Some(original_branch_tip) = read_trimmed(rebase_merge.join("orig-head")).await else {
        return Ok(None);
    };
    let Some(base_branch_tip) = read_trimmed(rebase_merge.join("onto")).await else {
        return Ok(None);
    };

    let Some(commits) =
        get_commits_between_commits(repository, &base_branch_tip, &original_branch_tip).await?
    else {
        return Ok(None);
    };
    if commits.is_empty() {
        return Ok(None);
    }

    let current_commit_summary = commits
        .get(position - 1)
        .map(|commit| commit.summary.clone())
        .unwrap_or_default();
    let value =
        ((position as f64 / total_commit_count as f64).clamp(0.0, 1.0) * 100.0).round() / 100.0;

    Ok(Some(RebaseSnapshot {
        progress: MultiCommitOperationProgress {
            kind: MultiCommitOperationProgressKind::MultiCommitOperation,
            value,
            position,
            total_commit_count,
            current_commit_summary,
        },
        commits,
    }))
}

async fn read_positive_usize(path: impl AsRef<Path>) -> Option<usize> {
    let value = read_trimmed(path).await?.parse().ok()?;
    (value > 0).then_some(value)
}

async fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    Some(
        tokio::fs::read_to_string(path)
            .await
            .ok()?
            .trim()
            .to_owned(),
    )
}

/// Rebases `target_branch` onto `base_branch`.
pub async fn rebase(
    repository: impl AsRef<Path>,
    base_branch: &str,
    target_branch: &str,
) -> Result<RebaseResult, GitError> {
    let output = git(
        &[
            "-c",
            "rebase.backend=merge",
            "rebase",
            base_branch,
            target_branch,
        ],
        repository,
        "rebase",
        GitOptions::default().with_expected_errors([GitErrorKind::RebaseConflicts]),
    )
    .await?;

    Ok(parse_rebase_result(&output))
}

/// Rebases `target_branch` onto `base_branch`, streaming per-commit progress.
pub async fn rebase_with_progress<F>(
    repository: impl AsRef<Path>,
    base_branch: &str,
    target_branch: &str,
    mut on_progress: F,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    let repository = repository.as_ref();
    let Some(commits) = get_commits_between_commits(repository, base_branch, target_branch).await?
    else {
        return Ok(RebaseResult::Error);
    };
    let mut parser = RebaseProgressParser::new(&commits);
    let output = git_with_stderr(
        &[
            "-c",
            "rebase.backend=merge",
            "rebase",
            base_branch,
            target_branch,
        ],
        repository,
        "rebase",
        GitOptions::default().with_expected_errors([GitErrorKind::RebaseConflicts]),
        |chunk| {
            for progress in parser.push(chunk) {
                on_progress(progress);
            }
        },
    )
    .await?;
    if let Some(progress) = parser.finish() {
        on_progress(progress);
    }

    Ok(parse_rebase_result(&output))
}

/// Abandons the current rebase operation.
pub async fn abort_rebase(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["rebase", "--abort"],
        repository,
        "abortRebase",
        GitOptions::default(),
    )
    .await?;
    Ok(())
}

/// Stages the selected files and proceeds with the current rebase.
///
/// Untracked files must not be included in `files`; the frontend constructs this list from status
/// and sends only tracked, fully-selected changes. Partial selections remain gated on the patch
/// formatter, like commit staging.
pub async fn continue_rebase(
    repository: impl AsRef<Path>,
    files: &[FileToStage],
    manual_resolutions: &[RebaseConflictResolution],
    no_verify: bool,
) -> Result<RebaseResult, GitError> {
    continue_rebase_impl(repository, files, manual_resolutions, no_verify, None).await
}

/// Continues a rebase while streaming progress for commits applied after the current one.
pub async fn continue_rebase_with_progress<F>(
    repository: impl AsRef<Path>,
    files: &[FileToStage],
    manual_resolutions: &[RebaseConflictResolution],
    no_verify: bool,
    mut on_progress: F,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    continue_rebase_impl(
        repository,
        files,
        manual_resolutions,
        no_verify,
        Some(&mut on_progress),
    )
    .await
}

async fn continue_rebase_impl(
    repository: impl AsRef<Path>,
    files: &[FileToStage],
    manual_resolutions: &[RebaseConflictResolution],
    no_verify: bool,
    progress_callback: Option<&mut (dyn FnMut(MultiCommitOperationProgress) + Send)>,
) -> Result<RebaseResult, GitError> {
    let repository = repository.as_ref();

    // The original received full status objects and filtered untracked files before staging.
    // `FileToStage` deliberately carries only index facts, so recover that classification here
    // rather than trusting every caller to remember it. Listing individually matters for a nested
    // untracked path: the collapsed status would report only its parent directory.
    let Some(status_before) = get_status(repository, true).await? else {
        return Ok(RebaseResult::Aborted);
    };
    let untracked_paths: HashSet<&str> = status_before
        .files
        .iter()
        .filter_map(|file| {
            matches!(file.status, AppFileStatus::Untracked { .. }).then_some(file.path.as_str())
        })
        .collect();

    for resolution in manual_resolutions {
        stage_manual_conflict_resolution_with_entries(
            repository,
            &resolution.path,
            resolution.resolution,
            resolution.entries,
        )
        .await?;
    }

    let other_files: Vec<FileToStage> = files
        .iter()
        .filter(|file| {
            !untracked_paths.contains(file.path.as_str())
                && !manual_resolutions
                    .iter()
                    .any(|resolution| resolution.path == file.path)
        })
        .cloned()
        .collect();
    stage_files(repository, &other_files).await?;

    let Some(status) = get_status(repository, false).await? else {
        return Ok(RebaseResult::Aborted);
    };

    let git_dir = crate::rev_parse::resolve_git_dir(repository).await?;
    if tokio::fs::read_to_string(git_dir.join("REBASE_HEAD"))
        .await
        .is_err()
    {
        return Ok(RebaseResult::Aborted);
    }

    let has_tracked_changes = status
        .files
        .iter()
        .any(|file| !matches!(file.status, AppFileStatus::Untracked { .. }));

    let mut args = if has_tracked_changes {
        vec!["rebase", "--continue"]
    } else {
        vec!["rebase", "--skip"]
    };
    if no_verify {
        args.push("--no-verify");
    }

    let name = if has_tracked_changes {
        "continueRebase"
    } else {
        "continueRebaseSkipCurrentCommit"
    };
    let options = || {
        GitOptions::default()
            .with_expected_errors([
                GitErrorKind::RebaseConflicts,
                GitErrorKind::UnresolvedConflicts,
            ])
            // Prevent git from opening an editor for the replayed commit message.
            .with_env("GIT_EDITOR", ":")
    };

    let output = if let Some(on_progress) = progress_callback {
        let Some(snapshot) = get_rebase_snapshot(repository).await? else {
            return Ok(RebaseResult::Aborted);
        };
        let mut parser = RebaseProgressParser::new(&snapshot.commits);
        let output = git_with_stderr(&args, repository, name, options(), |chunk| {
            for progress in parser.push(chunk) {
                on_progress(progress);
            }
        })
        .await?;
        if let Some(progress) = parser.finish() {
            on_progress(progress);
        }
        output
    } else {
        git(&args, repository, name, options()).await?
    };

    Ok(parse_rebase_result(&output))
}

fn parse_rebase_result(output: &GitOutput) -> RebaseResult {
    if output.exit_code == 0 {
        let stdout = output.stdout_lossy();
        if stdout
            .trim()
            .to_ascii_lowercase()
            .starts_with("current branch ")
            && stdout
                .trim()
                .to_ascii_lowercase()
                .ends_with(" is up to date.")
        {
            RebaseResult::AlreadyUpToDate
        } else {
            RebaseResult::CompletedWithoutError
        }
    } else {
        match output.git_error {
            Some(GitErrorKind::RebaseConflicts) => RebaseResult::ConflictsEncountered,
            Some(GitErrorKind::UnresolvedConflicts) => RebaseResult::OutstandingFilesNotStaged,
            _ => RebaseResult::Error,
        }
    }
}

#[cfg(test)]
mod interactive_tests {
    use super::*;

    #[test]
    fn builds_a_cat_editor_command() {
        assert_eq!(
            cat_editor_command(Path::new("/tmp/rdc-todo-1")).expect("should build"),
            "cat \"/tmp/rdc-todo-1\" >"
        );
    }

    #[test]
    fn refuses_a_path_that_could_escape_the_shell_command() {
        // git runs the editor value through a shell, so a quote or `$` in the path would let it break
        // out. We build these paths ourselves, but an unusual TMPDIR is how "can't happen" happens.
        for path in [
            "/tmp/a\"b",
            "/tmp/a`b`",
            "/tmp/a$b",
            "/tmp/a'b",
            "/tmp/a\nb",
        ] {
            assert!(
                cat_editor_command(Path::new(path)).is_err(),
                "{path:?} should be refused"
            );
        }
    }

    #[test]
    fn renders_a_todo_list_git_can_read() {
        let commit = CommitOneLine {
            sha: "abc123".to_owned(),
            summary: "a summary".to_owned(),
        };
        let todo = vec![TodoStep::pick(&commit), TodoStep::squash(&commit)];

        assert_eq!(
            render_todo(&todo),
            "pick abc123 a summary\nsquash abc123 a summary\n"
        );
    }

    #[test]
    fn a_temp_file_removes_itself_when_dropped() {
        let path = {
            let file = TempFile::write("test", "contents").expect("should write");
            assert_eq!(
                std::fs::read_to_string(file.path()).expect("should read"),
                "contents"
            );
            file.path().to_owned()
        };

        assert!(!path.exists(), "the guard should have removed it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    async fn rebase_repository() -> TempRepository {
        let repo = empty_repository().await;
        let path = repo.path();

        commit_file(&path, "README.md", "base\n", "first");
        commit_file(&path, "THING.md", "common\n", "second");
        git(
            &["branch", "base-branch"],
            &path,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("base branch should be created");
        git(&["branch", "feature"], &path, "test", GitOptions::default())
            .await
            .expect("feature branch should be created");

        git(
            &["checkout", "base-branch"],
            &path,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&path, "THING.md", "base side\n", "base change");

        git(
            &["checkout", "feature"],
            &path,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&path, "THING.md", "feature side\n", "feature change");

        git(&["checkout", "main"], &path, "test", GitOptions::default())
            .await
            .expect("checkout should succeed");
        repo
    }

    async fn two_commit_rebase_repository() -> TempRepository {
        let repo = empty_repository().await;
        let path = repo.path();
        commit_file(&path, "conflict.txt", "common\n", "base");
        git(&["branch", "feature"], &path, "test", GitOptions::default())
            .await
            .expect("feature branch should be created");

        git(
            &["checkout", "feature"],
            &path,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&path, "conflict.txt", "feature\n", "First feature commit");
        commit_file(&path, "second.txt", "second\n", "Second feature commit");

        git(&["checkout", "main"], &path, "test", GitOptions::default())
            .await
            .expect("checkout should succeed");
        commit_file(&path, "conflict.txt", "main\n", "main change");
        repo
    }

    async fn current_branch(repo: &Path) -> String {
        git(
            &["branch", "--show-current"],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch query should succeed")
        .stdout_trimmed()
    }

    #[tokio::test]
    async fn reports_conflicts_and_leaves_rebase_state_for_status() {
        let repo = rebase_repository().await;
        let feature_tip = git(
            &["rev-parse", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        let base_tip = git(
            &["rev-parse", "base-branch"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        assert_eq!(
            rebase(repo.path(), "base-branch", "feature")
                .await
                .expect("conflict is an expected result"),
            RebaseResult::ConflictsEncountered
        );

        let status = get_status(repo.path(), true)
            .await
            .expect("status should succeed")
            .expect("repository exists");
        let state = status
            .rebase_internal_state
            .expect("rebase state should be detected");
        assert_eq!(state.original_branch_tip, feature_tip);
        assert_eq!(state.base_branch_tip, base_tip);
        assert_eq!(state.target_branch, "feature");
        assert!(status.current_branch.is_none());
        assert_eq!(
            status
                .files
                .iter()
                .filter(|file| matches!(file.status, AppFileStatus::Conflicted(_)))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn abort_restores_the_target_branch_and_clean_worktree() {
        let repo = rebase_repository().await;
        rebase(repo.path(), "base-branch", "feature")
            .await
            .expect("rebase should return its conflict");
        abort_rebase(repo.path())
            .await
            .expect("abort should succeed");

        assert_eq!(current_branch(&repo.path()).await, "feature");
        let status = get_status(repo.path(), true)
            .await
            .expect("status should succeed")
            .expect("repository exists");
        assert!(status.rebase_internal_state.is_none());
        assert!(status.files.is_empty());
    }

    #[tokio::test]
    async fn continuing_without_resolving_reports_outstanding_files() {
        let repo = rebase_repository().await;
        rebase(repo.path(), "base-branch", "feature")
            .await
            .expect("rebase should return its conflict");

        assert_eq!(
            continue_rebase(repo.path(), &[], &[], false)
                .await
                .expect("unresolved conflicts are an expected result"),
            RebaseResult::OutstandingFilesNotStaged
        );
    }

    #[tokio::test]
    async fn stages_a_resolution_and_completes_the_rebase() {
        let repo = rebase_repository().await;
        let before = git(
            &["rev-parse", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        rebase(repo.path(), "base-branch", "feature")
            .await
            .expect("rebase should return its conflict");

        std::fs::write(repo.path().join("THING.md"), "resolved feature side\n")
            .expect("resolution should be written");
        assert_eq!(
            continue_rebase(repo.path(), &[FileToStage::new("THING.md")], &[], false)
                .await
                .expect("continue should succeed"),
            RebaseResult::CompletedWithoutError
        );

        assert_eq!(current_branch(&repo.path()).await, "feature");
        let after = git(
            &["rev-parse", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        assert_ne!(before, after);
    }

    #[tokio::test]
    async fn an_omitted_tracked_change_prevents_continue() {
        let repo = rebase_repository().await;
        rebase(repo.path(), "base-branch", "feature")
            .await
            .expect("rebase should return its conflict");
        std::fs::write(repo.path().join("THING.md"), "resolved\n")
            .expect("resolution should be written");
        std::fs::write(repo.path().join("README.md"), "unrelated tracked change\n")
            .expect("tracked change should be written");

        assert_eq!(
            continue_rebase(repo.path(), &[FileToStage::new("THING.md")], &[], false)
                .await
                .expect("unstaged files are an expected result"),
            RebaseResult::OutstandingFilesNotStaged
        );
    }

    #[tokio::test]
    async fn selected_unrelated_changes_join_the_replayed_commit_but_untracked_files_do_not() {
        let repo = rebase_repository().await;
        rebase(repo.path(), "base-branch", "feature")
            .await
            .expect("rebase should return its conflict");
        std::fs::write(repo.path().join("THING.md"), "resolved\n")
            .expect("resolution should be written");
        std::fs::write(repo.path().join("README.md"), "selected tracked change\n")
            .expect("tracked change should be written");
        std::fs::write(repo.path().join("UNTRACKED.md"), "leave me out\n")
            .expect("untracked file should be written");

        assert_eq!(
            continue_rebase(
                repo.path(),
                &[
                    FileToStage::new("THING.md"),
                    FileToStage::new("README.md"),
                    // Even if a caller accidentally includes it, parity with the original requires
                    // continueRebase to keep untracked files out of the index.
                    FileToStage::new("UNTRACKED.md"),
                ],
                &[],
                false
            )
            .await
            .expect("continue should succeed"),
            RebaseResult::CompletedWithoutError
        );

        let committed_paths = git(
            &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("diff-tree should succeed")
        .stdout_lossy()
        .into_owned();
        assert!(committed_paths.lines().any(|path| path == "README.md"));
        assert!(!committed_paths.lines().any(|path| path == "UNTRACKED.md"));

        let status = get_status(repo.path(), true)
            .await
            .expect("status should succeed")
            .expect("repository exists");
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "UNTRACKED.md");
        assert!(matches!(
            status.files[0].status,
            AppFileStatus::Untracked { .. }
        ));
    }

    #[tokio::test]
    async fn reports_an_already_up_to_date_branch() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file", "one", "first");
        git(
            &["branch", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        assert_eq!(
            rebase(repo.path(), "main", "feature")
                .await
                .expect("rebase should succeed"),
            RebaseResult::AlreadyUpToDate
        );
    }

    #[test]
    fn parses_rebase_progress_with_commit_summaries() {
        let commits = vec![
            CommitOneLine {
                sha: "a".repeat(40),
                summary: "First".to_owned(),
            },
            CommitOneLine {
                sha: "b".repeat(40),
                summary: "Second".to_owned(),
            },
        ];
        let mut parser = RebaseProgressParser::new(&commits);

        assert!(parser.push(b"Rebasing (1").is_empty());
        assert_eq!(
            parser.push(b"/2)\rAuto-merging file\nRebasing (2/2)\r"),
            vec![
                MultiCommitOperationProgress {
                    kind: MultiCommitOperationProgressKind::MultiCommitOperation,
                    value: 0.5,
                    position: 1,
                    total_commit_count: 2,
                    current_commit_summary: "First".to_owned(),
                },
                MultiCommitOperationProgress {
                    kind: MultiCommitOperationProgressKind::MultiCommitOperation,
                    value: 1.0,
                    position: 2,
                    total_commit_count: 2,
                    current_commit_summary: "Second".to_owned(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn snapshot_is_none_outside_a_repository() {
        let directory = tempfile::tempdir().expect("temp dir should be created");
        assert_eq!(
            get_rebase_snapshot(directory.path())
                .await
                .expect("a non-repository is a normal answer"),
            None
        );
    }

    #[tokio::test]
    async fn streams_progress_recovers_a_snapshot_and_continues() {
        let repo = two_commit_rebase_repository().await;
        let mut progress = Vec::new();
        assert_eq!(
            rebase_with_progress(repo.path(), "main", "feature", |event| {
                progress.push(event);
            })
            .await
            .expect("the conflict is an expected result"),
            RebaseResult::ConflictsEncountered
        );
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].position, 1);
        assert_eq!(progress[0].total_commit_count, 2);
        assert_eq!(progress[0].current_commit_summary, "First feature commit");

        let snapshot = get_rebase_snapshot(repo.path())
            .await
            .expect("snapshot should load")
            .expect("a rebase is in progress");
        assert_eq!(snapshot.commits.len(), 2);
        assert_eq!(snapshot.progress, progress[0]);

        std::fs::write(repo.path().join("conflict.txt"), "resolved\n")
            .expect("resolution should be written");
        let mut continued_progress = Vec::new();
        assert_eq!(
            continue_rebase_with_progress(
                repo.path(),
                &[FileToStage::new("conflict.txt")],
                &[],
                false,
                |event| continued_progress.push(event),
            )
            .await
            .expect("continue should succeed"),
            RebaseResult::CompletedWithoutError
        );
        assert_eq!(
            continued_progress.last().map(|event| (
                event.position,
                event.total_commit_count,
                event.current_commit_summary.as_str()
            )),
            Some((2, 2, "Second feature commit"))
        );
    }
}

// ---------------------------------------------------------------------------
// Interactive rebase
// ---------------------------------------------------------------------------

/// What an interactive rebase should do with a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoAction {
    /// Replay the commit as it is.
    Pick,
    /// Fold the commit into the previous one.
    Squash,
}

impl TodoAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pick => "pick",
            Self::Squash => "squash",
        }
    }
}

/// One line of an interactive rebase todo list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoStep {
    pub action: TodoAction,
    pub sha: String,
    pub summary: String,
}

impl TodoStep {
    pub fn pick(commit: &CommitOneLine) -> Self {
        Self {
            action: TodoAction::Pick,
            sha: commit.sha.clone(),
            summary: commit.summary.clone(),
        }
    }

    pub fn squash(commit: &CommitOneLine) -> Self {
        Self {
            action: TodoAction::Squash,
            sha: commit.sha.clone(),
            summary: commit.summary.clone(),
        }
    }
}

/// Renders a todo list in the form git's sequencer reads.
pub fn render_todo(steps: &[TodoStep]) -> String {
    steps
        .iter()
        .map(|step| format!("{} {} {}\n", step.action.as_str(), step.sha, step.summary))
        .collect()
}

/// Writes a temporary file that removes itself when dropped.
///
/// Public because `squash` needs one for the commit message it feeds to `GIT_EDITOR`.
pub fn write_temp_file(prefix: &str, contents: &str) -> Result<TempFile, GitError> {
    TempFile::write(prefix, contents)
}

/// A temporary file that removes itself when dropped.
///
/// The original wrote these with `getTempFilePath` and deleted them in a `finally`. A guard makes the
/// cleanup structural instead, so an early return can't leak the file.
pub struct TempFile {
    path: PathBuf,
}

impl TempFile {
    /// Writes `contents` to a uniquely named file under the system temp directory.
    ///
    /// The name is built from the process id and a counter rather than random bytes, which is enough:
    /// the file lives for one git invocation and is not a security boundary.
    fn write(prefix: &str, contents: &str) -> Result<Self, GitError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);

        let name = format!(
            "rdc-{prefix}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);

        std::fs::write(&path, contents).map_err(|source| GitError::Spawn {
            name: prefix.to_owned(),
            path: path.clone(),
            source,
        })?;

        Ok(Self { path })
    }

    /// Where the file is.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Builds a `cat "<path}" >` command for git to use as an editor.
///
/// git runs an editor value **through a shell**, which is why the path is checked rather than merely
/// quoted: a directory containing a quote, backtick or `$` would let it break out of the command. We
/// construct these paths ourselves so this should never fire, but a surprising `TMPDIR` is exactly the
/// kind of thing that makes "should never" wrong.
///
/// git appends the file it wanted edited, so the redirection overwrites that with our contents.
pub fn cat_editor_command(path: &Path) -> Result<String, GitError> {
    let path = path.to_string_lossy();

    if path.contains(['"', '\'', '`', '$', '\\', '\n']) {
        return Err(GitError::Parse {
            context: "rebaseInteractive".to_owned(),
            message: format!(
                "refusing to build a shell command for a path containing shell metacharacters: {path:?}"
            ),
        });
    }

    Ok(format!("cat \"{path}\" >"))
}

/// Runs an interactive rebase against a prepared todo list.
///
/// This is the machinery `squash` and `reorder` are built on: they compute a todo list, and this
/// replaces git's interactive editor with one that simply writes that list out.
///
/// - **`lastRetainedCommitRef` of `None` means `--root`.** The first commit on a branch has no parent to
///   name, so there is no ref to rebase from.
/// - **`GIT_SEQUENCE_EDITOR` is explicitly cleared.** An environment variable overrides the
///   `-c sequence.editor` we pass, so a user with one set would otherwise get their own editor and the
///   operation would appear to hang.
/// - **`GIT_EDITOR` defaults to `:`** — a no-op — so git doesn't open an editor for a commit message.
///   `squash` overrides it to supply one.
///
/// `commits` is only used to report progress; without a progress callback it is ignored.
pub async fn rebase_interactive<F>(
    repository: impl AsRef<Path>,
    todo: &[TodoStep],
    last_retained_commit_ref: Option<&str>,
    commits: &[CommitOneLine],
    git_editor: Option<&str>,
    on_progress: Option<F>,
) -> Result<RebaseResult, GitError>
where
    F: FnMut(MultiCommitOperationProgress) + Send,
{
    let repository = repository.as_ref();

    if todo.is_empty() {
        return Ok(RebaseResult::Error);
    }

    let todo_file = TempFile::write("rebase-todo", &render_todo(todo))?;
    let sequence_editor = cat_editor_command(todo_file.path())?;

    let reference = last_retained_commit_ref.unwrap_or("--root");

    let args = vec![
        "-c".to_owned(),
        format!("sequence.editor={sequence_editor}"),
        // Pinned for the same reason as the non-interactive path: the state files the rest of the app
        // reads are the merge backend's.
        "-c".to_owned(),
        "rebase.backend=merge".to_owned(),
        "rebase".to_owned(),
        "-i".to_owned(),
        reference.to_owned(),
    ];

    let options = GitOptions::default()
        .with_expected_errors([GitErrorKind::RebaseConflicts])
        // *Removed*, not emptied: an empty value makes git try to run "" as an editor, while removing
        // it lets the `-c sequence.editor` above take effect even for a user who has one exported.
        .without_env("GIT_SEQUENCE_EDITOR")
        .with_env("GIT_EDITOR", git_editor.unwrap_or(":"));

    let output = match on_progress {
        Some(mut on_progress) => {
            let mut parser = RebaseProgressParser::new(commits);
            let output =
                git_with_stderr(&args, repository, "rebaseInteractive", options, |chunk| {
                    for progress in parser.push(chunk) {
                        on_progress(progress);
                    }
                })
                .await?;
            if let Some(progress) = parser.finish() {
                on_progress(progress);
            }
            output
        }
        None => git(&args, repository, "rebaseInteractive", options).await?,
    };

    Ok(parse_rebase_result(&output))
}
