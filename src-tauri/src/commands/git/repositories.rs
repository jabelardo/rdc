//! Commands about a repository as a whole: creating one, and what git says it is.

use crate::commands::git::operation_lifecycle::finish_short_mutation;
use crate::commands::git::operation_lifecycle::start_short_mutation;
use crate::commands::CommandError;
use crate::operation_registry::OperationRegistry;
use git_ops::log::CommitIdentity;
use git_ops::rev_parse::RepositoryType;
use tauri::State;
use tauri::WebviewWindow;

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

/// The repository's description, or an empty string if it has none.
#[tauri::command]
pub async fn get_description(repository_path: String) -> Result<String, CommandError> {
    git_ops::description::get_description(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Writes the repository's description.
#[tauri::command]
pub async fn write_description(
    window: WebviewWindow,
    registry: State<'_, OperationRegistry>,
    repository_path: String,
    description: String,
) -> Result<(), CommandError> {
    let operation = start_short_mutation(&window, &registry, &repository_path).await?;
    finish_short_mutation(
        &registry,
        &operation.id,
        git_ops::description::write_description(&repository_path, &description).await,
    )
}

/// The identity a commit made now would carry, or `null` if git would refuse to invent one.
///
/// `null` means a commit will fail for the same reason, so the caller should prompt rather than proceed.
#[tauri::command]
pub async fn get_author_identity(
    repository_path: String,
) -> Result<Option<CommitIdentity>, CommandError> {
    git_ops::var::get_author_identity(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// Vouches for a repository git refuses as owned by someone else.
///
/// ```js
/// await invoke('add_safe_directory', { path: '/repos/borrowed' })
/// ```
///
/// Takes a **path, not a repository**: git won't read the repository's own config until it trusts the
/// path, so this necessarily writes the user's *global* config. That is also why it is the only remedy
/// for git's "dubious ownership" refusal.
///
/// Calling it repeatedly is harmless — an identical entry is never added twice.
#[tauri::command]
pub async fn add_safe_directory(path: String) -> Result<(), CommandError> {
    git_ops::config::GlobalConfig::new()
        .add_safe_directory(&path)
        .await
        .map_err(CommandError::from)
}

/// What kind of repository — if any — is at `path`.
///
/// ```js
/// await invoke('get_repository_type', { path })
/// // -> { kind: 'regular', topLevelWorkingDirectory } | { kind: 'bare' } | { kind: 'missing' }
/// //  | { kind: 'unsafe', path }
/// ```
///
/// A path that isn't a repository is an **answer**, not an error — the caller is usually asking exactly that.
/// `unsafe` means git refused it for dubious ownership; `add_safe_directory` is the way out.
#[tauri::command]
pub async fn get_repository_type(path: String) -> Result<RepositoryType, CommandError> {
    git_ops::rev_parse::get_repository_type(&path)
        .await
        .map_err(CommandError::from)
}

/// Reads a config value, or `null` when the key isn't set.
///
/// ```js
/// await invoke('get_config_value', { repositoryPath, name: 'core.autocrlf', onlyLocal: false })
/// ```
///
/// `onlyLocal` restricts the lookup to the repository's own config, ignoring the global and system files.
/// Absent means the full cascade, which is what git itself answers with.
///
/// `null` for an unset key is not an error: git exits 1 for that, and "not configured" is an answer.
#[tauri::command]
pub async fn get_config_value(
    repository_path: String,
    name: String,
    only_local: Option<bool>,
) -> Result<Option<String>, CommandError> {
    git_ops::config::get_config_value(&repository_path, &name, only_local.unwrap_or(false))
        .await
        .map_err(CommandError::from)
}

/// Returns the user's global git config path, creating the file if necessary.
///
/// Git resolves the real path before invoking its editor, so this respects its platform and
/// environment rules instead of assuming the file is always `~/.gitconfig`.
#[tauri::command]
pub async fn get_global_config_path() -> Result<std::path::PathBuf, CommandError> {
    git_ops::config::GlobalConfig::new()
        .path()
        .await
        .map_err(CommandError::from)
}
