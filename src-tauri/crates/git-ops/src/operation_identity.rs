//! Stable native identities used to scope repository operations.
//!
//! The displayed repository path is deliberately kept lexical. Lock keys are different: they
//! may be canonicalized so a symlinked path and its real path converge without changing what the
//! user sees in the repository list.

use std::path::{Component, Path, PathBuf};

use crate::error::GitError;
use crate::rev_parse::{get_repository_type, resolve_git_dir, RepositoryType};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryIdentity {
    pub top_level_working_directory: PathBuf,
    pub worktree_git_directory: PathBuf,
    pub common_git_directory: PathBuf,
    pub lock_key: PathBuf,
}

/// Resolves the repository identity used by the operation registry.
pub async fn resolve_repository_identity(
    path: impl AsRef<Path>,
) -> Result<Option<RepositoryIdentity>, GitError> {
    let path = path.as_ref();
    let RepositoryType::Regular {
        top_level_working_directory,
        ..
    } = get_repository_type(path).await?
    else {
        return Ok(None);
    };

    let worktree_git_directory = resolve_git_dir(path).await?;
    let common_git_directory = resolve_common_git_directory(&worktree_git_directory).await;
    let lock_key = canonical_or_lexical(&common_git_directory);

    Ok(Some(RepositoryIdentity {
        top_level_working_directory,
        worktree_git_directory,
        common_git_directory,
        lock_key,
    }))
}

/// Returns a stable lock key for a clone destination, including when it does not exist yet.
pub fn clone_destination_lock_key(path: impl AsRef<Path>) -> PathBuf {
    canonical_or_lexical(&absolute_lexical(path.as_ref()))
}

async fn resolve_common_git_directory(git_directory: &Path) -> PathBuf {
    let is_linked_worktree = git_directory
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "worktrees");
    if !is_linked_worktree {
        return git_directory.to_owned();
    }

    let conventional = git_directory
        .parent()
        .and_then(Path::parent)
        .unwrap_or(git_directory)
        .to_owned();
    let Ok(contents) = tokio::fs::read_to_string(git_directory.join("commondir")).await else {
        return conventional;
    };
    let relative = contents.trim_end_matches(['\r', '\n']);
    if relative.is_empty() {
        conventional
    } else {
        lexical_normalize(&git_directory.join(relative))
    }
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| absolute_lexical(path))
}

fn absolute_lexical(path: &Path) -> PathBuf {
    if path.is_absolute() {
        lexical_normalize(path)
    } else {
        let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        lexical_normalize(&base.join(path))
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !path.has_root() {
                    normalized.push(component);
                }
            }
            other => normalized.push(other),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn root_and_subdirectory_share_the_same_identity() {
        let repository = empty_repository().await;
        commit_file(&repository.path(), "file", "contents", "initial");
        let nested = repository.path().join("nested");
        std::fs::create_dir(&nested).expect("nested directory should be created");

        let root = resolve_repository_identity(repository.path())
            .await
            .expect("root should resolve")
            .expect("root should be a repository");
        let subdirectory = resolve_repository_identity(nested)
            .await
            .expect("subdirectory should resolve")
            .expect("subdirectory should be a repository");

        assert_eq!(root.lock_key, subdirectory.lock_key);
        assert_eq!(root.common_git_directory, subdirectory.common_git_directory);
        assert_eq!(
            root.top_level_working_directory,
            subdirectory.top_level_working_directory
        );
    }

    #[tokio::test]
    async fn linked_worktrees_share_the_common_lock_but_keep_distinct_git_directories() {
        let repository = empty_repository().await;
        commit_file(&repository.path(), "file", "contents", "initial");
        let linked_parent = tempfile::tempdir().expect("linked-worktree parent should be created");
        let linked = linked_parent.path().join("linked-worktree");
        git(
            &[
                "worktree",
                "add",
                "-b",
                "linked",
                linked.to_str().expect("utf-8 path"),
                "HEAD",
            ],
            repository.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("linked worktree should be created");

        let main = resolve_repository_identity(repository.path())
            .await
            .expect("main should resolve")
            .expect("main should be a repository");
        let linked_identity = resolve_repository_identity(&linked)
            .await
            .expect("linked worktree should resolve")
            .expect("linked worktree should be a repository");

        assert_eq!(main.lock_key, linked_identity.lock_key);
        assert_ne!(
            main.worktree_git_directory,
            linked_identity.worktree_git_directory
        );
    }

    #[tokio::test]
    async fn separate_repositories_have_distinct_lock_keys() {
        let first = empty_repository().await;
        let second = empty_repository().await;

        let first_identity = resolve_repository_identity(first.path())
            .await
            .expect("first should resolve")
            .expect("first should be a repository");
        let second_identity = resolve_repository_identity(second.path())
            .await
            .expect("second should resolve")
            .expect("second should be a repository");

        assert_ne!(first_identity.lock_key, second_identity.lock_key);
    }

    #[test]
    fn normalizes_a_missing_clone_destination_without_canonicalizing_its_parent() {
        let path = PathBuf::from("target/../new-repository");
        let key = clone_destination_lock_key(&path);
        assert_eq!(key, std::env::current_dir().unwrap().join("new-repository"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_repository_paths_share_a_canonical_lock_key() {
        use std::os::unix::fs::symlink;

        let repository = empty_repository().await;
        commit_file(&repository.path(), "file", "contents", "initial");
        let link_parent = tempfile::tempdir().expect("symlink parent should be created");
        let link = link_parent.path().join("repository-link");
        symlink(repository.path(), &link).expect("repository symlink should be created");

        let real = resolve_repository_identity(repository.path())
            .await
            .expect("real path should resolve")
            .expect("real path should be a repository");
        let linked = resolve_repository_identity(link)
            .await
            .expect("symlink path should resolve")
            .expect("symlink path should be a repository");

        assert_eq!(real.lock_key, linked.lock_key);
    }
}
