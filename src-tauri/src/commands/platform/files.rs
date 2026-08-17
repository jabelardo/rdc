use crate::commands::CommandError;
use crate::platform::{
    files::{self, FolderOpenAction, PathFailure},
    system,
};
use std::path::PathBuf;

#[tauri::command]
pub async fn classify_folder_open(path: PathBuf) -> Result<Option<FolderOpenAction>, CommandError> {
    files::classify_folder_open(&path)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}

/// Moves many repository-relative paths to the trash in one call.
///
/// ```js
/// await invoke('move_repository_paths_to_trash', { repositoryPath, relativePaths })
/// // -> [{ path: 'locked.txt', message: '...' }]
/// ```
///
/// Resolves to the paths that failed rather than rejecting on the first one, so a caller midway
/// through a multi-part operation can finish it for the paths that succeeded. An empty array means
/// everything was trashed.
#[tauri::command]
pub async fn move_repository_paths_to_trash(
    repository_path: PathBuf,
    relative_paths: Vec<String>,
) -> Result<Vec<PathFailure>, CommandError> {
    Ok(files::move_repository_paths_to_trash(&repository_path, &relative_paths).await)
}

/// Permanently deletes many repository-relative paths in one call, reporting per-path failures.
///
/// ```js
/// await invoke('permanently_delete_repository_paths', { repositoryPath, relativePaths })
/// ```
#[tauri::command]
pub async fn permanently_delete_repository_paths(
    repository_path: PathBuf,
    relative_paths: Vec<String>,
) -> Result<Vec<PathFailure>, CommandError> {
    Ok(files::permanently_delete_repository_paths(&repository_path, &relative_paths).await)
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
