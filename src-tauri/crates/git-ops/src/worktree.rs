//! Git worktree operations.
//!
//! Ported from `desktop-plus/app/src/lib/git/worktree.ts`.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeType {
    Main,
    Linked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: String,
    pub branch: Option<String>,
    pub is_detached: bool,
    #[serde(rename = "type")]
    pub kind: WorktreeType,
    pub is_locked: bool,
    pub is_prunable: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AddWorktreeOptions<'a> {
    pub create_branch: Option<&'a str>,
    pub commitish: Option<&'a str>,
}

pub fn parse_worktree_porcelain_output(stdout: &str) -> Vec<WorktreeEntry> {
    if stdout.trim().is_empty() {
        return Vec::new();
    }

    stdout
        .strip_suffix('\0')
        .unwrap_or(stdout)
        .split("\0\0")
        .enumerate()
        .map(|(index, block)| {
            let mut entry = WorktreeEntry {
                path: PathBuf::new(),
                head: String::new(),
                branch: None,
                is_detached: false,
                kind: if index == 0 {
                    WorktreeType::Main
                } else {
                    WorktreeType::Linked
                },
                is_locked: false,
                is_prunable: false,
            };

            for field in block.split('\0') {
                if let Some(path) = field.strip_prefix("worktree ") {
                    entry.path = normalize_path(Path::new(path));
                } else if let Some(head) = field.strip_prefix("HEAD ") {
                    entry.head = head.to_owned();
                } else if let Some(branch) = field.strip_prefix("branch ") {
                    entry.branch = Some(branch.to_owned());
                } else if field == "detached" {
                    entry.is_detached = true;
                } else if field == "locked" || field.starts_with("locked ") {
                    entry.is_locked = true;
                } else if field == "prunable" || field.starts_with("prunable ") {
                    entry.is_prunable = true;
                }
            }
            entry
        })
        .collect()
}

pub async fn list_worktrees(repository: impl AsRef<Path>) -> Result<Vec<WorktreeEntry>, GitError> {
    let output = git(
        &["worktree", "list", "--porcelain", "-z"],
        repository,
        "listWorktrees",
        GitOptions::default(),
    )
    .await?;
    Ok(parse_worktree_porcelain_output(&output.stdout_lossy()))
}

pub async fn list_worktrees_from_git_dir(
    git_dir: impl AsRef<Path>,
) -> Result<Vec<WorktreeEntry>, GitError> {
    let git_dir = git_dir.as_ref();
    let args = [
        OsString::from("--git-dir"),
        git_dir.as_os_str().to_owned(),
        OsString::from("worktree"),
        OsString::from("list"),
        OsString::from("--porcelain"),
        OsString::from("-z"),
    ];
    let output = git(
        &args,
        git_dir,
        "listWorktreesFromGitDir",
        GitOptions::default(),
    )
    .await?;
    Ok(parse_worktree_porcelain_output(&output.stdout_lossy()))
}

pub async fn list_worktrees_from_git_dir_fallback(
    git_dir: impl AsRef<Path>,
) -> Result<Vec<WorktreeEntry>, GitError> {
    let common_dir = resolve_common_git_dir(git_dir.as_ref()).await;
    let Some(main_worktree) = common_dir.parent() else {
        return Ok(Vec::new());
    };
    if !tokio::fs::metadata(main_worktree)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
    {
        return Ok(Vec::new());
    }

    Ok(list_worktrees(main_worktree).await.unwrap_or_default())
}

pub async fn add_worktree(
    repository: impl AsRef<Path>,
    path: impl AsRef<Path>,
    options: AddWorktreeOptions<'_>,
) -> Result<(), GitError> {
    let mut args = vec![OsString::from("worktree"), OsString::from("add")];
    if let Some(branch) = options.create_branch {
        args.push(OsString::from("-b"));
        args.push(OsString::from(branch));
    }
    args.push(path.as_ref().as_os_str().to_owned());
    if let Some(commitish) = options.commitish {
        args.push(OsString::from(commitish));
    }

    git(&args, repository, "addWorktree", GitOptions::default()).await?;
    Ok(())
}

pub async fn remove_worktree(
    repository: impl AsRef<Path>,
    worktree: impl AsRef<Path>,
    force: bool,
) -> Result<(), GitError> {
    let mut args = vec![OsString::from("worktree"), OsString::from("remove")];
    if force {
        args.push(OsString::from("--force"));
    }
    args.push(worktree.as_ref().as_os_str().to_owned());
    git(&args, repository, "removeWorktree", GitOptions::default()).await?;
    Ok(())
}

pub async fn move_worktree(
    repository: impl AsRef<Path>,
    old_path: impl AsRef<Path>,
    new_path: impl AsRef<Path>,
) -> Result<(), GitError> {
    let args = [
        OsString::from("worktree"),
        OsString::from("move"),
        old_path.as_ref().as_os_str().to_owned(),
        new_path.as_ref().as_os_str().to_owned(),
    ];
    git(&args, repository, "moveWorktree", GitOptions::default()).await?;
    Ok(())
}

