use crate::{
    commands::CommandError,
    platform::{
        keybinding_model::Keybinding,
        keybindings::{self, BindingPlatform},
    },
};
use std::collections::BTreeMap;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tokio::sync::Mutex;

const CHANGED_EVENT: &str = "keybindings-changed";

pub struct KeybindingState {
    pub(crate) gate: Mutex<()>,
}

impl KeybindingState {
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(()),
        }
    }
}

fn current_platform() -> BindingPlatform {
    #[cfg(target_os = "macos")]
    return BindingPlatform::MacOs;
    #[cfg(target_os = "windows")]
    return BindingPlatform::Windows;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return BindingPlatform::Other;
}

#[tauri::command]
pub async fn get_keybindings(
    app: AppHandle,
    state: State<'_, KeybindingState>,
) -> Result<BTreeMap<String, Keybinding>, CommandError> {
    let _guard = state.gate.lock().await;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    keybindings::get_keybindings(&directory, current_platform())
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn set_keybinding(
    app: AppHandle,
    state: State<'_, KeybindingState>,
    menu_id: String,
    binding: Keybinding,
) -> Result<BTreeMap<String, Keybinding>, CommandError> {
    let _guard = state.gate.lock().await;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    let bindings = keybindings::set_keybinding(&directory, current_platform(), &menu_id, binding)
        .await
        .map_err(|error| CommandError::message(error.to_string()))?;
    app.emit(CHANGED_EVENT, &bindings)
        .map_err(|error| CommandError::message(error.to_string()))?;
    Ok(bindings)
}

#[tauri::command]
pub async fn reset_keybindings(
    app: AppHandle,
    state: State<'_, KeybindingState>,
) -> Result<BTreeMap<String, Keybinding>, CommandError> {
    let _guard = state.gate.lock().await;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    let bindings = keybindings::reset_keybindings(&directory, current_platform())
        .await
        .map_err(|error| CommandError::message(error.to_string()))?;
    app.emit(CHANGED_EVENT, &bindings)
        .map_err(|error| CommandError::message(error.to_string()))?;
    Ok(bindings)
}
