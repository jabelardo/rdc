//! Starting, finishing and recovering an operation against the registry.
//!
//! Not commands — the layer between the domain modules above and
//! [`crate::commands::operation`], which owns the generic registry calls. What lives here is the
//! per-operation-kind machinery: what a terminated checkout, commit, merge or rebase left behind,
//! and what has to be undone before the repository lock can be released.
//!
//! Extracted from `git.rs` because it was already shared and the sharing was invisible:
//! `recover_merge_termination` and `recover_rebase_termination` were `pub(crate)` and called from
//! `remote.rs` and `stash.rs` while sitting in a module named for neither. Giving the family a
//! module of its own is what lets the domain modules stay thin, which is the rule
//! BACKEND_STRUCTURE.md states for `commands/`.
//!
//! Every test in `git.rs` was a test of these functions, so they came too.

use crate::commands::CommandError;
use crate::operation::GitOperationKind;
use crate::operation::OperationError;
use crate::operation::OperationErrorKind;
use crate::operation::OperationOutcome;
use crate::operation::OperationState;
use crate::operation_registry::OperationRegistry;
use crate::operation_registry::WatchdogPolicy;
use git_ops::checkout::CheckoutProgress;
use git_ops::checkout::CheckoutTarget;
use git_ops::cherry_pick::CherryPickResult;
use git_ops::merge::MergeResult;
use git_ops::rebase::RebaseResult;
use tauri::ipc::Channel;
use tauri::WebviewWindow;

pub(crate) async fn finish_commit_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    snapshot: &git_ops::commit::CommitSnapshot,
    reason: git_ops::TerminationReason,
) -> Result<String, CommandError> {
    let (state, kind, verb) = match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    };
    let completed = git_ops::commit::classify_commit_termination(repository_path, snapshot)
        .await
        .map_err(|error| finish_commit_recovery_failure(registry, operation_id, error))?;
    if completed {
        let sha = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_commit_recovery_failure(registry, operation_id, error))?;
        let _ = registry.finish(
            operation_id,
            OperationState::Completed,
            OperationOutcome::Completed,
            None,
        );
        return Ok(sha);
    }
    git_ops::commit::restore_commit_snapshot(repository_path, snapshot)
        .await
        .map_err(|error| finish_commit_recovery_failure(registry, operation_id, error))?;
    let message = format!("Commit {verb} and recovered");
    let _ = registry.finish(
        operation_id,
        state,
        OperationOutcome::Recovered,
        Some(OperationError {
            kind,
            message: message.clone(),
            recoverable: true,
        }),
    );
    Err(CommandError::message(message))
}

pub(crate) fn finish_commit_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

pub(crate) async fn run_cancellable_branch_checkout(
    registry: &OperationRegistry,
    repository_path: &str,
    owner_window: Option<String>,
    target: CheckoutTarget<'_>,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        registry,
        repository_path,
        owner_window,
        GitOperationKind::Checkout,
        "Cancel checkout",
    )
    .await?;
    let snapshot = match git_ops::checkout::get_checkout_snapshot(repository_path).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::RecoveryFailed,
                    message: command_error.message.clone(),
                    recoverable: false,
                }),
            );
            return Err(command_error);
        }
    };
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::checkout::checkout_branch_with_progress_controlled(
        repository_path,
        target,
        move |progress| {
            let _ = on_progress.send(progress);
        },
        Some(control),
    )
    .await;
    watchdog.abort();
    match result {
        Ok(()) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            recover_checkout_termination(
                registry,
                &operation.id,
                repository_path,
                &snapshot,
                reason,
            )
            .await
        }
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

pub(crate) async fn recover_checkout_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    snapshot: &git_ops::checkout::CheckoutSnapshot,
    reason: git_ops::TerminationReason,
) -> Result<(), CommandError> {
    let (state, kind, verb) = match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    };
    let _ = registry.enter_recovery(operation_id);
    match git_ops::get_head_sha(repository_path).await {
        Ok(current_head) if current_head != snapshot.head_sha => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(());
        }
        Ok(_) => {}
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::RecoveryFailed,
                    message: command_error.message.clone(),
                    recoverable: false,
                }),
            );
            return Err(command_error);
        }
    }
    match git_ops::checkout::restore_checkout_snapshot(repository_path, snapshot).await {
        Ok(()) => {
            let message = format!("Checkout {verb} and recovered");
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Recovered,
                Some(OperationError {
                    kind,
                    message: message.clone(),
                    recoverable: true,
                }),
            );
            Err(CommandError::message(message))
        }
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                state,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::RecoveryFailed,
                    message: command_error.message.clone(),
                    recoverable: false,
                }),
            );
            Err(command_error)
        }
    }
}

