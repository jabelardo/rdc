//! Reading and writing the repository-root `.gitignore`.
//!
//! Ported from `desktop-plus/app/src/lib/git/gitignore.ts`.

use std::path::Path;

use crate::config::get_config_value;
use crate::error::GitError;

pub async fn read_gitignore_at_root(
    repository: impl AsRef<Path>,
) -> Result<Option<String>, GitError> {
    let path = repository.as_ref().join(".gitignore");
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => Ok(Some(contents)),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(file_error("readGitIgnoreAtRoot", path, source)),
    }
}

pub async fn save_gitignore(repository: impl AsRef<Path>, text: &str) -> Result<(), GitError> {
    let repository = repository.as_ref();
    let path = repository.join(".gitignore");

    if text.is_empty() {
        return tokio::fs::remove_file(&path)
            .await
            .map_err(|source| file_error("saveGitIgnore", path, source));
    }

    let contents = format_gitignore_contents(repository, text).await?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|source| file_error("saveGitIgnore", path, source))
}

pub async fn append_ignore_rules<T: AsRef<str>>(
    repository: impl AsRef<Path>,
    patterns: &[T],
) -> Result<(), GitError> {
    let repository = repository.as_ref();
    let current = read_gitignore_at_root(repository)
        .await?
        .unwrap_or_default();
    let current = format_gitignore_contents(repository, &current).await?;
    let patterns = patterns
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join("\n");
    let combined = format!("{current}{patterns}");
    let combined = format_gitignore_contents(repository, &combined).await?;
    save_gitignore(repository, &combined).await
}

pub async fn append_ignore_files<T: AsRef<str>>(
    repository: impl AsRef<Path>,
    paths: &[T],
) -> Result<(), GitError> {
    let escaped = paths
        .iter()
        .map(|path| escape_git_special_characters(path.as_ref()))
        .collect::<Vec<_>>();
    append_ignore_rules(repository, &escaped).await
}

pub fn escape_git_special_characters(pattern: &str) -> String {
    let mut escaped = String::with_capacity(pattern.len());
    for character in pattern.chars() {
        if matches!(character, '[' | ']' | '!' | '*' | '#' | '?') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

async fn format_gitignore_contents(repository: &Path, text: &str) -> Result<String, GitError> {
    let autocrlf = get_config_value(repository, "core.autocrlf", false).await?;
    let safecrlf = get_config_value(repository, "core.safecrlf", false).await?;

    if autocrlf.as_deref() == Some("true") && safecrlf.as_deref() == Some("true") {
        return Ok(format!("{}\r\n", normalize_line_endings_to_crlf(text)));
    }
    if text.is_empty() || text.ends_with('\n') {
        return Ok(text.to_owned());
    }
    if autocrlf.is_none() || autocrlf.as_deref() == Some("true") {
        return Ok(format!("{text}\n"));
    }
    Ok(format!("{text}\r\n"))
}

fn normalize_line_endings_to_crlf(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if matches!(character, '\r' | '\n') {
            if characters
                .peek()
                .is_some_and(|next| matches!((character, *next), ('\r', '\n') | ('\n', '\r')))
            {
                characters.next();
            }
            normalized.push_str("\r\n");
        } else {
            normalized.push(character);
        }
    }
    normalized
}

fn file_error(name: &str, path: std::path::PathBuf, source: std::io::Error) -> GitError {
    GitError::Spawn {
        name: name.to_owned(),
        path,
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::set_config_value;
    use crate::exec::{git, GitOptions};
    use crate::test_support::empty_repository;

    #[tokio::test]
    async fn missing_file_reads_as_none_and_saved_content_round_trips() {
        let repo = empty_repository().await;
        assert_eq!(read_gitignore_at_root(repo.path()).await.unwrap(), None);

        save_gitignore(repo.path(), "node_modules\n").await.unwrap();
        assert_eq!(
            read_gitignore_at_root(repo.path())
                .await
                .unwrap()
                .as_deref(),
            Some("node_modules\n")
        );
    }

    #[tokio::test]
    async fn saving_empty_content_removes_the_file() {
        let repo = empty_repository().await;
        save_gitignore(repo.path(), "node_modules\n").await.unwrap();
        save_gitignore(repo.path(), "").await.unwrap();
        assert_eq!(read_gitignore_at_root(repo.path()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn saved_rules_are_obeyed_by_git() {
        let repo = empty_repository().await;
        save_gitignore(repo.path(), "*.txt\n").await.unwrap();
        std::fs::write(repo.path().join("ignored.txt"), "ignored").unwrap();

        let output = git(
            &["status", "--short", "--untracked-files=all"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .unwrap();
        assert!(!output.stdout_lossy().contains("ignored.txt"));
    }

    #[test]
    fn escapes_every_gitignore_metacharacter_but_not_a_backslash() {
        assert_eq!(
            escape_git_special_characters("[never]\\!gonna*give#you?_.up"),
            "\\[never\\]\\\\!gonna\\*give\\#you\\?_.up"
        );
    }

    #[tokio::test]
    async fn appends_one_or_several_rules_and_escapes_file_names() {
        let repo = empty_repository().await;
        set_config_value(repo.path(), "core.autocrlf", "true")
            .await
            .unwrap();
        set_config_value(repo.path(), "core.safecrlf", "false")
            .await
            .unwrap();
        save_gitignore(repo.path(), "node_modules\n").await.unwrap();
        append_ignore_rules(repo.path(), &["yarn-error.log", ".eslintcache", "dist/"])
            .await
            .unwrap();
        append_ignore_files(repo.path(), &["[never]!gonna*give#you?_.up"])
            .await
            .unwrap();

        assert_eq!(
            read_gitignore_at_root(repo.path()).await.unwrap().unwrap(),
            "node_modules\nyarn-error.log\n.eslintcache\ndist/\n\
             \\[never\\]\\!gonna\\*give\\#you\\?_.up\n"
        );
    }

    #[tokio::test]
    async fn autocrlf_and_safecrlf_normalize_to_crlf_and_append_a_terminator() {
        let repo = empty_repository().await;
        set_config_value(repo.path(), "core.autocrlf", "true")
            .await
            .unwrap();
        set_config_value(repo.path(), "core.safecrlf", "true")
            .await
            .unwrap();

        save_gitignore(repo.path(), "one\ntwo").await.unwrap();
        assert_eq!(
            read_gitignore_at_root(repo.path()).await.unwrap().unwrap(),
            "one\r\ntwo\r\n"
        );
    }
}
