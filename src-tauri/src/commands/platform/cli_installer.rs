use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

use crate::commands::CommandError;

#[tauri::command]
pub async fn install_darwin_cli(app: AppHandle) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let packaged_path = app
            .path()
            .resource_dir()
            .map_err(|error| CommandError::message(error.to_string()))?
            .join("rdc-cli");
        crate::platform::cli_installer::install(&packaged_path)
            .await
            .map_err(|error| CommandError::message(error.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(CommandError::message(
            "installing the command line launcher is only supported on macOS",
        ))
    }
}
