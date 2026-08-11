//! Application-owned operation records and repository-scoped write locks.
//!
//! This registry deliberately owns metadata only. Git process cancellation and recovery are
//! separate futures, so no registry mutex guard is ever held across an await point.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use git_ops::exec::ExecutionControl;
use git_ops::TerminationReason;
use serde::Serialize;

use crate::operation::{
    CancellationCapability, GitOperationKind, OperationError, OperationEvent,
    OperationLifecycleState, OperationOutcome, OperationProgress, OperationRecord, OperationScope,
    OperationState,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OperationRegistryError {
    #[error("repository operation {existing_operation_id} already owns lock {lock_key}")]
    Conflict {
        existing_operation_id: String,
        lock_key: String,
    },
    #[error("operation {operation_id} was not found")]
    NotFound { operation_id: String },
}

#[derive(Debug, Clone, Default)]
pub struct OperationRegistry {
    inner: Arc<Mutex<RegistryInner>>,
    next_id: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Debug, Clone, Copy)]
pub struct WatchdogPolicy {
    pub soft_inactivity: Duration,
    pub hard_inactivity: Duration,
    pub poll_interval: Duration,
}

impl Default for WatchdogPolicy {
    fn default() -> Self {
        Self {
            soft_inactivity: Duration::from_secs(30),
            hard_inactivity: Duration::from_secs(120),
            poll_interval: Duration::from_millis(250),
        }
    }
}

#[derive(Debug, Default)]
struct RegistryInner {
    locks: HashMap<String, String>,
    records: HashMap<String, OperationRecord>,
    latest_events: HashMap<String, OperationEvent>,
    controls: HashMap<String, ExecutionControl>,
}

