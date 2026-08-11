//! The app's half of hook interception: where the helper binaries are, and who to tell.
//!
//! `git-ops` owns everything about *running* a hook (see `git_ops::hooks`). What it deliberately does not
//! own is the application's layout or its UI, so this supplies both: it resolves the two helper binaries,
//! turns hook progress into something that can cross a Tauri Channel, and keeps the handles that let the
//! user stop a hook that is taking too long.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use git_ops::hooks::runner::{
    FailureDecision, HookAbort, HookProgress, HookProgressUpdate, HookStatus,
};
use git_ops::hooks::with_env::HookSupport;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use crate::operation_registry::OperationWaitReason;

/// The hooks currently running, so a cancel from the UI can reach one.
///
/// Cheap to clone; clones share the same table. Entries are removed as each hook ends, so it holds only
/// what is actually abortable — at most one entry per hook of an operation.
#[derive(Debug, Clone, Default)]
pub struct HookRegistry {
    running: Arc<Mutex<HashMap<u64, Running>>>,
    pending_failures: Arc<Mutex<HashMap<u64, oneshot::Sender<FailureDecision>>>>,
    next_id: Arc<AtomicU64>,
}

/// A hook that has started and not yet ended.
#[derive(Debug)]
struct Running {
    /// Kept so the end of a hook can find its id: the runner reports an ending hook by name, and within
    /// one operation a name identifies one run.
    hook: String,
    abort: HookAbort,
}

impl HookRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a running hook and returns its id.
    fn record(&self, hook: &str, abort: HookAbort) -> u64 {
        // Relaxed is enough: the value only has to be unique, and nothing orders against it.
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock_running().insert(
            id,
            Running {
                hook: hook.to_owned(),
                abort,
            },
        );
        id
    }

    /// Forgets a hook that has ended, returning the id it was recorded under.
    ///
    /// Found by name because that is all an ending hook reports. Within one operation a hook runs once, so
    /// the name identifies the run; if two operations somehow overlap on the same hook, the earlier entry
    /// is retired first, which is the order they started in.
    fn finish(&self, hook: &str) -> Option<u64> {
        let mut running = self.lock_running();
        let id = running
            .iter()
            .filter(|(_, entry)| entry.hook == hook)
            .map(|(id, _)| *id)
            .min()?;
        running.remove(&id);
        Some(id)
    }

    /// Stops a running hook. `false` when it had already ended, which is not an error — the user simply
    /// cancelled a moment too late.
    pub fn abort(&self, id: u64) -> bool {
        match self.lock_running().remove(&id) {
            Some(entry) => {
                entry.abort.abort();
                true
            }
            None => false,
        }
    }

    fn ask_about_failure(&self) -> (u64, oneshot::Receiver<FailureDecision>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.lock_pending_failures().insert(id, sender);
        (id, receiver)
    }

    pub fn resolve_failure(&self, id: u64, resolution: HookFailureResolution) -> bool {
        let decision = match resolution {
            HookFailureResolution::Abort => FailureDecision::Fail,
            HookFailureResolution::Ignore => FailureDecision::Ignore,
        };

        self.lock_pending_failures()
            .remove(&id)
            .is_some_and(|sender| sender.send(decision).is_ok())
    }

    fn cancel_failure(&self, id: u64) {
        self.lock_pending_failures().remove(&id);
    }

    fn lock_running(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Running>> {
        // A poisoned mutex would mean a panic while holding it, which these small critical sections cannot
        // do. Recovering keeps a panic elsewhere from disabling cancellation.
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_pending_failures(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<FailureDecision>>> {
        self.pending_failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookFailureResolution {
    Abort,
    Ignore,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookFailurePrompt {
    pub id: u64,
    pub hook: String,
    pub terminal_output: String,
}

/// Optional watchdog boundary for a user decision opened by a hook.
#[derive(Clone)]
pub struct OperationWaitHooks {
    pub begin: Arc<dyn Fn(OperationWaitReason) + Send + Sync>,
    pub end: Arc<dyn Fn() + Send + Sync>,
}

/// Where the helper binaries live.
///
/// Beside the running executable, which is where the dev build puts them (`target/debug`) and where the
/// bundle must put them. **Packaging depends on this** — the two binaries have to ship next to the app
/// binary — and that is recorded as Phase 9 work rather than assumed.
pub fn helper_binary(name: &str) -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the running executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "the running executable has no parent directory".to_owned())?;

    let path = directory.join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "the {name} helper binary is missing from {}. It must ship beside the app binary.",
            directory.display()
        ))
    }
}

