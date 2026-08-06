use serde::Serialize;
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderOpenAction {
    Open,
    Reveal,
}

pub async fn classify_folder_open(path: &Path) -> io::Result<Option<FolderOpenAction>> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    if !metadata.is_dir() {
        return Ok(Some(FolderOpenAction::Reveal));
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(Some(match is_macos_application_bundle(path).await {
            Ok(false) => FolderOpenAction::Open,
            // Uncertain metadata is treated as executable, matching upstream's
            // deliberately conservative Finder behavior.
            Ok(true) | Err(_) => FolderOpenAction::Reveal,
        }));
    }

    #[cfg(not(target_os = "macos"))]
    Ok(Some(FolderOpenAction::Open))
}

pub fn move_to_trash(path: &Path) -> Result<(), trash::Error> {
    trash::delete(path)
}

/// Resolves a repository-relative path to an absolute one, refusing anything that leaves the
/// repository.
///
/// Shared by the delete and trash paths so both get the same guarantees. It was originally inline in
/// `permanently_delete_repository_path`, and the trash path had none of it — it took an absolute
/// path already joined by the caller, so nothing stopped a bad relative path from reaching `trash`.
async fn resolve_contained_path(repository: &Path, relative_path: &Path) -> io::Result<PathBuf> {
    use std::path::Component;

    let mut components = relative_path.components();
    let Some(Component::Normal(first)) = components.next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "repository path must be a non-empty relative path",
        ));
    };
    if first
        .to_str()
        .is_some_and(|component| component.eq_ignore_ascii_case(".git"))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "repository path may not target .git or escape the repository",
        ));
    }

    let target = repository.join(relative_path);
    let canonical_repository = tokio::fs::canonicalize(repository).await?;
    let canonical_parent = tokio::fs::canonicalize(
        target
            .parent()
            .ok_or_else(|| io::Error::other("repository path has no parent"))?,
    )
    .await?;
    if !canonical_parent.starts_with(&canonical_repository) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "repository path escapes through a symbolic link",
        ));
    }
    Ok(target)
}

pub async fn permanently_delete_repository_path(
    repository: &Path,
    relative_path: &Path,
) -> io::Result<()> {
    let target = resolve_contained_path(repository, relative_path).await?;
    let metadata = tokio::fs::symlink_metadata(&target).await?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        tokio::fs::remove_dir_all(target).await
    } else {
        tokio::fs::remove_file(target).await
    }
}

/// One path's failure within a batch, named so the caller can say which path failed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathFailure {
    /// The repository-relative path as the caller supplied it.
    pub path: String,
    pub message: String,
}

/// Moves many repository-relative paths to the OS trash in one call.
///
/// Returns the paths that failed rather than erroring on the first one. A discard is a three-part
/// operation — trash, reset, check out — and stopping halfway through the first part used to leave
/// the working tree with files removed and no git state updated to match. Reporting failures lets
/// the caller finish the remaining parts for the paths that did succeed.
///
/// Missing paths are **not** failures. git reports a file as changed from a status read that may be
/// moments old, and a path already gone is the state the trash call was trying to reach.
pub async fn move_repository_paths_to_trash(
    repository: &Path,
    relative_paths: &[String],
) -> Vec<PathFailure> {
    let mut failures = Vec::new();
    let mut resolved = Vec::with_capacity(relative_paths.len());

    for relative_path in relative_paths {
        match resolve_contained_path(repository, Path::new(relative_path)).await {
            Ok(target) => resolved.push((relative_path.clone(), target)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => failures.push(PathFailure {
                path: relative_path.clone(),
                message: error.to_string(),
            }),
        }
    }

    // One spawn_blocking for the whole batch: `trash::delete` blocks, and paying the thread-hop
    // per path is what made this expensive at scale.
    let trashed = tauri::async_runtime::spawn_blocking(move || {
        let mut failures = Vec::new();
        for (relative_path, target) in resolved {
            if !target.try_exists().unwrap_or(true) {
                continue;
            }
            if let Err(error) = move_to_trash(&target) {
                failures.push(PathFailure {
                    path: relative_path,
                    message: error.to_string(),
                });
            }
        }
        failures
    })
    .await;

    match trashed {
        Ok(mut trash_failures) => failures.append(&mut trash_failures),
        Err(error) => failures.push(PathFailure {
            path: String::new(),
            message: format!("trash task failed: {error}"),
        }),
    }
    failures
}

/// Permanently deletes many repository-relative paths in one call, reporting per-path failures.
///
/// Same rationale as [`move_repository_paths_to_trash`], including treating a missing path as
/// already done.
pub async fn permanently_delete_repository_paths(
    repository: &Path,
    relative_paths: &[String],
) -> Vec<PathFailure> {
    let mut failures = Vec::new();
    for relative_path in relative_paths {
        match permanently_delete_repository_path(repository, Path::new(relative_path)).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => failures.push(PathFailure {
                path: relative_path.clone(),
                message: error.to_string(),
            }),
        }
    }
    failures
}

