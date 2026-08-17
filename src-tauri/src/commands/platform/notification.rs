use crate::commands::CommandError;
use crate::platform::notification::{self, NotificationState};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tauri::WebviewWindow;

const NOTIFICATION_EVENT: &str = "notification-event";

fn dispatch_click(app: &tauri::AppHandle, id: u32) {
    let windows = app.webview_windows();
    let live_windows = windows.keys().cloned().collect::<HashSet<_>>();
    let focused_window = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.label().to_owned());
    let route =
        app.state::<NotificationState>()
            .route_click(id, &live_windows, focused_window.as_deref());
    if let Some(route) = route {
        if let Some(window) = windows.get(&route.window_label) {
            let _ = window.emit(NOTIFICATION_EVENT, route.event);
        }
    }
}

#[tauri::command]
pub async fn show_notification(
    window: WebviewWindow,
    state: State<'_, NotificationState>,
    title: String,
    body: String,
    user_info: Option<Value>,
) -> Result<Option<String>, CommandError> {
    notification::validate_user_info(&user_info).map_err(CommandError::message)?;
    let id = state.reserve(window.label(), user_info);
    let native_result = tauri::async_runtime::spawn_blocking(move || {
        notification::show_native_notification(id, &title, &body)
    })
    .await;
    let native = match native_result {
        Ok(native) => native,
        Err(error) => {
            state.remove(id);
            return Err(CommandError::message(error.to_string()));
        }
    };
    let handle = match native {
        Ok(handle) => handle,
        Err(error) => {
            state.remove(id);
            return Err(CommandError::message(error.to_string()));
        }
    };

    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let clicked = Arc::new(AtomicBool::new(false));
        let clicked_in_handler = clicked.clone();
        let app_in_handler = app.clone();
        let result =
            handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                if matches!(
                    response,
                    notify_rust::NotificationResponse::Default
                        | notify_rust::NotificationResponse::Action(_)
                ) {
                    clicked_in_handler.store(true, Ordering::Relaxed);
                    dispatch_click(&app_in_handler, id);
                }
            });
        if result.is_err() || !clicked.load(Ordering::Relaxed) {
            app.state::<NotificationState>().remove(id);
        }
    });

    Ok(Some(id.to_string()))
}

#[tauri::command]
pub async fn get_notifications_permission(
) -> Result<notification::NotificationPermission, CommandError> {
    notification::get_permission()
        .await
        .map_err(CommandError::message)
}

#[tauri::command]
pub async fn request_notifications_permission() -> Result<bool, CommandError> {
    notification::request_permission()
        .await
        .map_err(CommandError::message)
}
