//! Commands about a repository as a whole: creating one, and what git says it is.

use crate::commands::CommandError;

/// Initializes a repository at a new or existing directory.
#[tauri::command]
pub async fn init_repository(
    repository_path: String,
    default_branch: String,
) -> Result<(), CommandError> {
    initialize_repository(&repository_path, &default_branch).await
}

async fn initialize_repository(
    repository_path: &str,
    default_branch: &str,
) -> Result<(), CommandError> {
    tokio::fs::create_dir_all(repository_path)
        .await
        .map_err(|error| {
            CommandError::message(format!(
                "failed to create repository directory '{repository_path}': {error}"
            ))
        })?;
    git_ops::init_repository(repository_path, default_branch)
        .await
        .map_err(CommandError::from)
}

#[cfg(test)]
mod init_repository_tests {
    use super::initialize_repository;

    #[tokio::test]
    async fn creates_a_missing_destination_directory() {
        let parent = tempfile::tempdir().expect("failed to create a temporary directory");
        let destination = parent.path().join("new-repository");

        initialize_repository(
            destination
                .to_str()
                .expect("temporary path should be UTF-8"),
            "main",
        )
        .await
        .expect("init should create its destination directory");

        assert!(destination.join(".git").is_dir(), ".git should exist");
    }
}