/// Builds the hook machinery for one operation.
///
/// `None` when the caller didn't ask to intercept, which is the default: whether to intercept is a user
/// setting, and until the preferences UI exists (Phase 7) nothing turns it on.
///
pub fn support_for(
    intercept: bool,
    registry: &HookRegistry,
    on_progress: Channel<HookProgressUpdate>,
    on_failure: Channel<HookFailurePrompt>,
) -> Result<Option<HookSupport>, String> {
    support_for_with_wait(intercept, registry, on_progress, on_failure, None)
}

/// Builds hook support with an optional operation watchdog boundary around Abort/Ignore.
pub fn support_for_with_wait(
    intercept: bool,
    registry: &HookRegistry,
    on_progress: Channel<HookProgressUpdate>,
    on_failure: Channel<HookFailurePrompt>,
    wait_hooks: Option<OperationWaitHooks>,
) -> Result<Option<HookSupport>, String> {
    if !intercept {
        return Ok(None);
    }

    let progress_registry = registry.clone();
    let failure_registry = registry.clone();
    let failure_wait_hooks = wait_hooks;

    Ok(Some(
        HookSupport::new(
            helper_binary("rdc-hook-proxy")?,
            helper_binary("rdc-printenvz")?,
        )
        .with_progress(move |progress: HookProgress| {
            let id = match progress.status {
                HookStatus::Started => {
                    progress_registry.record(&progress.hook, progress.abort.clone())
                }
                // Retired here rather than left to accumulate: an ended hook cannot be aborted, and the
                // table should hold only what can be.
                HookStatus::Finished | HookStatus::Failed => {
                    progress_registry.finish(&progress.hook).unwrap_or_default()
                }
            };

            // A closed webview drops updates rather than stopping the hook, which must not be left
            // half-run: the same rule the progress Channels already follow.
            let _ = on_progress.send(HookProgressUpdate {
                id,
                hook: progress.hook,
                status: progress.status,
            });
        })
        .with_failure_prompt(move |hook, output| {
            let registry = failure_registry.clone();
            let on_failure = on_failure.clone();
            let wait_hooks = failure_wait_hooks.clone();
            async move {
                let (id, resolution) = registry.ask_about_failure();
                if let Some(wait_hooks) = &wait_hooks {
                    (wait_hooks.begin)(OperationWaitReason::HookDecision);
                }
                if on_failure
                    .send(HookFailurePrompt {
                        id,
                        hook,
                        terminal_output: String::from_utf8_lossy(&output).into_owned(),
                    })
                    .is_err()
                {
                    registry.cancel_failure(id);
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.end)();
                    }
                    return FailureDecision::Fail;
                }

                let decision = resolution.await.unwrap_or(FailureDecision::Fail);
                if let Some(wait_hooks) = &wait_hooks {
                    (wait_hooks.end)();
                }
                decision
            }
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolves_a_pending_failure_once() {
        let registry = HookRegistry::new();
        let (id, receiver) = registry.ask_about_failure();

        assert!(registry.resolve_failure(id, HookFailureResolution::Ignore));
        assert_eq!(
            receiver.await.expect("the decision should arrive"),
            FailureDecision::Ignore
        );
        assert!(
            !registry.resolve_failure(id, HookFailureResolution::Abort),
            "a stale UI response must be harmless"
        );
    }

    #[tokio::test]
    async fn cancelling_a_prompt_fails_closed() {
        let registry = HookRegistry::new();
        let (id, receiver) = registry.ask_about_failure();

        registry.cancel_failure(id);

        assert!(
            receiver.await.is_err(),
            "dropping the response sender makes the caller use its abort fallback"
        );
    }
}
