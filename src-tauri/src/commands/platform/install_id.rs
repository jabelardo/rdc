use crate::{
    commands::CommandError,
    platform::install_id::{self, InstallIdState},
};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn get_guid(
    app: AppHandle,
    state: State<'_, InstallIdState>,
) -> Result<String, CommandError> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    Ok(install_id::get_install_id(directory, &state).await)
}

#[tauri::command]
pub async fn save_guid(
    app: AppHandle,
    state: State<'_, InstallIdState>,
    guid: String,
) -> Result<(), CommandError> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    install_id::save_install_id(directory, &state, guid)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}
