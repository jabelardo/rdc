//! Copying selected ignored files into a newly created worktree.
//!
//! Ported from `desktop-plus/app/src/lib/git/worktree-include.ts`.

use std::path::{Component, Path, PathBuf};

use ignore::gitignore::GitignoreBuilder;

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::worktree::{add_worktree, AddWorktreeOptions};

const WORKTREE_INCLUDE_FILE: &str = ".worktreeinclude";

pub async fn read_worktree_include_patterns(repository: impl AsRef<Path>) -> Vec<String> {
    let Ok(contents) =
        tokio::fs::read_to_string(repository.as_ref().join(WORKTREE_INCLUDE_FILE)).await
    else {
        return Vec::new();
    };

    contents
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

pub async fn get_ignored_files_matching_patterns(
    repository: impl AsRef<Path>,
    patterns: &[String],
) -> Result<Vec<String>, GitError> {
    if patterns.is_empty() {
        return Ok(Vec::new());
    }

    let repository = repository.as_ref();
    let output = git(
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        repository,
        "getIgnoredFiles",
        GitOptions::default(),
    )
    .await?;

    let mut builder = GitignoreBuilder::new(repository);
    for pattern in patterns {
        builder
            .add_line(None, pattern)
            .map_err(|error| GitError::Parse {
                context: "worktree include pattern".to_owned(),
                message: error.to_string(),
            })?;
    }
    let matcher = builder.build().map_err(|error| GitError::Parse {
        context: "worktree include patterns".to_owned(),
        message: error.to_string(),
    })?;

    Ok(output
        .stdout_lossy()
        .split('\0')
        .filter(|path| !path.is_empty())
        .filter(|path| {
            matcher
                .matched_path_or_any_parents(repository.join(path), false)
                .is_ignore()
        })
        .map(str::to_owned)
        .collect())
}

pub async fn copy_worktree_include_files(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    files: &[String],
) {
    let source = source.as_ref();
    let Ok(destination) = absolute_lexical(destination.as_ref()) else {
        return;
    };

    for file in files {
        let resolved_destination = normalize_path(&destination.join(file));
        if resolved_destination == destination || !resolved_destination.starts_with(&destination) {
            continue;
        }
        let source_file = source.join(file);
        if !tokio::fs::metadata(&source_file)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            continue;
        }
        let Some(parent) = resolved_destination.parent() else {
            continue;
        };
        if tokio::fs::create_dir_all(parent).await.is_err() {
            continue;
        }
        let _ = tokio::fs::copy(source_file, resolved_destination).await;
    }
}

pub async fn add_worktree_with_includes(
    repository: impl AsRef<Path>,
    path: impl AsRef<Path>,
    options: AddWorktreeOptions<'_>,
) -> Result<(), GitError> {
    let repository = repository.as_ref().to_owned();
    let path = path.as_ref().to_owned();
    add_worktree(&repository, &path, options).await?;

    let patterns = read_worktree_include_patterns(&repository).await;
    if patterns.is_empty() {
        return Ok(());
    }
    let Ok(files) = get_ignored_files_matching_patterns(&repository, &patterns).await else {
        return Ok(());
    };
    if !files.is_empty() {
        copy_worktree_include_files(repository, path, &files).await;
    }
    Ok(())
}

fn absolute_lexical(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(normalize_path(path))
    } else {
        Ok(normalize_path(&std::env::current_dir()?.join(path)))
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn reads_patterns_while_skipping_comments_and_blanks() {
        let directory = tempfile::tempdir().unwrap();
        assert!(read_worktree_include_patterns(directory.path())
            .await
            .is_empty());
        std::fs::write(
            directory.path().join(".worktreeinclude"),
            "# comment\n\n.env\n config/*.json \n",
        )
        .unwrap();

        assert_eq!(
            read_worktree_include_patterns(directory.path()).await,
            [".env", "config/*.json"]
        );
    }

    #[tokio::test]
    async fn returns_only_ignored_files_matching_gitignore_patterns() {
        let repo = empty_repository().await;
        commit_file(
            &repo.path(),
            ".gitignore",
            ".env\nconfig/*.json\n",
            "ignore files",
        );
        std::fs::create_dir(repo.path().join("config")).unwrap();
        std::fs::write(repo.path().join(".env"), "secret").unwrap();
        std::fs::write(repo.path().join("config/secret.json"), "{}").unwrap();
        std::fs::write(repo.path().join("config/other.txt"), "other").unwrap();

        let files = get_ignored_files_matching_patterns(
            repo.path(),
            &[".env".to_owned(), "config/*.json".to_owned()],
        )
        .await
        .unwrap();
        assert_eq!(files, [".env", "config/secret.json"]);
    }

    #[tokio::test]
    async fn empty_patterns_are_a_noop_even_outside_a_repository() {
        let directory = tempfile::tempdir().unwrap();
        assert!(get_ignored_files_matching_patterns(directory.path(), &[])
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn copies_structure_and_skips_missing_or_traversing_paths() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        std::fs::create_dir(source.path().join("config")).unwrap();
        std::fs::write(source.path().join(".env"), "secret").unwrap();
        std::fs::write(source.path().join("config/settings.json"), "{}").unwrap();

        copy_worktree_include_files(
            source.path(),
            destination.path(),
            &[
                ".env".to_owned(),
                "config/settings.json".to_owned(),
                "missing".to_owned(),
                "../../../etc/passwd".to_owned(),
            ],
        )
        .await;

        assert_eq!(
            std::fs::read_to_string(destination.path().join(".env")).unwrap(),
            "secret"
        );
        assert_eq!(
            std::fs::read_to_string(destination.path().join("config/settings.json")).unwrap(),
            "{}"
        );
        assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn creates_a_worktree_and_copies_matching_ignored_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), ".gitignore", ".env\n*.log\n", "ignore");
        std::fs::write(repo.path().join(".worktreeinclude"), ".env\n").unwrap();
        std::fs::write(repo.path().join(".env"), "secret").unwrap();
        std::fs::write(repo.path().join("debug.log"), "skip").unwrap();
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");

        add_worktree_with_includes(
            repo.path(),
            &linked,
            AddWorktreeOptions {
                create_branch: Some("feature"),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(linked.join(".env")).unwrap(),
            "secret"
        );
        assert!(!linked.join("debug.log").exists());
    }
}