impl OperationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserves the scope and creates the initial running record.
    pub fn start(
        &self,
        scope: OperationScope,
        owner_window: Option<String>,
        operation: GitOperationKind,
        cancellation: CancellationCapability,
    ) -> Result<OperationRecord, OperationRegistryError> {
        let lock_key = scope_lock_key(&scope);
        let mut inner = self.lock_inner();
        if let Some(existing_operation_id) = inner.locks.get(&lock_key) {
            return Err(OperationRegistryError::Conflict {
                existing_operation_id: existing_operation_id.clone(),
                lock_key,
            });
        }

        let id = format!(
            "operation-{}",
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let record = OperationRecord {
            id: id.clone(),
            scope,
            owner_window,
            operation,
            state: OperationState::Running,
            cancellation,
            progress: None,
            last_activity_at: now_millis(),
            outcome: None,
            error: None,
        };
        inner.locks.insert(lock_key, id.clone());
        inner.controls.insert(id.clone(), ExecutionControl::new());
        inner.records.insert(id, record.clone());
        Ok(record)
    }

    pub fn publish_progress(
        &self,
        operation_id: &str,
        progress: OperationProgress,
    ) -> Result<OperationRecord, OperationRegistryError> {
        self.update(operation_id, |record, inner| {
            record.progress = Some(progress.clone());
            record.last_activity_at = now_millis();
            inner.latest_events.insert(
                operation_id.to_owned(),
                OperationEvent::Progress {
                    operation_id: operation_id.to_owned(),
                    progress,
                },
            );
        })
    }

    pub fn mark_taking_longer(
        &self,
        operation_id: &str,
    ) -> Result<OperationRecord, OperationRegistryError> {
        self.update(operation_id, |record, inner| {
            if record.state != OperationState::Running {
                return;
            }
            record.state = OperationState::TakingLongerThanExpected;
            inner.latest_events.insert(
                operation_id.to_owned(),
                OperationEvent::State {
                    operation_id: operation_id.to_owned(),
                    state: OperationLifecycleState::TakingLongerThanExpected,
                },
            );
        })
    }

    pub fn request_cancellation(
        &self,
        operation_id: &str,
    ) -> Result<OperationRecord, OperationRegistryError> {
        let control = self.control(operation_id)?;
        let record = self.update(operation_id, |record, inner| {
            record.cancellation = CancellationCapability::Requested;
            record.state = OperationState::Cancelling;
            record.last_activity_at = now_millis();
            inner.latest_events.insert(
                operation_id.to_owned(),
                OperationEvent::State {
                    operation_id: operation_id.to_owned(),
                    state: OperationLifecycleState::Cancelling,
                },
            );
        })?;
        control.cancel(TerminationReason::Cancelled);
        Ok(record)
    }

    pub fn request_timeout(
        &self,
        operation_id: &str,
    ) -> Result<OperationRecord, OperationRegistryError> {
        let control = self.control(operation_id)?;
        let record = self.update(operation_id, |record, inner| {
            record.state = OperationState::Cancelling;
            record.last_activity_at = now_millis();
            inner.latest_events.insert(
                operation_id.to_owned(),
                OperationEvent::State {
                    operation_id: operation_id.to_owned(),
                    state: OperationLifecycleState::Cancelling,
                },
            );
        })?;
        control.cancel(TerminationReason::TimedOut);
        Ok(record)
    }

    pub fn enter_recovery(
        &self,
        operation_id: &str,
    ) -> Result<OperationRecord, OperationRegistryError> {
        self.update(operation_id, |record, inner| {
            record.state = OperationState::Recovering;
            record.last_activity_at = now_millis();
            inner.latest_events.insert(
                operation_id.to_owned(),
                OperationEvent::State {
                    operation_id: operation_id.to_owned(),
                    state: OperationLifecycleState::Recovering,
                },
            );
        })
    }

    /// Finishes an operation. Recovery failures deliberately retain their scope lock.
    pub fn finish(
        &self,
        operation_id: &str,
        state: OperationState,
        outcome: OperationOutcome,
        error: Option<OperationError>,
    ) -> Result<OperationRecord, OperationRegistryError> {
        let mut inner = self.lock_inner();
        let mut record = inner.records.get(operation_id).cloned().ok_or_else(|| {
            OperationRegistryError::NotFound {
                operation_id: operation_id.to_owned(),
            }
        })?;
        record.state = state.clone();
        record.outcome = Some(outcome.clone());
        record.error = error.clone();
        record.last_activity_at = now_millis();

        let retains_lock = error.as_ref().is_some_and(|error| {
            matches!(
                error.kind,
                crate::operation::OperationErrorKind::RecoveryFailed
            )
        });
        if !retains_lock {
            inner.locks.remove(&scope_lock_key(&record.scope));
            inner.controls.remove(operation_id);
        }
        inner.latest_events.insert(
            operation_id.to_owned(),
            OperationEvent::Finished {
                operation_id: operation_id.to_owned(),
                state,
                outcome,
                error,
            },
        );
        inner
            .records
            .insert(operation_id.to_owned(), record.clone());
        Ok(record)
    }

    pub fn active_for_scope(&self, scope: &OperationScope) -> Option<OperationRecord> {
        let inner = self.lock_inner();
        inner
            .locks
            .get(&scope_lock_key(scope))
            .and_then(|id| inner.records.get(id))
            .cloned()
    }

    pub fn get(&self, operation_id: &str) -> Option<OperationRecord> {
        self.lock_inner().records.get(operation_id).cloned()
    }

    pub fn list(&self) -> Vec<OperationRecord> {
        self.lock_inner().records.values().cloned().collect()
    }

    pub fn latest_event(&self, operation_id: &str) -> Option<OperationEvent> {
        self.lock_inner().latest_events.get(operation_id).cloned()
    }

    /// Returns the process control owned by an operation. The clone is the control handle used by
    /// the Git future; no registry lock is held while the process runs.
    pub fn control(&self, operation_id: &str) -> Result<ExecutionControl, OperationRegistryError> {
        self.lock_inner()
            .controls
            .get(operation_id)
            .cloned()
            .ok_or_else(|| OperationRegistryError::NotFound {
                operation_id: operation_id.to_owned(),
            })
    }

    /// Losing a window changes presentation ownership only; it never cancels the operation.
    pub fn clear_owner_window(&self, window_label: &str) {
        let mut inner = self.lock_inner();
        for record in inner.records.values_mut() {
            if record.owner_window.as_deref() == Some(window_label) {
                record.owner_window = None;
            }
        }
    }

    /// Starts a native inactivity watchdog. It only requests termination; the process future is
    /// responsible for reaping the tree and publishing the final timeout/recovery result.
    pub fn spawn_watchdog(
        &self,
        operation_id: impl Into<String>,
        policy: WatchdogPolicy,
    ) -> tokio::task::JoinHandle<()> {
        let registry = self.clone();
        let operation_id = operation_id.into();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(policy.poll_interval).await;
                let Some(record) = registry.get(&operation_id) else {
                    break;
                };
                if !matches!(
                    record.state,
                    OperationState::Running | OperationState::TakingLongerThanExpected
                ) {
                    break;
                }
                let inactive_for =
                    Duration::from_millis(now_millis().saturating_sub(record.last_activity_at));
                if inactive_for >= policy.hard_inactivity {
                    let _ = registry.request_timeout(&operation_id);
                    break;
                }
                if inactive_for >= policy.soft_inactivity {
                    let _ = registry.mark_taking_longer(&operation_id);
                }
            }
        })
    }

    fn update(
        &self,
        operation_id: &str,
        update: impl FnOnce(&mut OperationRecord, &mut RegistryInner),
    ) -> Result<OperationRecord, OperationRegistryError> {
        let mut inner = self.lock_inner();
        let mut record = inner.records.get(operation_id).cloned().ok_or_else(|| {
            OperationRegistryError::NotFound {
                operation_id: operation_id.to_owned(),
            }
        })?;
        update(&mut record, &mut inner);
        inner
            .records
            .insert(operation_id.to_owned(), record.clone());
        Ok(record)
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn scope_lock_key(scope: &OperationScope) -> String {
    match scope {
        OperationScope::Repository { lock_key, .. }
        | OperationScope::CloneDestination { lock_key, .. } => lock_key.clone(),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use git_ops::exec::git_streaming_controlled;

    fn repository_scope(key: &str) -> OperationScope {
        OperationScope::Repository {
            lock_key: key.to_owned(),
            repository_path: format!("/{key}"),
        }
    }

    fn registry() -> OperationRegistry {
        OperationRegistry::new()
    }

    #[test]
    fn rejects_a_second_operation_for_the_same_scope() {
        let registry = registry();
        let first = registry
            .start(
                repository_scope("repo-a"),
                Some("window-a".to_owned()),
                GitOperationKind::Fetch,
                CancellationCapability::Available {
                    label: "Cancel fetch".to_owned(),
                },
            )
            .expect("first operation should reserve the scope");
        let error = registry
            .start(
                repository_scope("repo-a"),
                Some("window-b".to_owned()),
                GitOperationKind::Commit,
                CancellationCapability::Unavailable,
            )
            .expect_err("same scope must reject a second operation");

        assert_eq!(
            error,
            OperationRegistryError::Conflict {
                existing_operation_id: first.id,
                lock_key: "repo-a".to_owned(),
            }
        );
    }

    #[test]
    fn accepts_concurrent_operations_for_different_scopes() {
        let registry = registry();
        let first = registry
            .start(
                repository_scope("repo-a"),
                None,
                GitOperationKind::Fetch,
                CancellationCapability::Unavailable,
            )
            .expect("first scope should reserve");
        let second = registry
            .start(
                repository_scope("repo-b"),
                None,
                GitOperationKind::Fetch,
                CancellationCapability::Unavailable,
            )
            .expect("different scope should reserve");

        assert_ne!(first.id, second.id);
        assert_eq!(registry.list().len(), 2);
    }

    #[test]
    fn clone_destinations_have_independent_locks() {
        let registry = registry();
        let first = OperationScope::CloneDestination {
            lock_key: "/tmp/clone-a".to_owned(),
            destination_path: "/tmp/clone-a".to_owned(),
        };
        let second = OperationScope::CloneDestination {
            lock_key: "/tmp/clone-b".to_owned(),
            destination_path: "/tmp/clone-b".to_owned(),
        };

        registry
            .start(
                first,
                None,
                GitOperationKind::Clone,
                CancellationCapability::Unavailable,
            )
            .expect("first destination should reserve");
        registry
            .start(
                second,
                None,
                GitOperationKind::Clone,
                CancellationCapability::Unavailable,
            )
            .expect("second destination should reserve");
    }

    #[test]
    fn clearing_an_owner_does_not_finish_the_operation() {
        let registry = registry();
        let record = registry
            .start(
                repository_scope("repo-a"),
                Some("window-a".to_owned()),
                GitOperationKind::Fetch,
                CancellationCapability::Unavailable,
            )
            .expect("operation should reserve");

        registry.clear_owner_window("window-a");

        let retained = registry.get(&record.id).expect("record should remain");
        assert_eq!(retained.state, OperationState::Running);
        assert_eq!(retained.owner_window, None);
        assert!(registry
            .active_for_scope(&repository_scope("repo-a"))
            .is_some());
    }

    #[test]
    fn cancellation_request_signals_the_operation_process_control() {
        let registry = registry();
        let record = registry
            .start(
                repository_scope("repo-a"),
                None,
                GitOperationKind::Fetch,
                CancellationCapability::Available {
                    label: "Cancel fetch".to_owned(),
                },
            )
            .expect("operation should reserve");
        let control = registry
            .control(&record.id)
            .expect("running operation should expose its control");

        registry
            .request_cancellation(&record.id)
            .expect("cancellation should update the operation");

        assert!(control.is_cancelled());
        assert_eq!(
            registry.get(&record.id).expect("record remains").state,
            OperationState::Cancelling
        );
    }

    #[tokio::test]
    async fn operation_id_cancellation_reaps_the_controlled_git_process() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(directory.path())
            .status()
            .expect("git init should start");
        let registry = registry();
        let record = registry
            .start(
                repository_scope("repo-process"),
                Some("window-a".to_owned()),
                GitOperationKind::Fetch,
                CancellationCapability::Available {
                    label: "Cancel fetch".to_owned(),
                },
            )
            .expect("operation should reserve");
        let control = registry
            .control(&record.id)
            .expect("operation should expose its control");
        let path = directory.path().to_owned();
        let task = tokio::spawn(async move {
            git_streaming_controlled(
                &["-c", "alias.wait=!sleep 30", "wait"],
                path,
                "registry-cancellable-test",
                git_ops::exec::GitOptions::default(),
                Some(control),
                |_| {},
                |_| {},
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        registry
            .request_cancellation(&record.id)
            .expect("operation-id cancellation should signal Git");
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("operation-id cancellation should reap Git")
            .expect("Git task should not panic");

        assert!(matches!(
            result,
            Err(git_ops::GitError::OperationTerminated { .. })
        ));
        assert!(registry
            .active_for_scope(&repository_scope("repo-process"))
            .is_some());
        registry
            .finish(
                &record.id,
                OperationState::Cancelled,
                OperationOutcome::Unchanged,
                Some(OperationError {
                    kind: crate::operation::OperationErrorKind::Cancelled,
                    message: "cancelled by user".to_owned(),
                    recoverable: false,
                }),
            )
            .expect("terminal cancellation should finish the record");
        assert!(registry
            .active_for_scope(&repository_scope("repo-process"))
            .is_none());
    }

    #[tokio::test]
    async fn watchdog_warns_then_requests_timeout_without_releasing_the_lock() {
        let registry = registry();
        let record = registry
            .start(
                repository_scope("repo-watchdog"),
                None,
                GitOperationKind::Fetch,
                CancellationCapability::Available {
                    label: "Cancel fetch".to_owned(),
                },
            )
            .expect("operation should reserve");
        let watchdog = registry.spawn_watchdog(
            record.id.clone(),
            WatchdogPolicy {
                soft_inactivity: Duration::from_millis(10),
                hard_inactivity: Duration::from_millis(35),
                poll_interval: Duration::from_millis(5),
            },
        );

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            registry.get(&record.id).expect("record remains").state,
            OperationState::TakingLongerThanExpected
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
        watchdog.await.expect("watchdog should finish");

        let timed_out = registry.get(&record.id).expect("record remains");
        assert_eq!(timed_out.state, OperationState::Cancelling);
        assert!(registry
            .active_for_scope(&repository_scope("repo-watchdog"))
            .is_some());
        assert!(registry
            .control(&record.id)
            .expect("control remains until finish")
            .is_cancelled());
    }

    #[test]
    fn successful_finish_releases_but_recovery_failure_retains_the_lock() {
        let registry = registry();
        let first = registry
            .start(
                repository_scope("repo-a"),
                None,
                GitOperationKind::Fetch,
                CancellationCapability::Unavailable,
            )
            .expect("operation should reserve");
        registry
            .finish(
                &first.id,
                OperationState::Completed,
                OperationOutcome::Completed,
                None,
            )
            .expect("successful operation should finish");
        assert!(registry
            .active_for_scope(&repository_scope("repo-a"))
            .is_none());

        let second = registry
            .start(
                repository_scope("repo-a"),
                None,
                GitOperationKind::Fetch,
                CancellationCapability::Unavailable,
            )
            .expect("released scope should be reusable");
        registry
            .finish(
                &second.id,
                OperationState::Failed,
                OperationOutcome::Unknown,
                Some(OperationError {
                    kind: crate::operation::OperationErrorKind::RecoveryFailed,
                    message: "recovery required".to_owned(),
                    recoverable: true,
                }),
            )
            .expect("recovery failure should be recorded");

        let blocked = registry
            .active_for_scope(&repository_scope("repo-a"))
            .expect("recovery failure must retain the lock");
        assert_eq!(blocked.state, OperationState::Failed);
    }
}
