use tauri::{Emitter, State, WebviewWindow};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::platform::window::{LaunchTimingState, WindowZoomState};

use super::CommandError;

const ZOOM_FACTOR_CHANGED_EVENT: &str = "zoom-factor-changed";
const LAUNCH_TIMING_STATS_EVENT: &str = "launch-timing-stats";

#[tauri::command]
pub fn get_current_window_zoom_factor(
    window: WebviewWindow,
    state: State<'_, WindowZoomState>,
) -> Result<f64, CommandError> {
    Ok(state.get(window.label()))
}

#[tauri::command]
pub fn set_window_zoom_factor(
    window: WebviewWindow,
    state: State<'_, WindowZoomState>,
    zoom_factor: f64,
) -> Result<(), CommandError> {
    window
        .set_zoom(zoom_factor)
        .map_err(|error| CommandError::message(error.to_string()))?;
    state.set(window.label(), zoom_factor);
    window
        .emit(ZOOM_FACTOR_CHANGED_EVENT, zoom_factor)
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub fn renderer_ready(
    window: WebviewWindow,
    state: State<'_, LaunchTimingState>,
    renderer_ready_time: f64,
) -> Result<(), CommandError> {
    let Some(stats) = state.complete(window.label(), renderer_ready_time) else {
        return Ok(());
    };

    // electron-window-state persisted geometry and maximization. Visibility
    // remains owned by this handshake, while decorations and fullscreen have
    // separate application policies.
    let restore_result =
        window.restore_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);

    // A corrupt or no-longer-valid saved position must never strand the app as
    // an invisible process. Always attempt to show it before reporting errors.
    let show_result = window.show().and_then(|()| window.set_focus());

    restore_result.map_err(|error| CommandError::message(error.to_string()))?;
    show_result.map_err(|error| CommandError::message(error.to_string()))?;
    window
        .emit(LAUNCH_TIMING_STATS_EVENT, stats)
        .map_err(|error| CommandError::message(error.to_string()))
}
