use crate::commands::CommandError;
use crate::platform::custom_integration_model::CustomIntegration;
use crate::platform::shells::FoundShell;
use std::path::PathBuf;

/// Finds terminal applications installed on the current machine.
#[tauri::command]
pub async fn get_available_shells() -> Result<Vec<FoundShell>, CommandError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(crate::platform::shells::get_available_shells)
            .await
            .map_err(|error| CommandError::message(format!("shell discovery task failed: {error}")))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err(CommandError::message(
        "shell discovery is not implemented for this platform yet",
    ))
}

#[tauri::command]
pub async fn launch_shell(shell: FoundShell, path: PathBuf) -> Result<(), CommandError> {
    crate::platform::shells::launch_shell(shell, path)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn launch_custom_shell(
    custom_shell: CustomIntegration,
    path: PathBuf,
) -> Result<(), CommandError> {
    crate::platform::shells::launch_custom_shell(custom_shell, path)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}
