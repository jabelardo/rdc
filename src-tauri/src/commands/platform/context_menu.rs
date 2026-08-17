use tauri::WebviewWindow;

use crate::platform::context_menu::ContextMenuItemModel;

use super::CommandError;

/// Pop up a context menu built fresh for this one invocation.
///
/// `x`/`y` are logical pixels relative to the **webview**, already scaled by the zoom factor, which
/// only the frontend knows. Converting them to window-relative is this side's job, since only GTK
/// can say where the webview sits inside the window.
///
/// Linux builds and shows the GTK menu directly and returns without waiting for it to close — see
/// `platform::context_menu::popup_non_blocking` for why muda's popup cannot be used there. macOS
/// and Windows keep muda's popup, whose backends are each a single native call with no polling loop
/// to wedge, and which place an unpositioned popup at the pointer correctly on their own.
#[tauri::command]
pub async fn show_context_menu_at(
    window: WebviewWindow,
    x: f64,
    y: f64,
    items: Vec<ContextMenuItemModel>,
) -> Result<(), CommandError> {
    if items.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        crate::platform::context_menu::popup_non_blocking(window, x, y, items)
            .map_err(CommandError::message)
    }

    #[cfg(not(target_os = "linux"))]
    {
        use tauri::Manager;

        let _ = (x, y);
        let app = window.app_handle().clone();
        let menu = crate::platform::context_menu::build_menu(&app, &items)
            .map_err(CommandError::message)?;
        window
            .popup_menu(&menu)
            .map_err(|error| CommandError::message(error.to_string()))
    }
}
