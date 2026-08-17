use crate::{
    commands::CommandError,
    platform::credential_store::{CredentialStore, KeyringCredentialStore},
};
use std::sync::Arc;
use tauri::State;

pub struct CredentialStoreState {
    store: Arc<dyn CredentialStore>,
}

impl CredentialStoreState {
    pub fn new() -> Self {
        Self {
            store: Arc::new(KeyringCredentialStore::native()),
        }
    }
}

#[tauri::command]
pub async fn set_credential(
    state: State<'_, CredentialStoreState>,
    service: String,
    login: String,
    value: String,
) -> Result<(), CommandError> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.set(&service, &login, &value))
        .await
        .map_err(|error| CommandError::message(error.to_string()))?
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn get_credential(
    state: State<'_, CredentialStoreState>,
    service: String,
    login: String,
) -> Result<Option<String>, CommandError> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.get(&service, &login))
        .await
        .map_err(|error| CommandError::message(error.to_string()))?
        .map_err(|error| CommandError::message(error.to_string()))
}

#[tauri::command]
pub async fn delete_credential(
    state: State<'_, CredentialStoreState>,
    service: String,
    login: String,
) -> Result<bool, CommandError> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.delete(&service, &login))
        .await
        .map_err(|error| CommandError::message(error.to_string()))?
        .map_err(|error| CommandError::message(error.to_string()))
}
