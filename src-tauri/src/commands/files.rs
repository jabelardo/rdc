use std::path::PathBuf;

use crate::platform::{
    files::{self, FolderOpenAction},
    system,
};

use super::CommandError;

#[tauri::command]
pub async fn classify_folder_open(path: PathBuf) -> Result<Option<FolderOpenAction>, CommandError> {
    files::classify_folder_open(&path)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn move_item_to_trash(path: PathBuf) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || files::move_to_trash(&path))
        .await
        .map_err(|error| CommandError::message(format!("trash task failed: {error}")))?
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub fn get_exec_path() -> Result<String, CommandError> {
    std::env::current_exe()
        .map_err(|error| CommandError::message(error.to_string()))?
        .into_os_string()
        .into_string()
        .map_err(|_| CommandError::message("executable path is not valid Unicode"))
}

#[tauri::command]
pub fn is_running_under_arm64_translation() -> Result<bool, CommandError> {
    Ok(system::is_running_under_arm64_translation())
}
