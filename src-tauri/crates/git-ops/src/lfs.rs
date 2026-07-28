//! Git LFS installation and attribute queries.
//!
//! Ported from `desktop-plus/app/src/lib/git/lfs.ts`.

use std::path::Path;

use serde::Deserialize;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

#[derive(Deserialize)]
struct LfsTrackOutput {
    patterns: Option<Vec<LfsTrackPattern>>,
}

#[derive(Deserialize)]
struct LfsTrackPattern {
    #[serde(default)]
    tracked: bool,
}

pub async fn install_global_lfs_filters(
    working_directory: impl AsRef<Path>,
    force: bool,
) -> Result<(), GitError> {
    let mut args = vec!["lfs", "install", "--skip-repo"];
    if force {
        args.push("--force");
    }
    git(
        &args,
        working_directory,
        "installGlobalLFSFilter",
        GitOptions::default(),
    )
    .await?;
    Ok(())
}

pub async fn install_lfs_hooks(repository: impl AsRef<Path>, force: bool) -> Result<(), GitError> {
    let mut args = vec!["lfs", "install"];
    if force {
        args.push("--force");
    }
    git(&args, repository, "installLFSHooks", GitOptions::default()).await?;
    Ok(())
}

pub async fn is_using_lfs(repository: impl AsRef<Path>) -> Result<bool, GitError> {
    let output = git(
        &["lfs", "track", "--json"],
        repository,
        "isUsingLFS",
        GitOptions::default().with_env("GIT_LFS_TRACK_NO_INSTALL_HOOKS", "1"),
    )
    .await?;

    let Ok(output) = serde_json::from_slice::<LfsTrackOutput>(&output.stdout) else {
        return Ok(false);
    };
    Ok(output
        .patterns
        .is_some_and(|patterns| patterns.iter().any(|pattern| pattern.tracked)))
}

pub async fn is_tracked_by_lfs(repository: impl AsRef<Path>, path: &str) -> Result<bool, GitError> {
    let output = git(
        &["check-attr", "filter", "--", path],
        repository,
        "checkAttrForLFS",
        GitOptions::default(),
    )
    .await?;
    Ok(output.stdout_lossy().contains(": filter: lfs"))
}

pub async fn files_not_tracked_by_lfs(
    repository: impl AsRef<Path>,
    paths: &[String],
) -> Result<Vec<String>, GitError> {
    let repository = repository.as_ref();
    let mut not_tracked = Vec::new();
    for path in paths {
        if !is_tracked_by_lfs(repository, path).await? {
            not_tracked.push(path.clone());
        }
    }
    Ok(not_tracked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::empty_repository;

    async fn lfs_available(repository: &Path) -> bool {
        git(
            &["lfs", "version"],
            repository,
            "test",
            GitOptions::default(),
        )
        .await
        .is_ok()
    }

    async fn track(repository: &Path, pattern: &str) {
        git(
            &["lfs", "track", pattern],
            repository,
            "test",
            GitOptions::default(),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn detects_whether_any_lfs_pattern_is_configured() {
        let repo = empty_repository().await;
        if !lfs_available(&repo.path()).await {
            return;
        }

        assert!(!is_using_lfs(repo.path()).await.unwrap());
        track(&repo.path(), "*.psd").await;
        assert!(is_using_lfs(repo.path()).await.unwrap());
    }

    #[tokio::test]
    async fn ignores_non_lfs_filters_when_detecting_repository_usage() {
        let repo = empty_repository().await;
        if !lfs_available(&repo.path()).await {
            return;
        }
        std::fs::write(repo.path().join(".git/info/attributes"), "* filter=annex\n").unwrap();

        assert!(!is_using_lfs(repo.path()).await.unwrap());
        track(&repo.path(), "*.psd").await;
        assert!(is_using_lfs(repo.path()).await.unwrap());
    }

    #[tokio::test]
    async fn checks_lfs_attributes_for_unicode_and_nested_paths() {
        let repo = empty_repository().await;
        std::fs::write(
            repo.path().join(".gitattributes"),
            "*.md filter=lfs\napp/src/*.png filter=lfs\n",
        )
        .unwrap();

        assert!(is_tracked_by_lfs(
            repo.path(),
            "Top Ten Worst Repositories - Carlos Martín Nieto.md"
        )
        .await
        .unwrap());
        assert!(is_tracked_by_lfs(repo.path(), "app/src/image.png")
            .await
            .unwrap());
        assert!(!is_tracked_by_lfs(repo.path(), "some-video.mp4")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn filters_out_every_path_tracked_by_lfs() {
        let repo = empty_repository().await;
        std::fs::write(repo.path().join(".gitattributes"), "*.png filter=lfs\n").unwrap();
        let paths = [
            "photo.png".to_owned(),
            "app/src/nested.png".to_owned(),
            "video.mp4".to_owned(),
        ];

        assert_eq!(
            files_not_tracked_by_lfs(repo.path(), &paths).await.unwrap(),
            ["video.mp4"]
        );
    }

    #[tokio::test]
    async fn installs_repository_hooks_when_lfs_is_available() {
        let repo = empty_repository().await;
        if !lfs_available(&repo.path()).await {
            return;
        }

        install_lfs_hooks(repo.path(), false).await.unwrap();
        let hook = std::fs::read_to_string(repo.path().join(".git/hooks/pre-push")).unwrap();
        assert!(hook.contains("git lfs pre-push"));
    }
}
