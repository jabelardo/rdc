use super::CommandError;
use crate::platform::custom_integration::{
    expand_target_path_argument, is_valid_custom_integration as validate_integration,
    parse_custom_integration_arguments,
    validate_custom_integration_path as validate_integration_path,
};
use crate::platform::custom_integration_model::{
    CustomIntegration, CustomIntegrationPathValidation,
};
use crate::platform::editors::FoundEditor;
use std::path::PathBuf;

/// Finds supported editors installed on the current machine.
///
/// Discovery touches a fixed list of filesystem paths, so keep it off the webview/main thread. The
/// Linux checks the executable candidates upstream used; macOS resolves upstream's bundle identifiers
/// through Spotlight. Windows remains deferred with Windows support.
#[tauri::command]
pub async fn get_available_editors() -> Result<Vec<FoundEditor>, CommandError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(crate::platform::editors::get_available_editors)
            .await
            .map_err(|error| {
                CommandError::message(format!("editor discovery task failed: {error}"))
            })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err(CommandError::message(
        "editor discovery is not implemented for this platform yet",
    ))
}

#[tauri::command]
pub async fn validate_custom_integration_path(
    path: PathBuf,
) -> Result<CustomIntegrationPathValidation, CommandError> {
    Ok(validate_integration_path(&path).await)
}

#[tauri::command]
pub async fn is_valid_custom_integration(
    custom_integration: CustomIntegration,
) -> Result<bool, CommandError> {
    Ok(validate_integration(&custom_integration).await)
}

#[tauri::command]
pub async fn launch_external_editor(
    full_path: PathBuf,
    editor: FoundEditor,
) -> Result<(), CommandError> {
    crate::platform::editors::launch_editor(editor.path, vec![path_text(full_path)?], true)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn launch_custom_external_editor(
    full_path: PathBuf,
    custom_editor: CustomIntegration,
) -> Result<(), CommandError> {
    let target_path = path_text(full_path)?;
    let arguments = parse_custom_integration_arguments(&custom_editor.arguments)
        .map_err(|error| CommandError::message(error.to_string()))?;
    let arguments = expand_target_path_argument(arguments, &target_path);

    crate::platform::editors::launch_editor(
        custom_editor.path,
        arguments,
        custom_editor.bundle_id.is_some(),
    )
    .await
    .map_err(|error| CommandError::message(error.to_string()))
}

fn path_text(path: PathBuf) -> Result<String, CommandError> {
    path.into_os_string().into_string().map_err(|_| {
        CommandError::message("editor target path is not valid Unicode and cannot cross IPC")
    })
}
