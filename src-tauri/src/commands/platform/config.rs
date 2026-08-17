use crate::{
    commands::CommandError,
    config::{self, MainProcessConfig, MainProcessConfigUpdate},
};
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;
use tokio::sync::Mutex;

pub struct MainProcessConfigState {
    gate: Mutex<()>,
}

impl MainProcessConfigState {
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(()),
        }
    }
}

async fn update_at(
    directory: std::path::PathBuf,
    gate: &Mutex<()>,
    config_diff: MainProcessConfigUpdate,
) -> Result<MainProcessConfig, CommandError> {
    let _guard = gate.lock().await;
    config::update_main_process_config(directory, config_diff)
        .await
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn get_main_process_config(
    app: AppHandle,
    state: State<'_, MainProcessConfigState>,
) -> Result<MainProcessConfig, CommandError> {
    let _guard = state.gate.lock().await;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    config::read_main_process_config(&directory)
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn update_main_process_config(
    app: AppHandle,
    state: State<'_, MainProcessConfigState>,
    config_diff: MainProcessConfigUpdate,
) -> Result<MainProcessConfig, CommandError> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::message(error.to_string()))?;
    update_at(directory, &state.gate, config_diff).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::update_at;
    use crate::config::{read_main_process_config, MainProcessConfigUpdate, TitleBarStyle};
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn concurrent_partial_updates_do_not_lose_fields() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().to_owned();
        let gate = Arc::new(Mutex::new(()));

        let title = tokio::spawn({
            let path = path.clone();
            let gate = Arc::clone(&gate);
            async move {
                update_at(
                    path,
                    &gate,
                    MainProcessConfigUpdate {
                        title_bar_style: Some(TitleBarStyle::Custom),
                        hide_window_on_quit: None,
                    },
                )
                .await
            }
        });
        let hiding = tokio::spawn({
            let path = path.clone();
            let gate = Arc::clone(&gate);
            async move {
                update_at(
                    path,
                    &gate,
                    MainProcessConfigUpdate {
                        title_bar_style: None,
                        hide_window_on_quit: Some(true),
                    },
                )
                .await
            }
        });

        title.await.expect("title task").expect("title update");
        hiding.await.expect("hide task").expect("hide update");
        let config = read_main_process_config(&path).expect("stored config");
        assert_eq!(config.title_bar_style, TitleBarStyle::Custom);
        assert!(config.hide_window_on_quit);
    }
}
