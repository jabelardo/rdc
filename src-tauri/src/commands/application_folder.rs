use tauri::AppHandle;

#[cfg(target_os = "macos")]
use crate::platform::application_folder;

use super::CommandError;

#[tauri::command]
pub fn is_in_application_folder() -> Result<Option<bool>, CommandError> {
    #[cfg(target_os = "macos")]
    {
        let executable =
            std::env::current_exe().map_err(|error| CommandError::message(error.to_string()))?;
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        Ok(Some(application_folder::is_in_application_folder(
            &executable,
            home.as_deref(),
        )))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub async fn move_to_applications_folder(app: AppHandle) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let executable =
            std::env::current_exe().map_err(|error| CommandError::message(error.to_string()))?;
        let destination = application_folder::move_to_applications_folder(&executable)
            .await
            .map_err(|error| CommandError::message(error.to_string()))?;
        std::process::Command::new("/usr/bin/open")
            .args(["-n", destination.to_string_lossy().as_ref()])
            .spawn()
            .map_err(|error| CommandError::message(error.to_string()))?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(CommandError::message(
            "moving to Applications is only supported on macOS",
        ))
    }
}