pub(crate) async fn run_cancellable_commit_checkout(
    registry: &OperationRegistry,
    repository_path: &str,
    owner_window: Option<String>,
    commit: &str,
    on_progress: Channel<CheckoutProgress>,
) -> Result<(), CommandError> {
    let operation = crate::commands::operations::start_cancellable_repository_operation(
        registry,
        repository_path,
        owner_window,
        GitOperationKind::Checkout,
        "Cancel checkout",
    )
    .await?;
    let snapshot = match git_ops::checkout::get_checkout_snapshot(repository_path).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::RecoveryFailed,
                    message: command_error.message.clone(),
                    recoverable: false,
                }),
            );
            return Err(command_error);
        }
    };
    let control = registry
        .control(&operation.id)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let watchdog = registry.spawn_watchdog(operation.id.clone(), WatchdogPolicy::default());
    let result = git_ops::checkout::checkout_commit_with_progress_controlled(
        repository_path,
        commit,
        move |progress| {
            let _ = on_progress.send(progress);
        },
        Some(control),
    )
    .await;
    watchdog.abort();
    match result {
        Ok(()) => {
            let _ = registry.finish(
                &operation.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(git_ops::GitError::OperationTerminated { reason, .. }) => {
            recover_checkout_termination(
                registry,
                &operation.id,
                repository_path,
                &snapshot,
                reason,
            )
            .await
        }
        Err(error) => {
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                &operation.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message: command_error.message.clone(),
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

pub(crate) async fn recover_merge_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    squash: bool,
    reason: git_ops::TerminationReason,
) -> Result<MergeResult, CommandError> {
    // Plain merges expose MERGE_HEAD; squash merges intentionally do not, and leave SQUASH_MSG
    // plus index/worktree state instead. Only recover inside the marker belonging to this phase.
    let in_progress = if squash {
        git_ops::merge::is_squash_merge_in_progress(repository_path).await
    } else {
        let git_dir = git_ops::rev_parse::resolve_git_dir(repository_path)
            .await
            .map_err(|error| finish_merge_recovery_failure(registry, operation_id, error))?;
        Ok(git_ops::operation_state::is_merge_head_set(git_dir).await)
    }
    .map_err(|error| finish_merge_recovery_failure(registry, operation_id, error))?;

    // Git can advance HEAD before a late stop reaches a post-merge hook while leaving merge
    // metadata visible until that hook returns. A moved HEAD is therefore authoritative even when
    // a marker still exists; aborting in that state would undo an already completed merge.
    let current_head = git_ops::get_head_sha(repository_path)
        .await
        .map_err(|error| finish_merge_recovery_failure(registry, operation_id, error))?;
    if current_head != pre_operation_head {
        let _ = registry.finish(
            operation_id,
            OperationState::Completed,
            OperationOutcome::Completed,
            None,
        );
        return Ok(MergeResult::Success);
    }

    if !in_progress {
        let (state, kind, verb) = merge_termination_details(reason);
        let message = format!("Merge {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    let recovery = if squash {
        git_ops::merge::abort_squash_merge(repository_path).await
    } else {
        git_ops::merge::abort_merge(repository_path).await
    };
    match recovery {
        Ok(()) => {
            let (state, _, verb) = merge_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!("Merge {verb} and recovered")))
        }
        Err(error) => Err(finish_merge_recovery_failure(registry, operation_id, error)),
    }
}

pub(crate) fn merge_termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

pub(crate) fn finish_merge_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

pub(crate) async fn recover_rebase_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    reason: git_ops::TerminationReason,
) -> Result<RebaseResult, CommandError> {
    // A stop request may arrive after Git has finished the last commit. Only abort while rebase
    // metadata remains; otherwise the abort would undo a completed rebase.
    let snapshot = git_ops::rebase::get_rebase_snapshot(repository_path)
        .await
        .map_err(|error| finish_rebase_recovery_failure(registry, operation_id, error))?;
    if snapshot.is_none() {
        let current_head = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_rebase_recovery_failure(registry, operation_id, error))?;
        if current_head != pre_operation_head {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(RebaseResult::CompletedWithoutError);
        }

        let (state, kind, verb) = rebase_termination_details(reason);
        let message = format!("Rebase {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    match git_ops::rebase::abort_rebase(repository_path).await {
        Ok(()) => {
            let (state, _, verb) = rebase_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!(
                "Rebase {verb} and recovered"
            )))
        }
        Err(error) => Err(finish_rebase_recovery_failure(
            registry,
            operation_id,
            error,
        )),
    }
}

pub(crate) fn rebase_termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

pub(crate) fn finish_rebase_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

