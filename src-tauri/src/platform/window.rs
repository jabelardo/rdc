use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;

use super::window_model::WindowStartupAction;

const DEFAULT_ZOOM_FACTOR: f64 = 1.0;

/// Zoom is a webview property that Tauri can set but cannot read. Keep the
/// last successful value per webview so the frontend retains Electron's getter.
/// Persisted to `<config_dir>/zoom-state.json` so the value survives restarts.
pub struct WindowZoomState {
    factors: Mutex<HashMap<String, f64>>,
    config_dir: Mutex<Option<PathBuf>>,
}

#[derive(Default)]
struct WindowRoutingInner {
    selected_paths: HashMap<String, String>,
    startup_actions: HashMap<String, WindowStartupAction>,
}

/// Owns per-window routing metadata and one-shot renderer startup actions.
#[derive(Default)]
pub struct WindowRoutingState {
    next_window_number: AtomicU64,
    inner: Mutex<WindowRoutingInner>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchStats {
    pub main_ready_time: f64,
    pub load_time: f64,
    pub renderer_ready_time: f64,
}

#[derive(Default)]
struct LoadTimes {
    started: Option<Instant>,
    finished: Option<Instant>,
}

#[derive(Default)]
struct LaunchTimingInner {
    main_ready: Option<Duration>,
    loads: HashMap<String, LoadTimes>,
    completed: HashSet<String>,
}

/// Owns native-process launch measurements until the renderer completes them.
pub struct LaunchTimingState {
    launch: Instant,
    inner: Mutex<LaunchTimingInner>,
}

impl LaunchTimingState {
    pub fn new() -> Self {
        Self::new_at(Instant::now())
    }

    fn new_at(launch: Instant) -> Self {
        Self {
            launch,
            inner: Mutex::new(LaunchTimingInner::default()),
        }
    }

    pub fn mark_main_ready(&self) {
        self.mark_main_ready_at(Instant::now());
    }

    fn mark_main_ready_at(&self, ready: Instant) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .main_ready = ready.checked_duration_since(self.launch);
    }

    pub fn mark_load_started(&self, label: &str) {
        self.mark_load_started_at(label, Instant::now());
    }

    fn mark_load_started_at(&self, label: &str, started: Instant) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .loads
            .entry(label.to_owned())
            .or_default()
            .started = Some(started);
    }

    pub fn mark_load_finished(&self, label: &str) {
        self.mark_load_finished_at(label, Instant::now());
    }

    fn mark_load_finished_at(&self, label: &str, finished: Instant) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .loads
            .entry(label.to_owned())
            .or_default()
            .finished = Some(finished);
    }

    pub fn complete(&self, label: &str, renderer_ready_time: f64) -> Option<LaunchStats> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !inner.completed.insert(label.to_owned()) {
            return None;
        }

        let main_ready_time = inner.main_ready.unwrap_or_default();
        let load_time = inner
            .loads
            .get(label)
            .and_then(|load| load.started.zip(load.finished))
            .and_then(|(started, finished)| finished.checked_duration_since(started))
            .unwrap_or_default();

        Some(LaunchStats {
            main_ready_time: duration_milliseconds(main_ready_time),
            load_time: duration_milliseconds(load_time),
            renderer_ready_time,
        })
    }
}

fn duration_milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

impl WindowZoomState {
    pub fn new() -> Self {
        Self {
            factors: Mutex::new(HashMap::new()),
            config_dir: Mutex::new(None),
        }
    }

    /// Load persisted zoom factors from the given config directory.
    /// Called once from the Tauri setup closure where the path is known.
    pub fn load_from_config_dir(&self, dir: std::path::PathBuf) {
        if let Some(factors) = Self::load_from_file(&dir) {
            *self
                .factors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = factors;
        }
        *self
            .config_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(dir);
    }

    pub fn get(&self, label: &str) -> f64 {
        *self
            .factors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(label)
            .unwrap_or(&DEFAULT_ZOOM_FACTOR)
    }

    pub fn set(&self, label: &str, factor: f64) {
        self.factors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(label.to_owned(), factor);
        self.save_to_file();
    }

    fn load_from_file(dir: &std::path::Path) -> Option<HashMap<String, f64>> {
        let path = dir.join("zoom-state.json");
        let data = std::fs::read(&path).ok()?;
        serde_json::from_slice(&data).ok()
    }

    fn save_to_file(&self) {
        let config_dir = self
            .config_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(dir) = config_dir {
            let path = dir.join("zoom-state.json");
            let _ = std::fs::create_dir_all(&dir);
            let factors = self
                .factors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let _ = std::fs::write(&path, serde_json::to_string(&factors).unwrap_or_default());
        }
    }
}

impl WindowRoutingState {
    #[cfg(test)]
    pub fn get(&self, label: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .selected_paths
            .get(label)
            .cloned()
    }

    pub fn set(&self, label: &str, path: Option<String>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(path) = path {
            inner.selected_paths.insert(label.to_owned(), path);
        } else {
            inner.selected_paths.remove(label);
        }
    }

