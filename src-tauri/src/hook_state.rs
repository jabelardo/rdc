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

use git_ops::hooks::runner::{HookAbort, HookProgress, HookProgressUpdate, HookStatus};
use git_ops::hooks::with_env::HookSupport;
use tauri::ipc::Channel;

/// The hooks currently running, so a cancel from the UI can reach one.
///
/// Cheap to clone; clones share the same table. Entries are removed as each hook ends, so it holds only
/// what is actually abortable — at most one entry per hook of an operation.
#[derive(Debug, Clone, Default)]
pub struct HookRegistry {
    running: Arc<Mutex<HashMap<u64, Running>>>,
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
        self.lock().insert(
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
        let mut running = self.lock();
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
        match self.lock().remove(&id) {
            Some(entry) => {
                entry.abort.abort();
                true
            }
            None => false,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Running>> {
        // A poisoned mutex would mean a panic while holding it, which these small critical sections cannot
        // do. Recovering keeps a panic elsewhere from disabling cancellation.
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
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
/// # The failure prompt is deliberately not wired
///
/// A failing hook can be *ignored* by the user, which needs a question answered by the UI. That seam is
/// [`HookSupport::with_failure_prompt`], and it is left at its conservative default here: a failure is a
/// failure, so git aborts the operation exactly as it would without rdc involved. The same choice as the
/// trampoline's `Decline` for credentials — declining is correct behaviour, not a stub — and Phase 7
/// supplies the dialog by filling in that seam rather than by changing anything here.
pub fn support_for(
    intercept: bool,
    registry: &HookRegistry,
    on_progress: Channel<HookProgressUpdate>,
) -> Result<Option<HookSupport>, String> {
    if !intercept {
        return Ok(None);
    }

    let registry = registry.clone();

    Ok(Some(
        HookSupport::new(
            helper_binary("rdc-hook-proxy")?,
            helper_binary("rdc-printenvz")?,
        )
        .with_progress(move |progress: HookProgress| {
            let id = match progress.status {
                HookStatus::Started => registry.record(&progress.hook, progress.abort.clone()),
                // Retired here rather than left to accumulate: an ended hook cannot be aborted, and the
                // table should hold only what can be.
                HookStatus::Finished | HookStatus::Failed => {
                    registry.finish(&progress.hook).unwrap_or_default()
                }
            };

            // A closed webview drops updates rather than stopping the hook, which must not be left
            // half-run: the same rule the progress Channels already follow.
            let _ = on_progress.send(HookProgressUpdate {
                id,
                hook: progress.hook,
                status: progress.status,
            });
        }),
    ))
}
