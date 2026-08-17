use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::{
    create_window_from_main_template,
    platform::{
        window::{LaunchTimingState, WindowRoutingState, WindowZoomState},
        window_model::WindowStartupAction,
    },
};

use crate::commands::CommandError;

const ZOOM_FACTOR_CHANGED_EVENT: &str = "zoom-factor-changed";
const LAUNCH_TIMING_STATS_EVENT: &str = "launch-timing-stats";

#[tauri::command]
pub fn beep() -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        crate::platform::system::beep();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(CommandError::message("beep is only supported on macOS"))
    }
}

#[tauri::command]
pub async fn get_apple_action_on_double_click(
) -> Result<crate::platform::system::AppleActionOnDoubleClick, CommandError> {
    Ok(crate::platform::system::get_apple_action_on_double_click().await)
}

#[tauri::command]
pub fn set_window_selected_repository(
    window: WebviewWindow,
    state: State<'_, WindowRoutingState>,
    repository_path: Option<String>,
) -> Result<(), CommandError> {
    state.set(window.label(), repository_path);
    Ok(())
}

#[tauri::command]
pub fn open_repository_in_new_window(
    app: AppHandle,
    state: State<'_, WindowRoutingState>,
    repository_path: String,
) -> Result<(), CommandError> {
    let label = state.next_window_label();
    state.queue_open_repository(&label, repository_path);
    if let Err(error) = create_window_from_main_template(&app, &label) {
        state.remove(&label);
        return Err(CommandError::message(error.to_string()));
    }
    Ok(())
}

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

/// Toggle the webview inspector (developer tools). Dev-only surface: the
/// frontend only exposes the menu item in development builds, so release
/// builds without the `devtools` feature flag report an explicit error rather
/// than a silent no-op.
#[tauri::command]
pub fn toggle_devtools(window: WebviewWindow) -> Result<(), CommandError> {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        // Opening an already-open inspector focuses it, which is the closest
        // Tauri offers to a true toggle without a state API.
        window.open_devtools();
        Ok(())
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = window;
        Err(CommandError::message(
            "developer tools are not available in this build",
        ))
    }
}

#[tauri::command]
pub fn renderer_ready(
    window: WebviewWindow,
    timing_state: State<'_, LaunchTimingState>,
    routing_state: State<'_, WindowRoutingState>,
    renderer_ready_time: f64,
) -> Result<Option<WindowStartupAction>, CommandError> {
    let Some(stats) = timing_state.complete(window.label(), renderer_ready_time) else {
        return Ok(None);
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
        .map_err(|error| CommandError::message(error.to_string()))?;
    Ok(routing_state.take_startup_action(window.label()))
}
