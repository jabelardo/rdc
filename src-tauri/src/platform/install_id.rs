use std::path::{Path, PathBuf};

use thiserror::Error;
use tokio::sync::Mutex;

pub const INSTALL_ID_FILE_NAME: &str = "install-id";

#[derive(Debug, Error)]
pub enum InstallIdError {
    #[error("could not create install-ID directory at {path}: {source}")]
    CreateDirectory {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write install ID at {path}: {source}")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

pub struct InstallIdState {
    cached: Mutex<Option<String>>,
}

impl InstallIdState {
    pub fn new() -> Self {
        Self {
            cached: Mutex::new(None),
        }
    }
}

fn is_valid(id: &str) -> bool {
    id.chars().count() == 36
}

async fn write_id(directory: &Path, id: &str) -> Result<(), InstallIdError> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|source| InstallIdError::CreateDirectory {
            path: directory.display().to_string(),
            source,
        })?;
    let path = directory.join(INSTALL_ID_FILE_NAME);
    tokio::fs::write(&path, id)
        .await
        .map_err(|source| InstallIdError::Write {
            path: path.display().to_string(),
            source,
        })
}

pub async fn get_install_id(directory: PathBuf, state: &InstallIdState) -> String {
    let mut cached = state.cached.lock().await;
    if let Some(id) = cached.as_ref() {
        return id.clone();
    }

    let path = directory.join(INSTALL_ID_FILE_NAME);
    let persisted = tokio::fs::read_to_string(path)
        .await
        .ok()
        .map(|id| id.trim().to_owned())
        .filter(|id| is_valid(id));
    let needs_write = persisted.is_none();
    let id = persisted.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Upstream still returns and caches the generated ID when persistence
    // fails, keeping one stable value for the lifetime of this process.
    if needs_write {
        let _ = write_id(&directory, &id).await;
    }
    *cached = Some(id.clone());
    id
}

pub async fn save_install_id(
    directory: PathBuf,
    state: &InstallIdState,
    id: String,
) -> Result<(), InstallIdError> {
    let mut cached = state.cached.lock().await;
    // Preserve the migration-era upstream contract: a save establishes the
    // process value even if the following filesystem operation fails.
    *cached = Some(id.clone());
    write_id(&directory, &id).await
}

#[cfg(test)]
mod tests {
    use super::{get_install_id, save_install_id, InstallIdState, INSTALL_ID_FILE_NAME};

    #[tokio::test]
    async fn generates_persists_and_caches_a_36_character_id() {
        let directory = tempfile::tempdir().expect("temp dir");
        let state = InstallIdState::new();

        let first = get_install_id(directory.path().to_owned(), &state).await;
        tokio::fs::write(directory.path().join(INSTALL_ID_FILE_NAME), "changed")
            .await
            .expect("replace persisted value");
        let second = get_install_id(directory.path().to_owned(), &state).await;

        assert_eq!(first.chars().count(), 36);
        assert_eq!(second, first);
    }

    #[tokio::test]
    async fn a_generated_id_survives_a_fresh_process_state() {
        let directory = tempfile::tempdir().expect("temp dir");
        let first = get_install_id(directory.path().to_owned(), &InstallIdState::new()).await;

        let reloaded = get_install_id(directory.path().to_owned(), &InstallIdState::new()).await;

        assert_eq!(reloaded, first);
    }

    #[tokio::test]
    async fn trims_and_accepts_any_persisted_36_character_value() {
        let directory = tempfile::tempdir().expect("temp dir");
        let expected = "x".repeat(36);
        tokio::fs::write(
            directory.path().join(INSTALL_ID_FILE_NAME),
            format!(" {expected}\n"),
        )
        .await
        .expect("persist ID");

        assert_eq!(
            get_install_id(directory.path().to_owned(), &InstallIdState::new()).await,
            expected
        );
    }

    #[tokio::test]
    async fn replaces_an_invalid_persisted_id() {
        let directory = tempfile::tempdir().expect("temp dir");
        tokio::fs::write(directory.path().join(INSTALL_ID_FILE_NAME), "short")
            .await
            .expect("persist invalid ID");

        let id = get_install_id(directory.path().to_owned(), &InstallIdState::new()).await;

        assert_eq!(id.chars().count(), 36);
        assert_ne!(id, "short");
        assert_eq!(
            tokio::fs::read_to_string(directory.path().join(INSTALL_ID_FILE_NAME))
                .await
                .expect("replacement ID"),
            id
        );
    }

    #[tokio::test]
    async fn explicit_save_caches_before_a_failed_write() {
        let directory = tempfile::tempdir().expect("temp dir");
        let unusable = directory.path().join("file");
        tokio::fs::write(&unusable, "not a directory")
            .await
            .expect("blocking file");
        let state = InstallIdState::new();
        let id = "migrated-value-is-cached-even-if-invalid".to_owned();

        save_install_id(unusable.clone(), &state, id.clone())
            .await
            .expect_err("save should fail");

        assert_eq!(get_install_id(unusable, &state).await, id);
    }
}
