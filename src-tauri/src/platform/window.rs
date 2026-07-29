use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;

const DEFAULT_ZOOM_FACTOR: f64 = 1.0;

/// Zoom is a webview property that Tauri can set but cannot read. Keep the
/// last successful value per webview so the frontend retains Electron's getter.
#[derive(Default)]
pub struct WindowZoomState {
    factors: Mutex<HashMap<String, f64>>,
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
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{LaunchTimingState, WindowZoomState};

    #[test]
    fn each_webview_starts_at_electrons_default_zoom() {
        let state = WindowZoomState::default();

        assert_eq!(state.get("main"), 1.0);
        assert_eq!(state.get("other"), 1.0);
    }

    #[test]
    fn zoom_values_are_scoped_by_webview_label() {
        let state = WindowZoomState::default();

        state.set("main", 1.25);
        state.set("other", 0.8);

        assert_eq!(state.get("main"), 1.25);
        assert_eq!(state.get("other"), 0.8);
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
