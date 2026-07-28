//! The repository description file.
//!
//! Ported from `desktop-plus/app/src/lib/git/description.ts`.

use std::path::{Path, PathBuf};

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// What `git init` writes into `description`.
///
/// Treated as "no description", because it is a placeholder rather than something a user chose.
pub const DEFAULT_DESCRIPTION: &str =
    "Unnamed repository; edit this file 'description' to name the repository.\n";

/// Reads the repository's description, or an empty string if it has none.
///
/// # A path fix
///
/// The original joined `<repository>/.git/description`. That only works for an ordinary repository: in a
/// **linked worktree** or a **submodule** `.git` is a *file* pointing elsewhere, so the path doesn't
/// exist — and the original silently returned `""` because a read failure meant "no description".
///
/// Verified against real git: the file lives in the **common** directory, which
/// `rev-parse --git-common-dir` reports. Note `--absolute-git-dir` is *not* the right question — in a
/// worktree that points at `.git/worktrees/<name>`, which has no `description`.
///
/// A missing or unreadable file is still an empty string, as upstream: a repository without a
/// description is the normal case, not a failure.
pub async fn get_description(repository: impl AsRef<Path>) -> Result<String, GitError> {
    let path = description_path(repository.as_ref()).await?;

    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Ok(String::new());
    };

    if contents == DEFAULT_DESCRIPTION {
        return Ok(String::new());
    }

    Ok(contents)
}

/// Writes the repository's description.
pub async fn write_description(
    repository: impl AsRef<Path>,
    description: &str,
) -> Result<(), GitError> {
    let path = description_path(repository.as_ref()).await?;

    std::fs::write(&path, description).map_err(|source| GitError::Spawn {
        name: "writeGitDescription".to_owned(),
        path,
        source,
    })
}

/// Where the description file lives for this repository.
async fn description_path(repository: &Path) -> Result<PathBuf, GitError> {
    let output = git(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        repository,
        "gitDescriptionPath",
        GitOptions::default(),
    )
    .await?;

    Ok(PathBuf::from(output.stdout_trimmed()).join("description"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[tokio::test]
    async fn treats_the_default_placeholder_as_no_description() {
        // `git init` writes it, so it is not something the user chose.
        let repo = empty_repository().await;
        let path = description_path(&repo.path())
            .await
            .expect("should resolve");
        std::fs::write(&path, DEFAULT_DESCRIPTION).expect("failed to write");

        assert_eq!(
            get_description(repo.path()).await.expect("should succeed"),
            ""
        );
    }

    #[tokio::test]
    async fn reads_a_description_the_user_set() {
        let repo = empty_repository().await;
        write_description(repo.path(), "my project\n")
            .await
            .expect("writing should succeed");

        assert_eq!(
            get_description(repo.path()).await.expect("should succeed"),
            "my project\n"
        );
    }

    #[tokio::test]
    async fn reports_no_description_when_the_file_is_missing() {
        let repo = empty_repository().await;
        let path = description_path(&repo.path())
            .await
            .expect("should resolve");
        let _ = std::fs::remove_file(&path);

        assert_eq!(
            get_description(repo.path()).await.expect("should succeed"),
            ""
        );
    }

    #[tokio::test]
    async fn finds_the_description_from_inside_a_linked_worktree() {
        // The path fix. In a worktree `.git` is a file, so `<repo>/.git/description` isn't a path at
        // all — and `--absolute-git-dir` points at `.git/worktrees/<name>`, which has no description.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        write_description(repo.path(), "shared description\n")
            .await
            .expect("writing should succeed");

        // Inside its own temp directory, not `repo/../worktree`: the latter resolves into the *shared*
        // system temp directory, so parallel tests — and leftovers from a previous run — collide.
        let container = tempfile::tempdir().expect("failed to create a temporary directory");
        let worktree = container.path().join("linked");
        git(
            &["worktree", "add", "-b", "wt", &worktree.to_string_lossy()],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("worktree add should succeed");

        assert_eq!(
            get_description(&worktree).await.expect("should succeed"),
            "shared description\n",
            "the description comes from the common directory"
        );
    }
}
