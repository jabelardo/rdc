use crate::{
    commands::CommandError,
    platform::{
        context_menu::{self, ContextMenuState},
        context_menu_model::ContextMenuItemModel,
        keybindings,
        menu::{self, NativeMenuState},
        menu_model::MenuModel,
    },
};

use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::keybindings::KeybindingState;

#[tauri::command]
pub async fn set_native_menu(
    app: AppHandle,
    keybinding_state: State<'_, KeybindingState>,
    native_menu_state: State<'_, NativeMenuState>,
    menu: MenuModel,
) -> Result<(), CommandError> {
    let _guard = keybinding_state.gate.lock().await;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    let bindings = keybindings::get_keybindings(&directory, current_binding_platform())
        .await
        .map_err(|error| CommandError::message(error.to_string()))?;
    menu::replace_native_menu(&app, native_menu_state.inner(), &menu, &bindings)
        .map_err(CommandError::message)
}

fn current_binding_platform() -> keybindings::BindingPlatform {
    #[cfg(target_os = "macos")]
    {
        keybindings::BindingPlatform::MacOs
    }
    #[cfg(target_os = "windows")]
    {
        keybindings::BindingPlatform::Windows
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        keybindings::BindingPlatform::Other
    }
}

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
