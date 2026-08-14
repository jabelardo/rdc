//! Debug-build-only QA driver (Phase 8b visual-matrix automation).
//!
//! The Phase 8b visual matrix must be reviewed on real Wayland, but the dev
//! environment cannot inject keyboard/mouse input into the host session from
//! inside the toolbox container (see MIGRATION_MAP.md §8). Input injection is
//! therefore replaced by a deterministic state driver: the `qa-linux-matrix.sh`
//! script writes a small JSON "driver file", and this module watches it and
//! applies the requested state to the running app.
//!
//! State that the native process owns (window size) is applied here directly;
//! the rest (theme, view, sidebar, repository) is delivered to the webview as a
//! `qa-drive` event that a debug-only frontend hook consumes, because that state
//! lives in React stores.
//!
//! This module is compiled **only for debug builds** (`#[cfg(debug_assertions)]`,
//! i.e. `tauri dev` and `cargo build` with the default dev profile). It never
//! exists in a release binary: the module isn't referenced, the watcher thread
//! never starts, and no IPC surface is added beyond the `qa-drive` event, which
//! only a debug-only consumer listens for.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// The whole driver state, debug-only. Optional fields leave the corresponding
/// concern untouched when absent.
#[derive(Debug, Default, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct QaState {
    width: Option<f64>,
    height: Option<f64>,
    theme: Option<String>,
    view: Option<String>,
    sidebar_collapsed: Option<bool>,
    repository: Option<String>,
    history_operation: Option<QaHistoryOperation>,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct QaHistoryOperation {
    kind: Option<String>,
    commit: Option<String>,
    summary: Option<String>,
    parent_count: Option<usize>,
}

/// The event name delivered to the webview. Keep in sync with the frontend hook.
pub const QA_DRIVE_EVENT: &str = "qa-drive";

/// How often the driver file is polled. This is a doc/QA affordance, so a
/// short fixed period is fine; state changes are idempotent.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

fn driver_path_from_env() -> PathBuf {
    std::env::var_os("RDC_QA_DRIVER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/rdc-qa-driver.json"))
}

/// Start the QA driver watcher. Debug builds only; call from `setup`.
///
/// Reads the driver file each poll and applies the state **once** when the
/// content changes (geometry natively, the rest as an event). Geometry is
/// deliberately *not* re-asserted on a timer: re-running `set_size` every poll
/// would fight a human resizing the window by hand during a QA session. The
/// driver is a one-shot state setter, not a geometry lock.
pub fn spawn(app: AppHandle) {
    let path = driver_path_from_env();
    let path = Arc::new(path);
    let last_state = Arc::new(std::sync::Mutex::new(None::<QaState>));

    thread::spawn(move || loop {
        let contents = read_driver_file(&path);
        match contents {
            Some(current) => {
                let mut last = last_state.lock().unwrap();
                let parsed = serde_json::from_str::<QaState>(&current).ok();
                let changed = last.is_none() || last.as_ref() != parsed.as_ref();
                if changed {
                    // Remember the re-canonicalized text so byte-identical
                    // rewrites don't re-fire, and apply the full state.
                    *last = parsed.clone();
                    if let Some(state) = &parsed {
                        if let Err(error) = apply_full(&app, state) {
                            log::warn!("qa-driver: failed to apply state: {error}");
                        }
                    }
                }
            }
            None => {
                // File absent: reset our remembered state so that a later
                // write is treated as a change even if it matches an old one.
                let mut last = last_state.lock().unwrap();
                *last = None;
            }
        }
        thread::sleep(POLL_INTERVAL);
    });
}

fn read_driver_file(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|mut s| {
        // Normalise trailing newline so a byte-identical rewrite whose only
        // difference is a trimmable edge does not re-trigger.
        while s.ends_with('\n') || s.ends_with('\r') {
            s.pop();
        }
        s
    })
}

fn apply_full(app: &AppHandle, state: &QaState) -> Result<(), String> {
    apply_geometry(app, state)?;

    // Deliver the renderer-owned portion via a well-typed payload.
    let payload = serde_json::json!({
        "theme": state.theme,
        "view": state.view,
        "sidebarCollapsed": state.sidebar_collapsed,
        "repository": state.repository,
        "historyOperation": state.history_operation,
    });
    app.emit(QA_DRIVE_EVENT, payload)
        .map_err(|e| format!("emit qa-drive: {e}"))
}

/// Resize the main window to the requested logical size, unmaximizing first
/// when needed. Runs once per file change, not on a timer.
fn apply_geometry(app: &AppHandle, state: &QaState) -> Result<(), String> {
    if state.width.is_none() && state.height.is_none() {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    // A maximized window ignores set_size (the compositor owns its geometry),
    // and the window-state plugin restores the saved maximized flag on every
    // launch. Unmaximize before resizing so the matrix's exact viewports
    // actually take effect.
    if window.is_maximized().unwrap_or(false) {
        window
            .unmaximize()
            .map_err(|e| format!("unmaximize: {e}"))?;
        // unmaximize is async — the Wayland compositor processes the request
        // on its own frame clock. A set_size that arrives before the
        // unmaximize transition finishes is silently dropped by GNOME/Mutter,
        // so we wait for one frame (~16 ms at 60 Hz) plus margin.
        thread::sleep(Duration::from_millis(64));
    }

    // The script always provides both width and height, so the outer_size
    // fallback is only needed when a dimension is intentionally omitted.
    // Reading outer_size on Wayland can return stale physical values or fail,
    // so we skip it entirely when both are present.
    let (width, height) = match (state.width, state.height) {
        (Some(w), Some(h)) => (w, h),
        (w, h) => {
            let current = window
                .outer_size()
                .map_err(|e| format!("read outer size: {e}"))?;
            let scale = window.scale_factor().unwrap_or(1.0);
            let logical = current.to_logical::<f64>(scale);
            (w.unwrap_or(logical.width), h.unwrap_or(logical.height))
        }
    };

    let size = tauri::LogicalSize::new(width, height);
    window.set_size(size).map_err(|e| format!("set size: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_default_to_none() {
        let state: QaState = serde_json::from_str(r#"{"width":1100,"height":720}"#).unwrap();
        assert_eq!(state.width, Some(1100.0));
        assert_eq!(state.height, Some(720.0));
        assert_eq!(state.theme, None);
        assert_eq!(state.view, None);
        assert_eq!(state.sidebar_collapsed, None);
        assert_eq!(state.repository, None);
    }

    #[test]
    fn camel_case_fields_deserialize() {
        let state: QaState =
            serde_json::from_str(r#"{"sidebarCollapsed":true,"repository":"/tmp/x"}"#).unwrap();
        assert_eq!(state.sidebar_collapsed, Some(true));
        assert_eq!(state.repository.as_deref(), Some("/tmp/x"));
    }

    #[test]
    fn empty_object_is_valid() {
        let state: QaState = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(state.width, None);
    }
}
