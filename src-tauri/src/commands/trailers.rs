//! Commit-message trailers — parsing, merging, and asking git what separates one.
//!
//! `git interpret-trailers` rather than rdc's own parsing, so the answer matches what git will do
//! with the message the user is about to commit.

use crate::commands::CommandError;
use git_ops::interpret_trailers::Trailer;

/// The characters this repository accepts between a trailer's token and its value.
///
/// `trailer.separators` config, defaulting to `:`. Needed before a message can be parsed, since the separator
/// decides what counts as a trailer at all.
#[tauri::command]
pub async fn get_trailer_separator_characters(
    repository_path: String,
) -> Result<String, CommandError> {
    git_ops::interpret_trailers::get_trailer_separator_characters(&repository_path)
        .await
        .map_err(CommandError::from)
}

/// The trailers in a commit message.
///
/// ```js
/// await invoke('parse_trailers', { repositoryPath, commitMessage })
/// // -> [{ token: 'Co-Authored-By', value: 'Someone <someone@example.com>' }]
/// ```
#[tauri::command]
pub async fn parse_trailers(
    repository_path: String,
    commit_message: String,
) -> Result<Vec<Trailer>, CommandError> {
    git_ops::interpret_trailers::parse_trailers(&repository_path, &commit_message)
        .await
        .map_err(CommandError::from)
}

/// A commit message with `trailers` merged into it, as git would write them.
///
/// Asking git rather than concatenating is what gets the blank line, the ordering and the existing trailers
/// right — `interpret-trailers` owns those rules.
#[tauri::command]
pub async fn merge_trailers(
    repository_path: String,
    commit_message: String,
    trailers: Vec<Trailer>,
    unfold: Option<bool>,
) -> Result<String, CommandError> {
    git_ops::interpret_trailers::merge_trailers(
        &repository_path,
        &commit_message,
        &trailers,
        unfold.unwrap_or(false),
    )
    .await
    .map_err(CommandError::from)
}