#[cfg(target_os = "macos")]
async fn is_macos_application_bundle(path: &Path) -> io::Result<bool> {
    let output = tokio::process::Command::new("/usr/bin/mdls")
        .args([
            "-name",
            "kMDItemContentType",
            "-name",
            "kMDItemContentTypeTree",
        ])
        .arg(path)
        .output()
        .await?;

    if !output.status.success() {
        return Err(io::Error::other("mdls could not read path metadata"));
    }

    Ok(parse_macos_bundle_metadata(&output.stdout))
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_bundle_metadata(output: &[u8]) -> bool {
    const EXECUTABLE_TYPES: [&str; 3] = [
        "com.apple.application-bundle",
        "com.apple.application",
        "public.executable",
    ];
    let output = String::from_utf8_lossy(output);
    EXECUTABLE_TYPES
        .iter()
        .any(|identifier| output.contains(&format!("\"{identifier}\"")))
}

#[cfg(test)]
mod tests {
    use super::{
        classify_folder_open, move_to_trash, parse_macos_bundle_metadata,
        permanently_delete_repository_path, permanently_delete_repository_paths, FolderOpenAction,
    };
    use std::path::Path;
    use tempfile::tempdir;

    #[tokio::test]
    async fn missing_paths_have_no_folder_action() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            classify_folder_open(&directory.path().join("missing"))
                .await
                .expect("classification"),
            None
        );
    }

    #[tokio::test]
    async fn files_are_revealed_instead_of_opened() {
        let directory = tempdir().expect("temporary directory");
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "content").expect("write file");

        assert_eq!(
            classify_folder_open(&file).await.expect("classification"),
            Some(FolderOpenAction::Reveal)
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn ordinary_directories_are_opened() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            classify_folder_open(directory.path())
                .await
                .expect("classification"),
            Some(FolderOpenAction::Open)
        );
    }

    #[test]
    fn recognizes_every_executable_macos_metadata_marker() {
        for identifier in [
            "com.apple.application-bundle",
            "com.apple.application",
            "public.executable",
        ] {
            assert!(parse_macos_bundle_metadata(
                format!("kMDItemContentType = \"{identifier}\"").as_bytes()
            ));
        }
        assert!(!parse_macos_bundle_metadata(
            b"kMDItemContentType = \"public.directory\""
        ));
    }

    #[test]
    fn trash_reports_a_missing_target_without_deleting_anything() {
        let directory = tempdir().expect("temporary directory");

        assert!(move_to_trash(&directory.path().join("missing")).is_err());
        assert!(directory.path().exists());
    }

    #[tokio::test]
    async fn permanently_deletes_only_relative_repository_contents() {
        let directory = tempdir().expect("temporary directory");
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).expect("create nested directory");
        std::fs::write(nested.join("file.txt"), "content").expect("write file");

        permanently_delete_repository_path(directory.path(), Path::new("nested"))
            .await
            .expect("delete nested directory");

        assert!(!nested.exists());
        assert!(directory.path().exists());
    }

    #[tokio::test]
    async fn permanent_delete_rejects_repository_escape_and_git_metadata() {
        let directory = tempdir().expect("temporary directory");
        let git = directory.path().join(".git");
        std::fs::create_dir(&git).expect("create git directory");
        std::fs::write(git.join("sentinel"), "keep").expect("write sentinel");

        for unsafe_path in ["", "..", "../outside", "/tmp/outside", ".git/sentinel"] {
            assert!(
                permanently_delete_repository_path(directory.path(), Path::new(unsafe_path))
                    .await
                    .is_err(),
                "{unsafe_path:?} should be rejected"
            );
        }

        assert!(git.join("sentinel").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn permanent_delete_rejects_a_symlinked_parent_escape() {
        let directory = tempdir().expect("temporary directory");
        let outside = tempdir().expect("outside directory");
        let sentinel = outside.path().join("sentinel");
        std::fs::write(&sentinel, "keep").expect("write sentinel");
        std::os::unix::fs::symlink(outside.path(), directory.path().join("link"))
            .expect("create symlink");

        assert!(
            permanently_delete_repository_path(directory.path(), Path::new("link/sentinel"))
                .await
                .is_err()
        );
        assert!(sentinel.exists());
    }

    #[tokio::test]
    async fn a_batch_delete_reports_each_failure_and_removes_the_rest() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("one.txt"), "one").unwrap();
        std::fs::write(directory.path().join("two.txt"), "two").unwrap();

        // ".git" and an escape are refused per path rather than aborting the batch, so the valid
        // paths either side of them are still removed.
        let failures = permanently_delete_repository_paths(
            directory.path(),
            &[
                "one.txt".to_owned(),
                ".git/config".to_owned(),
                "../escape.txt".to_owned(),
                "two.txt".to_owned(),
            ],
        )
        .await;

        let failed: Vec<&str> = failures
            .iter()
            .map(|failure| failure.path.as_str())
            .collect();
        assert_eq!(failed, vec![".git/config", "../escape.txt"]);
        assert!(!directory.path().join("one.txt").exists());
        assert!(!directory.path().join("two.txt").exists());
    }

    #[tokio::test]
    async fn a_batch_delete_treats_an_already_missing_path_as_done() {
        let directory = tempfile::tempdir().unwrap();

        // git reports changes from a status read that may be moments old, so a path that has since
        // gone is the state the call was trying to reach — not an error to surface.
        let failures =
            permanently_delete_repository_paths(directory.path(), &["gone.txt".to_owned()]).await;

        assert!(failures.is_empty());
    }

    #[tokio::test]
    async fn an_empty_batch_delete_is_a_noop() {
        let directory = tempfile::tempdir().unwrap();
        assert!(permanently_delete_repository_paths(directory.path(), &[])
            .await
            .is_empty());
    }
}