async fn resolve_common_git_dir(git_dir: &Path) -> PathBuf {
    let is_linked_admin_dir = git_dir
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "worktrees");
    if !is_linked_admin_dir {
        return git_dir.to_owned();
    }

    let conventional = git_dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or(git_dir)
        .to_owned();
    let Ok(contents) = tokio::fs::read_to_string(git_dir.join("commondir")).await else {
        return conventional;
    };
    let relative = contents
        .strip_suffix("\r\n")
        .or_else(|| contents.strip_suffix('\n'))
        .unwrap_or(&contents);
    if relative.is_empty() {
        conventional
    } else {
        normalize_path(&git_dir.join(relative))
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
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    #[test]
    fn parses_empty_output() {
        assert!(parse_worktree_porcelain_output("").is_empty());
        assert!(parse_worktree_porcelain_output("  \n  ").is_empty());
    }

    #[test]
    fn parses_nul_delimited_worktrees_and_all_flags() {
        let output = [
            [
                "worktree /path/to/main repo",
                "HEAD abc123",
                "branch refs/heads/main",
            ]
            .join("\0"),
            [
                "worktree /path/to/linked\nrepo",
                "HEAD def456",
                "detached",
                "locked a reason",
                "prunable gitdir file is stale",
            ]
            .join("\0"),
        ]
        .join("\0\0")
            + "\0";

        let entries = parse_worktree_porcelain_output(&output);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, Path::new("/path/to/main repo"));
        assert_eq!(entries[0].branch.as_deref(), Some("refs/heads/main"));
        assert_eq!(entries[0].kind, WorktreeType::Main);
        assert!(!entries[0].is_detached);
        assert_eq!(entries[1].path, Path::new("/path/to/linked\nrepo"));
        assert_eq!(entries[1].branch, None);
        assert_eq!(entries[1].kind, WorktreeType::Linked);
        assert!(entries[1].is_detached);
        assert!(entries[1].is_locked);
        assert!(entries[1].is_prunable);
    }

    #[tokio::test]
    async fn lists_main_linked_and_detached_worktrees() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README", "hello\n", "base");
        git(
            &["branch", "feature"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .unwrap();
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");
        let detached = parent.path().join("detached");
        add_worktree(
            repo.path(),
            &linked,
            AddWorktreeOptions {
                commitish: Some("feature"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        add_worktree(
            repo.path(),
            &detached,
            AddWorktreeOptions {
                commitish: Some("HEAD"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let detached = std::fs::canonicalize(detached).unwrap();

        let entries = list_worktrees(repo.path()).await.unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].kind, WorktreeType::Main);
        assert!(entries
            .iter()
            .any(|entry| entry.branch.as_deref() == Some("refs/heads/feature")));
        assert!(entries.iter().any(|entry| entry.path == detached));
    }

    #[tokio::test]
    async fn lists_from_a_linked_git_dir_after_its_worktree_is_deleted() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README", "hello\n", "base");
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");
        add_worktree(
            repo.path(),
            &linked,
            AddWorktreeOptions {
                create_branch: Some("feature"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let git_dir = git(
            &["rev-parse", "--absolute-git-dir"],
            &linked,
            "test",
            GitOptions::default(),
        )
        .await
        .unwrap()
        .stdout_trimmed();
        let linked = std::fs::canonicalize(linked).unwrap();
        std::fs::remove_dir_all(&linked).unwrap();

        let entries = list_worktrees_from_git_dir(&git_dir).await.unwrap();
        assert_eq!(entries[0].kind, WorktreeType::Main);
        assert!(entries
            .iter()
            .any(|entry| entry.path == linked && entry.is_prunable));
    }

    #[tokio::test]
    async fn fallback_finds_the_main_worktree_after_admin_files_disappear() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README", "hello\n", "base");
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");
        add_worktree(
            repo.path(),
            &linked,
            AddWorktreeOptions {
                create_branch: Some("feature"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let git_dir = git(
            &["rev-parse", "--absolute-git-dir"],
            &linked,
            "test",
            GitOptions::default(),
        )
        .await
        .unwrap()
        .stdout_trimmed();
        remove_worktree(repo.path(), &linked, true).await.unwrap();

        let entries = list_worktrees_from_git_dir_fallback(&git_dir)
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, WorktreeType::Main);
    }

    #[tokio::test]
    async fn creates_moves_and_removes_a_worktree() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README", "hello\n", "base");
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        let moved = parent.path().join("moved");

        add_worktree(
            repo.path(),
            &original,
            AddWorktreeOptions {
                create_branch: Some("feature"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        move_worktree(repo.path(), &original, &moved).await.unwrap();
        assert!(moved.join("README").is_file());
        remove_worktree(repo.path(), &moved, false).await.unwrap();
        assert!(!moved.exists());
    }
}