    pub fn next_window_label(&self) -> String {
        let number = self.next_window_number.fetch_add(1, Ordering::Relaxed) + 1;
        format!("repository-{number}")
    }

    pub fn queue_open_repository(&self, label: &str, path: impl Into<String>) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .startup_actions
            .insert(label.to_owned(), WindowStartupAction::open_repository(path));
    }

    pub fn take_startup_action(&self, label: &str) -> Option<WindowStartupAction> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .startup_actions
            .remove(label)
    }

    pub fn remove(&self, label: &str) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.selected_paths.remove(label);
        inner.startup_actions.remove(label);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{LaunchTimingState, WindowRoutingState, WindowZoomState};

    #[test]
    fn selected_repository_paths_are_scoped_by_window_and_stored_verbatim() {
        let state = WindowRoutingState::default();

        assert_eq!(state.get("main"), None);
        state.set("main", Some("/repo/../repo".to_owned()));
        state.set("other", Some("/other".to_owned()));

        assert_eq!(state.get("main").as_deref(), Some("/repo/../repo"));
        assert_eq!(state.get("other").as_deref(), Some("/other"));
    }

    #[test]
    fn null_and_window_destruction_remove_selected_repository_metadata() {
        let state = WindowRoutingState::default();
        state.set("main", Some("/repo".to_owned()));
        state.set("main", None);
        assert_eq!(state.get("main"), None);

        state.set("main", Some(String::new()));
        assert_eq!(state.get("main").as_deref(), Some(""));
        state.remove("main");
        assert_eq!(state.get("main"), None);
    }

    #[test]
    fn repository_window_labels_are_unique_and_tauri_safe() {
        let state = WindowRoutingState::default();

        assert_eq!(state.next_window_label(), "repository-1");
        assert_eq!(state.next_window_label(), "repository-2");
    }

    #[test]
    fn a_new_windows_open_action_is_one_shot_and_preserves_the_path() {
        let state = WindowRoutingState::default();
        state.queue_open_repository("repository-1", "/repo/../repo");

        let action = state
            .take_startup_action("repository-1")
            .expect("the target window should receive its queued action");
        assert_eq!(
            serde_json::to_value(action).expect("the action should serialize"),
            serde_json::json!({
                "kind": "open-repository",
                "path": "/repo/../repo",
                "persistSelection": false,
            })
        );
        assert!(state.take_startup_action("repository-1").is_none());
    }

    #[test]
    fn window_destruction_drops_an_unclaimed_startup_action() {
        let state = WindowRoutingState::default();
        state.queue_open_repository("repository-1", "/repo");

        state.remove("repository-1");

        assert!(state.take_startup_action("repository-1").is_none());
    }

    #[test]
    fn each_webview_starts_at_electrons_default_zoom() {
        let state = WindowZoomState::new();

        assert_eq!(state.get("main"), 1.0);
        assert_eq!(state.get("other"), 1.0);
    }

    #[test]
    fn zoom_values_are_scoped_by_webview_label() {
        let state = WindowZoomState::new();

        state.set("main", 1.25);
        state.set("other", 0.8);

        assert_eq!(state.get("main"), 1.25);
        assert_eq!(state.get("other"), 0.8);
    }

    #[test]
    fn zoom_persists_to_and_loads_from_a_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = Some(dir.path().to_path_buf());
        {
            let state = WindowZoomState::new();
            *state.config_dir.lock().unwrap() = config_dir.clone();
            state.set("main", 1.25);
            state.set("repository-1", 0.9);
        }
        {
            let state = WindowZoomState::new();
            if let Some(factors) = WindowZoomState::load_from_file(dir.path()) {
                *state.factors.lock().unwrap() = factors;
            }
            assert_eq!(state.get("main"), 1.25);
            assert_eq!(state.get("repository-1"), 0.9);
        }
    }

    #[test]
    fn launch_timings_match_the_upstream_three_field_contract() {
        let launch = Instant::now();
        let state = LaunchTimingState::new_at(launch);
        state.mark_main_ready_at(launch + Duration::from_millis(10));
        state.mark_load_started_at("main", launch + Duration::from_millis(20));
        state.mark_load_finished_at("main", launch + Duration::from_millis(50));

        let stats = state
            .complete("main", 25.5)
            .expect("the first renderer-ready signal should complete launch timing");

        assert_eq!(stats.main_ready_time, 10.0);
        assert_eq!(stats.load_time, 30.0);
        assert_eq!(stats.renderer_ready_time, 25.5);
        assert_eq!(
            serde_json::to_value(stats).expect("launch stats should serialize"),
            serde_json::json!({
                "mainReadyTime": 10.0,
                "loadTime": 30.0,
                "rendererReadyTime": 25.5
            })
        );
    }

    #[test]
    fn renderer_ready_is_one_shot_per_webview() {
        let launch = Instant::now();
        let state = LaunchTimingState::new_at(launch);
        state.mark_main_ready_at(launch);
        state.mark_load_started_at("main", launch);
        state.mark_load_finished_at("main", launch);

        assert!(state.complete("main", 1.0).is_some());
        assert!(state.complete("main", 2.0).is_none());
    }
}