pub(crate) fn finish_checkout_mutation(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<(), git_ops::GitError>,
) -> Result<(), CommandError> {
    match result {
        Ok(()) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message,
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

#[cfg(test)]
mod termination_tests {
    use super::*;

    #[test]
    fn classifies_rebase_cancellation_and_timeout() {
        assert_eq!(
            rebase_termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            rebase_termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }

    #[test]
    fn classifies_merge_cancellation_and_timeout() {
        assert_eq!(
            merge_termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            merge_termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }
}

#[cfg(test)]
mod commit_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repository() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 15 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice15@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "initial\n")
            .expect("initial file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "initial"]);
        directory
    }

    fn start_commit_operation(registry: &OperationRegistry, repository_path: &str) -> String {
        registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.to_owned(),
                    repository_path: repository_path.to_owned(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Commit,
                CancellationCapability::Available {
                    label: "Cancel commit".to_owned(),
                },
            )
            .expect("commit operation should reserve the repository")
            .id
    }

    #[tokio::test]
    async fn command_recovery_restores_the_index_when_commit_did_not_advance_head() {
        let directory = repository();
        std::fs::write(directory.path().join("file.txt"), "changed\n")
            .expect("changed file should be written");
        let snapshot = git_ops::commit::get_commit_snapshot(directory.path())
            .await
            .expect("commit snapshot should succeed");
        let original_index = snapshot.index.clone().expect("index should exist");
        run_git(directory.path(), &["add", "file.txt"]);

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_commit_operation(&registry, &repository_path);
        let result = finish_commit_termination(
            &registry,
            &operation_id,
            &repository_path,
            &snapshot,
            git_ops::TerminationReason::TimedOut,
        )
        .await;

        assert!(result.is_err(), "an unchanged commit should report timeout");
        let restored = git_ops::commit::get_commit_snapshot(directory.path())
            .await
            .expect("restored snapshot should succeed")
            .index
            .expect("restored index should exist");
        assert_eq!(restored, original_index);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path,
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_returns_the_sha_when_commit_advanced_before_stop() {
        let directory = repository();
        std::fs::write(directory.path().join("file.txt"), "committed\n")
            .expect("changed file should be written");
        let snapshot = git_ops::commit::get_commit_snapshot(directory.path())
            .await
            .expect("commit snapshot should succeed");
        run_git(directory.path(), &["add", "file.txt"]);
        run_git(directory.path(), &["commit", "-qm", "completed"]);
        let expected_sha = run_git(directory.path(), &["rev-parse", "HEAD"]);

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_commit_operation(&registry, &repository_path);
        let result = finish_commit_termination(
            &registry,
            &operation_id,
            &repository_path,
            &snapshot,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a completed commit should win the cancellation race");

        assert_eq!(result, expected_sha);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path,
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_retains_the_lock_when_commit_state_cannot_be_read() {
        let directory = repository();
        std::fs::write(directory.path().join("file.txt"), "changed\n")
            .expect("changed file should be written");
        let snapshot = git_ops::commit::get_commit_snapshot(directory.path())
            .await
            .expect("commit snapshot should succeed");
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_commit_operation(&registry, &repository_path);
        std::fs::rename(
            directory.path().join(".git"),
            directory.path().join("git-metadata"),
        )
        .expect("git metadata should be moved to simulate an unreadable repository");

        let result = finish_commit_termination(
            &registry,
            &operation_id,
            &repository_path,
            &snapshot,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "unreadable state must be reported as an error"
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path,
            })
            .is_some());
    }
}

#[cfg(test)]
mod rebase_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use crate::operation_registry::OperationRegistry;
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn conflicted_rebase_repository() -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("conflict.txt"), "base\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        run_git(directory.path(), &["branch", "feature"]);
        run_git(directory.path(), &["checkout", "-q", "feature"]);
        std::fs::write(directory.path().join("conflict.txt"), "feature\n")
            .expect("feature file should be written");
        run_git(directory.path(), &["commit", "-qam", "feature change"]);
        run_git(directory.path(), &["checkout", "-q", "main"]);
        std::fs::write(directory.path().join("conflict.txt"), "main\n")
            .expect("main file should be written");
        run_git(directory.path(), &["commit", "-qam", "main change"]);
        let feature_head = run_git(directory.path(), &["rev-parse", "feature"]);
        let rebase = Command::new("git")
            .args(["rebase", "main", "feature"])
            .current_dir(directory.path())
            .output()
            .expect("rebase should start");
        assert!(
            !rebase.status.success(),
            "rebase should stop with a conflict"
        );
        (directory, feature_head)
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_rebase_and_releases_the_lock() {
        let (directory, original_head) = conflicted_rebase_repository();
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Rebase,
                CancellationCapability::Available {
                    label: "Cancel rebase".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &original_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should be reported to the caller"
        );
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("conflict.txt"))
                .expect("worktree file should be readable"),
            "feature\n"
        );
        assert_eq!(
            run_git(directory.path(), &["diff", "--cached", "--quiet"]),
            ""
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_late_rebase_stop_as_completed() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "one\n")
            .expect("first file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "first"]);
        let pre_operation_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("file.txt"), "two\n")
            .expect("second file should be written");
        run_git(directory.path(), &["commit", "-qam", "second"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Rebase,
                CancellationCapability::Available {
                    label: "Cancel rebase".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = recover_rebase_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        assert_eq!(result, RebaseResult::CompletedWithoutError);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }
}

#[cfg(test)]
mod merge_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use crate::operation_registry::OperationRegistry;
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn run_git_allowing_failure(repository: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start")
    }

    fn base_repository() -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 14 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice14@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "base\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        run_git(directory.path(), &["branch", "feature"]);
        run_git(directory.path(), &["checkout", "-q", "feature"]);
        std::fs::write(directory.path().join("file.txt"), "feature\n")
            .expect("feature file should be written");
        run_git(directory.path(), &["commit", "-qam", "feature change"]);
        run_git(directory.path(), &["checkout", "-q", "main"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        (directory, original_head)
    }

    fn conflicted_merge_repository() -> (tempfile::TempDir, String) {
        let (directory, _) = base_repository();
        std::fs::write(directory.path().join("file.txt"), "main\n")
            .expect("main file should be written");
        run_git(directory.path(), &["commit", "-qam", "main change"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        let merge = run_git_allowing_failure(directory.path(), &["merge", "feature"]);
        assert!(!merge.status.success(), "merge should stop with a conflict");
        (directory, original_head)
    }

    fn start_merge_operation(registry: &OperationRegistry, repository_path: &str) -> String {
        registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.to_owned(),
                    repository_path: repository_path.to_owned(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Merge,
                CancellationCapability::Available {
                    label: "Cancel merge".to_owned(),
                },
            )
            .expect("merge operation should reserve the repository")
            .id
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_merge_and_restores_the_worktree() {
        let (directory, original_head) = conflicted_merge_repository();
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        let result = recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            &original_head,
            false,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(result.is_err(), "cancellation should be reported");
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt"))
                .expect("worktree file should be readable"),
            "main\n"
        );
        assert!(
            run_git_allowing_failure(directory.path(), &["diff", "--quiet"])
                .status
                .success()
        );
        assert!(
            run_git_allowing_failure(directory.path(), &["diff", "--cached", "--quiet"])
                .status
                .success()
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_squash_merge_without_moving_head() {
        let (directory, original_head) = base_repository();
        run_git(directory.path(), &["merge", "--squash", "feature"]);
        assert!(
            git_ops::merge::is_squash_merge_in_progress(directory.path())
                .await
                .expect("squash state should be readable")
        );
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        let result = recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            &original_head,
            true,
            git_ops::TerminationReason::TimedOut,
        )
        .await;

        assert!(result.is_err(), "timeout should be reported");
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt"))
                .expect("worktree file should be readable"),
            "base\n"
        );
        assert!(
            run_git_allowing_failure(directory.path(), &["status", "--porcelain"])
                .stdout
                .is_empty()
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_fast_forward_race_as_completed() {
        let (directory, original_head) = base_repository();
        run_git(directory.path(), &["merge", "--ff-only", "feature"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        let result = recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            &original_head,
            false,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        assert_eq!(result, MergeResult::Success);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_retains_the_lock_when_state_cannot_be_read() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let repository_path = directory.path().join("missing");
        let repository_path = repository_path.to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation_id = start_merge_operation(&registry, &repository_path);

        assert!(recover_merge_termination(
            &registry,
            &operation_id,
            &repository_path,
            "0000000000000000000000000000000000000000",
            false,
            git_ops::TerminationReason::TimedOut,
        )
        .await
        .is_err());
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_some());
    }
}

#[cfg(test)]
mod checkout_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn start_checkout_operation(registry: &OperationRegistry, repository_path: &str) -> String {
        let scope = OperationScope::Repository {
            lock_key: repository_path.to_owned(),
            repository_path: repository_path.to_owned(),
        };
        registry
            .start(
                scope,
                Some("checkout-test".to_owned()),
                GitOperationKind::Checkout,
                CancellationCapability::Available {
                    label: "Cancel checkout".to_owned(),
                },
            )
            .expect("checkout should reserve the repository")
            .id
    }

    #[tokio::test]
    async fn command_recovery_restores_checkout_snapshot_and_releases_the_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Checkout Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "checkout@example.com"],
        );
        std::fs::write(directory.path().join("tracked.txt"), "base\n")
            .expect("tracked fixture should be written");
        run_git(directory.path(), &["add", "tracked.txt"]);
        run_git(directory.path(), &["commit", "-m", "base"]);
        run_git(directory.path(), &["checkout", "-b", "topic"]);
        std::fs::write(directory.path().join("extra.txt"), "topic\n")
            .expect("topic fixture should be written");
        run_git(directory.path(), &["add", "extra.txt"]);
        run_git(directory.path(), &["commit", "-m", "topic"]);
        run_git(directory.path(), &["checkout", "main"]);
        std::fs::write(directory.path().join("extra.txt"), "local\n")
            .expect("local untracked fixture should be written");

        let repository_path = directory.path().to_string_lossy().into_owned();
        let snapshot = git_ops::checkout::get_checkout_snapshot(&repository_path)
            .await
            .expect("checkout snapshot should be captured");
        run_git(directory.path(), &["checkout", "--force", "topic"]);
        // The process may have stopped after changing HEAD but before the command returned. Return
        // to the original ref to exercise the recovery branch where checkout state still needs
        // restoration; the following operation covers the late-completion branch.
        run_git(directory.path(), &["checkout", "--force", "main"]);
        let registry = OperationRegistry::new();
        let operation_id = start_checkout_operation(&registry, &repository_path);

        let result = recover_checkout_termination(
            &registry,
            &operation_id,
            &repository_path,
            &snapshot,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should remain visible to Checkout"
        );
        assert_eq!(
            git_ops::refs::get_symbolic_ref(&repository_path, "HEAD")
                .await
                .expect("HEAD should resolve")
                .as_deref(),
            Some("refs/heads/main")
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("extra.txt"))
                .expect("untracked file should be restored"),
            "local\n"
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
        assert_eq!(
            registry
                .get(&operation_id)
                .expect("checkout record")
                .outcome,
            Some(OperationOutcome::Recovered)
        );

        run_git(directory.path(), &["checkout", "--force", "topic"]);
        let late_operation_id = start_checkout_operation(&registry, &repository_path);
        let late_result = recover_checkout_termination(
            &registry,
            &late_operation_id,
            &repository_path,
            &snapshot,
            git_ops::TerminationReason::Cancelled,
        )
        .await;
        assert!(
            late_result.is_ok(),
            "an advanced HEAD is a completed checkout"
        );
        assert_eq!(
            registry
                .get(&late_operation_id)
                .expect("late checkout record")
                .outcome,
            Some(OperationOutcome::Completed)
        );
        assert_eq!(
            git_ops::refs::get_symbolic_ref(&repository_path, "HEAD")
                .await
                .expect("late HEAD should resolve")
                .as_deref(),
            Some("refs/heads/topic")
        );
    }
}

pub(crate) async fn finish_revert_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    reason: git_ops::TerminationReason,
) -> Result<(), CommandError> {
    // REVERT_HEAD is the only safe abort boundary. Without it, a late stop may have followed a
    // completed revert, and `revert --abort` would incorrectly undo that completed commit.
    let in_progress = git_ops::revert::is_revert_in_progress(repository_path)
        .await
        .map_err(|error| finish_revert_recovery_failure(registry, operation_id, error))?;
    if !in_progress {
        let current_head = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_revert_recovery_failure(registry, operation_id, error))?;
        if current_head != pre_operation_head {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(());
        }

        let (state, kind, verb) = revert_termination_details(reason);
        let message = format!("Revert {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    match git_ops::revert::abort_revert(repository_path).await {
        Ok(()) => {
            let (state, _, verb) = revert_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!(
                "Revert {verb} and recovered"
            )))
        }
        Err(error) => Err(finish_revert_recovery_failure(
            registry,
            operation_id,
            error,
        )),
    }
}

pub(crate) fn revert_termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

pub(crate) fn finish_revert_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

pub(crate) async fn abort_revert_operation(
    registry: &OperationRegistry,
    repository_path: &str,
) -> Result<(), CommandError> {
    // `REVERT_HEAD` can outlive its operation record — a revert started outside rdc, or one that
    // survived an app restart — so the lock holder is not necessarily this revert. Ending someone
    // else's Fetch here would release a lock while its transport is still running.
    let active =
        crate::commands::operations::active_repository_operation(registry, repository_path).await?;
    if let Some(record) = &active {
        if record.operation != GitOperationKind::Revert {
            return Err(CommandError::message(format!(
                "cannot abort a revert while a {:?} operation owns this repository",
                record.operation
            )));
        }
    }
    let operation = active;

    // `git revert --abort` exits 128 when there is nothing to abort, and treating that as a
    // recovery failure would retain the write lock with no way for the user to clear it — the
    // recovery panel's only action is this command, so every retry would fail identically. An
    // already-resolved revert instead ends the operation and releases the lock. Whether the user
    // finished or abandoned it outside rdc is genuinely unknown, so say so rather than guess.
    let in_progress = git_ops::revert::is_revert_in_progress(repository_path)
        .await
        .map_err(|error| {
            if let Some(operation) = &operation {
                return finish_revert_recovery_failure(registry, &operation.id, error);
            }
            CommandError::from(error)
        })?;
    if !in_progress {
        if let Some(operation) = &operation {
            let _ = registry.finish(
                &operation.id,
                OperationState::Cancelled,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Cancelled,
                    message: "The revert was no longer in progress; its repository lock has been \
                              released"
                        .to_owned(),
                    recoverable: true,
                }),
            );
        }
        return Ok(());
    }

    let result = git_ops::revert::abort_revert(repository_path).await;
    match result {
        Ok(()) => {
            if let Some(operation) = operation {
                let _ = registry.finish(
                    &operation.id,
                    OperationState::Cancelled,
                    OperationOutcome::Recovered,
                    None,
                );
            }
            Ok(())
        }
        Err(error) => {
            let command_error = CommandError::from(error);
            if let Some(operation) = operation {
                let _ = registry.finish(
                    &operation.id,
                    OperationState::Failed,
                    OperationOutcome::Unknown,
                    Some(OperationError {
                        kind: OperationErrorKind::RecoveryFailed,
                        message: command_error.message.clone(),
                        recoverable: false,
                    }),
                );
            }
            Err(command_error)
        }
    }
}

