use crate::{
    commands::CommandError,
    platform::{
        context_menu::{self, ContextMenuState},
        context_menu_model::ContextMenuItemModel,
        keybindings::{self, BindingPlatform},
        menu::{self, NativeMenuState},
        menu_model::MenuModel,
    },
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::keybindings::KeybindingState;

/// Replace macOS's bootstrap menu with the canonical frontend-owned tree.
///
/// Linux and Windows render that tree in the webview and deliberately perform no native menu work.
#[tauri::command]
pub async fn set_native_menu(
    app: AppHandle,
    keybinding_state: State<'_, KeybindingState>,
    native_menu_state: State<'_, NativeMenuState>,
    menu: MenuModel,
) -> Result<(), CommandError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }

    let _guard = keybinding_state.gate.lock().await;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    let bindings = keybindings::get_keybindings(&directory, BindingPlatform::MacOs)
        .await
        .map_err(|error| CommandError::message(error.to_string()))?;
    menu::replace_native_menu(&app, native_menu_state.inner(), &menu, &bindings)
        .map_err(CommandError::message)
}

/// Show renderer-defined contextual items and return the selected nested index path.
#[tauri::command]
pub async fn show_contextual_menu(
    app: AppHandle,
    window: WebviewWindow,
    context_menu_state: State<'_, ContextMenuState>,
    items: Vec<ContextMenuItemModel>,
    add_spell_check_menu: bool,
) -> Result<Option<Vec<usize>>, CommandError> {
    if add_spell_check_menu {
        return Err(CommandError::message(
            "WebKit spell-check context items are deferred to Phase 7",
        ));
    }

    context_menu::show_contextual_menu(&app, &window, context_menu_state.inner(), &items)
        .await
        .map_err(CommandError::message)
}
