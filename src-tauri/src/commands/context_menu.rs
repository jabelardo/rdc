#[cfg(target_os = "linux")]
use tauri::PhysicalPosition;
use tauri::{Manager, WebviewWindow};

use crate::platform::context_menu::{build_menu, ContextMenuItemModel};

use super::CommandError;

/// Pop up a context menu built fresh for this one invocation.
///
/// Ported from Beaver-Notes' `show_edit_context_menu` (`dc692e7e`, issue #429): a custom Rust
/// command that anchors via `popup_menu_at` with a `PhysicalPosition` computed from the window's
/// own `outer_position`/`scale_factor`, rather than the JS `Menu.popup()` call this project used
/// before. `x`/`y` are screen-relative CSS pixels (`event.screenX`/`event.screenY`), matching what
/// Beaver-Notes reads off its `contextmenu` listener.
///
/// This is anchoring only, not a fix for the Wayland freeze: both entry points resolve to the same
/// `Menu::popup_inner`, and muda's GTK backend normalizes `PhysicalPosition`/`LogicalPosition` to
/// the same representation before it ever reaches the code that holds the ungated grab (see
/// `muda-0.19.3/src/platform_impl/gtk/mod.rs:1416-1500`). Kept as the literal port anyway, on
/// request, so that claim is verified on real hardware rather than taken on the trace alone.
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

    let app = window.app_handle().clone();
    let menu = build_menu(&app, &items).map_err(CommandError::message)?;

    #[cfg(target_os = "linux")]
    {
        let window_position = window
            .outer_position()
            .map_err(|error| CommandError::message(error.to_string()))?;
        let scale_factor = window
            .scale_factor()
            .map_err(|error| CommandError::message(error.to_string()))?;
        let physical_x = (x * scale_factor) - window_position.x as f64;
        let physical_y = (y * scale_factor) - window_position.y as f64;
        window
            .popup_menu_at(
                &menu,
                PhysicalPosition::new(physical_x as i32, physical_y as i32),
            )
            .map_err(|error| CommandError::message(error.to_string()))
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Never regressed on macOS/Windows — the OS already places an unpositioned popup at the
        // pointer correctly, so there's no reason to risk new position math where nothing was
        // broken.
        let _ = (x, y);
        window
            .popup_menu(&menu)
            .map_err(|error| CommandError::message(error.to_string()))
    }
}