pub(crate) async fn start_short_mutation(
    window: &WebviewWindow,
    registry: &OperationRegistry,
    repository_path: &str,
) -> Result<crate::operation::OperationRecord, CommandError> {
    crate::commands::operations::start_repository_operation(
        registry,
        repository_path,
        Some(window.label().to_owned()),
        GitOperationKind::Checkout,
    )
    .await
}

pub(crate) fn finish_short_mutation(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<(), git_ops::GitError>,
) -> Result<(), CommandError> {
    match result {
        Ok(()) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message,
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

#[cfg(test)]
mod revert_termination_tests {
    use super::*;

    #[test]
    fn classifies_revert_cancellation_and_timeout() {
        assert_eq!(
            revert_termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            revert_termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }
}

#[cfg(test)]
mod revert_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_revert_and_releases_the_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("conflict.txt"), "one\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        std::fs::write(directory.path().join("conflict.txt"), "two\n")
            .expect("target file should be written");
        run_git(directory.path(), &["commit", "-qam", "target change"]);
        let target_commit = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("conflict.txt"), "three\n")
            .expect("later file should be written");
        run_git(directory.path(), &["commit", "-qam", "later change"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        let revert = Command::new("git")
            .args(["revert", &target_commit])
            .current_dir(directory.path())
            .output()
            .expect("revert should start");
        assert!(
            !revert.status.success(),
            "revert should stop with a conflict"
        );

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Revert,
                CancellationCapability::Available {
                    label: "Cancel revert".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = finish_revert_termination(
            &registry,
            &operation.id,
            &repository_path,
            &original_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should be reported to the caller"
        );
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("conflict.txt"))
                .expect("worktree file should be readable"),
            "three\n"
        );
        assert_eq!(
            run_git(directory.path(), &["diff", "--cached", "--quiet"]),
            ""
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_late_revert_stop_as_completed() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "one\n")
            .expect("first file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "first"]);
        let pre_operation_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("file.txt"), "two\n")
            .expect("second file should be written");
        run_git(directory.path(), &["commit", "-qam", "second"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::Revert,
                CancellationCapability::Available {
                    label: "Cancel revert".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        finish_revert_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        let finished = registry
            .get(&operation.id)
            .expect("finished record remains");
        assert_eq!(finished.state, OperationState::Completed);
        assert_eq!(finished.outcome, Some(OperationOutcome::Completed));
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    /// A conflicted revert deliberately keeps its lock, so the user-driven abort is the only thing
    /// that can end that operation. Before this was wired up the repository stayed write-locked for
    /// the rest of the session even though Git had been cleaned up.
    #[tokio::test]
    async fn aborting_a_conflicted_revert_releases_the_retained_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("conflict.txt"), "one\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        std::fs::write(directory.path().join("conflict.txt"), "two\n")
            .expect("target file should be written");
        run_git(directory.path(), &["commit", "-qam", "target change"]);
        let target_commit = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("conflict.txt"), "three\n")
            .expect("later file should be written");
        run_git(directory.path(), &["commit", "-qam", "later change"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        let revert = Command::new("git")
            .args(["revert", &target_commit])
            .current_dir(directory.path())
            .output()
            .expect("revert should start");
        assert!(
            !revert.status.success(),
            "revert should stop with a conflict"
        );

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = crate::commands::operations::start_cancellable_repository_operation(
            &registry,
            &repository_path,
            Some("test-window".to_owned()),
            GitOperationKind::Revert,
            "Cancel revert",
        )
        .await
        .expect("operation should reserve the repository");
        registry
            .enter_recovery(&operation.id)
            .expect("a conflicted revert enters recovery holding its lock");
        assert!(
            registry.active_for_scope(&operation.scope).is_some(),
            "recovery retains the repository lock"
        );

        abort_revert_operation(&registry, &repository_path)
            .await
            .expect("aborting a conflicted revert succeeds");

        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        let finished = registry
            .get(&operation.id)
            .expect("the finished record remains queryable");
        assert_eq!(finished.state, OperationState::Cancelled);
        assert_eq!(finished.outcome, Some(OperationOutcome::Recovered));
        assert!(
            registry.active_for_scope(&operation.scope).is_none(),
            "a successful abort releases the repository lock"
        );
    }

    /// `git revert --abort` exits 128 when there is nothing to abort. Recording that as a recovery
    /// failure would retain the write lock, and the recovery panel's only action is this command —
    /// so every retry would fail the same way and the repository would stay locked for good.
    #[tokio::test]
    async fn aborting_an_already_resolved_revert_still_releases_the_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("a.txt"), "one\n").expect("file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = crate::commands::operations::start_cancellable_repository_operation(
            &registry,
            &repository_path,
            Some("test-window".to_owned()),
            GitOperationKind::Revert,
            "Cancel revert",
        )
        .await
        .expect("operation should reserve the repository");
        registry
            .enter_recovery(&operation.id)
            .expect("the operation holds its lock while recovering");

        // No REVERT_HEAD: the user resolved or abandoned the revert outside rdc.
        abort_revert_operation(&registry, &repository_path)
            .await
            .expect("an already-resolved revert is not a recovery failure");

        let finished = registry
            .get(&operation.id)
            .expect("the finished record remains queryable");
        assert_eq!(finished.state, OperationState::Cancelled);
        assert_eq!(finished.outcome, Some(OperationOutcome::Unknown));
        assert!(
            registry.active_for_scope(&operation.scope).is_none(),
            "the repository lock must not survive an abort with nothing to abort"
        );
    }

    /// A revert marker can outlive its record, so the lock holder is not necessarily this revert.
    #[tokio::test]
    async fn aborting_a_revert_refuses_to_end_another_operation() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("a.txt"), "one\n").expect("file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let fetch = crate::commands::operations::start_cancellable_repository_operation(
            &registry,
            &repository_path,
            Some("test-window".to_owned()),
            GitOperationKind::Fetch,
            "Cancel fetch",
        )
        .await
        .expect("the fetch should reserve the repository");

        abort_revert_operation(&registry, &repository_path)
            .await
            .expect_err("a revert abort must not end an unrelated operation");

        let untouched = registry
            .get(&fetch.id)
            .expect("the unrelated operation must still exist");
        assert_eq!(
            untouched.state,
            OperationState::Running,
            "the unrelated operation must not be finished by a revert abort"
        );
        assert_eq!(
            registry
                .active_for_scope(&fetch.scope)
                .map(|record| record.id),
            Some(fetch.id),
            "the unrelated operation must keep its repository lock"
        );
    }
}

pub(crate) async fn finish_cherry_pick_termination(
    registry: &OperationRegistry,
    operation_id: &str,
    repository_path: &str,
    pre_operation_head: &str,
    reason: git_ops::TerminationReason,
) -> Result<CherryPickResult, CommandError> {
    // A stop request can race with Git's final commit. Only abort while the sequencer still exists;
    // otherwise an unconditional `cherry-pick --abort` would undo a pick that already completed.
    let snapshot = git_ops::cherry_pick::get_cherry_pick_snapshot(repository_path)
        .await
        .map_err(|error| finish_cherry_pick_recovery_failure(registry, operation_id, error))?;
    let marker_present = git_ops::cherry_pick::is_cherry_pick_in_progress(repository_path)
        .await
        .map_err(|error| finish_cherry_pick_recovery_failure(registry, operation_id, error))?;
    if snapshot.is_none() && !marker_present {
        let current_head = git_ops::get_head_sha(repository_path)
            .await
            .map_err(|error| finish_cherry_pick_recovery_failure(registry, operation_id, error))?;
        if current_head != pre_operation_head {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            return Ok(CherryPickResult::CompletedWithoutError);
        }

        let (state, kind, verb) = cherry_pick_termination_details(reason);
        let message = format!("Cherry-pick {verb} before it changed the repository");
        let _ = registry.finish(
            operation_id,
            state,
            OperationOutcome::Unchanged,
            Some(OperationError {
                kind,
                message: message.clone(),
                recoverable: true,
            }),
        );
        return Err(CommandError::message(message));
    }

    let recovery = git_ops::cherry_pick::abort_cherry_pick(repository_path).await;
    match recovery {
        Ok(()) => {
            let (state, _, verb) = cherry_pick_termination_details(reason);
            let _ = registry.finish(operation_id, state, OperationOutcome::Recovered, None);
            Err(CommandError::message(format!(
                "Cherry-pick {verb} and recovered"
            )))
        }
        Err(error) => Err(finish_cherry_pick_recovery_failure(
            registry,
            operation_id,
            error,
        )),
    }
}

pub(crate) fn cherry_pick_termination_details(
    reason: git_ops::TerminationReason,
) -> (OperationState, OperationErrorKind, &'static str) {
    match reason {
        git_ops::TerminationReason::Cancelled => (
            OperationState::Cancelled,
            OperationErrorKind::Cancelled,
            "cancelled",
        ),
        git_ops::TerminationReason::TimedOut => (
            OperationState::TimedOut,
            OperationErrorKind::TimedOut,
            "timed out",
        ),
    }
}

pub(crate) fn finish_cherry_pick_recovery_failure(
    registry: &OperationRegistry,
    operation_id: &str,
    error: git_ops::GitError,
) -> CommandError {
    let message = error.to_string();
    let _ = registry.finish(
        operation_id,
        OperationState::Failed,
        OperationOutcome::Unknown,
        Some(OperationError {
            kind: OperationErrorKind::RecoveryFailed,
            message: message.clone(),
            recoverable: false,
        }),
    );
    CommandError::message(message)
}

pub(crate) fn finish_stash_mutation<T>(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<T, git_ops::GitError>,
) -> Result<T, CommandError> {
    match result {
        Ok(value) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(value)
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message,
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

pub(crate) fn finish_cherry_pick_result(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<CherryPickResult, git_ops::GitError>,
) -> Result<CherryPickResult, CommandError> {
    match result {
        Ok(
            result @ (CherryPickResult::ConflictsEncountered
            | CherryPickResult::OutstandingFilesNotStaged),
        ) => {
            let _ = registry.enter_recovery(operation_id);
            Ok(result)
        }
        Ok(result) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message,
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

pub(crate) fn finish_rebase_result(
    registry: &OperationRegistry,
    operation_id: &str,
    result: Result<RebaseResult, git_ops::GitError>,
) -> Result<RebaseResult, CommandError> {
    match result {
        Ok(
            result @ (RebaseResult::ConflictsEncountered | RebaseResult::OutstandingFilesNotStaged),
        ) => {
            let _ = registry.enter_recovery(operation_id);
            Ok(result)
        }
        Ok(result) => {
            let _ = registry.finish(
                operation_id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            );
            Ok(result)
        }
        Err(error) => {
            let message = error.to_string();
            let command_error = CommandError::from(error);
            let _ = registry.finish(
                operation_id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: OperationErrorKind::Failed,
                    message,
                    recoverable: true,
                }),
            );
            Err(command_error)
        }
    }
}

#[cfg(test)]
mod cherry_pick_termination_tests {
    use super::*;

    #[test]
    fn classifies_cherry_pick_cancellation_and_timeout() {
        assert_eq!(
            cherry_pick_termination_details(git_ops::TerminationReason::Cancelled),
            (
                OperationState::Cancelled,
                OperationErrorKind::Cancelled,
                "cancelled"
            )
        );
        assert_eq!(
            cherry_pick_termination_details(git_ops::TerminationReason::TimedOut),
            (
                OperationState::TimedOut,
                OperationErrorKind::TimedOut,
                "timed out"
            )
        );
    }
}

#[cfg(test)]
mod cherry_pick_recovery_tests {
    use super::*;
    use crate::operation::{CancellationCapability, OperationScope};
    use std::path::Path;
    use std::process::Command;

    fn run_git(repository: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repository)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn command_recovery_aborts_a_conflicted_cherry_pick_and_releases_the_lock() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("conflict.txt"), "base\n")
            .expect("base file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "base"]);
        run_git(directory.path(), &["checkout", "-qb", "feature"]);
        std::fs::write(directory.path().join("conflict.txt"), "feature\n")
            .expect("feature file should be written");
        run_git(directory.path(), &["commit", "-qam", "feature change"]);
        let feature_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        run_git(directory.path(), &["checkout", "-q", "main"]);
        std::fs::write(directory.path().join("conflict.txt"), "main\n")
            .expect("main file should be written");
        run_git(directory.path(), &["commit", "-qam", "main change"]);
        let original_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        let cherry_pick = Command::new("git")
            .args(["cherry-pick", &feature_head])
            .current_dir(directory.path())
            .output()
            .expect("cherry-pick should start");
        assert!(
            !cherry_pick.status.success(),
            "cherry-pick should stop with a conflict"
        );

        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::CherryPick,
                CancellationCapability::Available {
                    label: "Cancel cherry-pick".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = finish_cherry_pick_termination(
            &registry,
            &operation.id,
            &repository_path,
            &original_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await;

        assert!(
            result.is_err(),
            "cancellation should be reported to the caller"
        );
        assert_eq!(
            run_git(directory.path(), &["rev-parse", "HEAD"]),
            original_head
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("conflict.txt"))
                .expect("worktree file should be readable"),
            "main\n"
        );
        assert_eq!(
            run_git(directory.path(), &["diff", "--cached", "--quiet"]),
            ""
        );
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_a_late_cherry_pick_stop_as_completed() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "one\n")
            .expect("first file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "first"]);
        let pre_operation_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        std::fs::write(directory.path().join("file.txt"), "two\n")
            .expect("second file should be written");
        run_git(directory.path(), &["commit", "-qam", "second"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();
        let operation = registry
            .start(
                OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                },
                Some("test-window".to_owned()),
                GitOperationKind::CherryPick,
                CancellationCapability::Available {
                    label: "Cancel cherry-pick".to_owned(),
                },
            )
            .expect("operation should reserve the repository");

        let result = finish_cherry_pick_termination(
            &registry,
            &operation.id,
            &repository_path,
            &pre_operation_head,
            git_ops::TerminationReason::Cancelled,
        )
        .await
        .expect("a changed HEAD should win the cancellation race");

        assert_eq!(result, CherryPickResult::CompletedWithoutError);
        assert!(registry
            .active_for_scope(&OperationScope::Repository {
                lock_key: repository_path.clone(),
                repository_path: repository_path.clone(),
            })
            .is_none());
    }

    #[tokio::test]
    async fn command_recovery_treats_late_squash_and_reorder_stops_as_completed() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(directory.path(), &["config", "user.name", "Slice 13 Test"]);
        run_git(
            directory.path(),
            &["config", "user.email", "slice13@example.test"],
        );
        std::fs::write(directory.path().join("file.txt"), "one\n")
            .expect("first file should be written");
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "first"]);
        let repository_path = directory.path().to_string_lossy().into_owned();
        let registry = OperationRegistry::new();

        for (message, label) in [("second", "Cancel squash"), ("third", "Cancel reorder")] {
            let pre_operation_head = run_git(directory.path(), &["rev-parse", "HEAD"]);
            std::fs::write(directory.path().join("file.txt"), format!("{message}\n"))
                .expect("next file should be written");
            run_git(directory.path(), &["commit", "-qam", message]);
            let operation = registry
                .start(
                    OperationScope::Repository {
                        lock_key: repository_path.clone(),
                        repository_path: repository_path.clone(),
                    },
                    Some("test-window".to_owned()),
                    GitOperationKind::Rebase,
                    CancellationCapability::Available {
                        label: label.to_owned(),
                    },
                )
                .expect("operation should reserve the repository");

            let result = crate::commands::git::operation_lifecycle::recover_rebase_termination(
                &registry,
                &operation.id,
                &repository_path,
                &pre_operation_head,
                git_ops::TerminationReason::Cancelled,
            )
            .await
            .expect("a changed HEAD should win the cancellation race");

            assert_eq!(result, RebaseResult::CompletedWithoutError);
            assert!(registry
                .active_for_scope(&OperationScope::Repository {
                    lock_key: repository_path.clone(),
                    repository_path: repository_path.clone(),
                })
                .is_none());
        }
    }
}
