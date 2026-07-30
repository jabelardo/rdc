use serde::Serialize;
use std::{io, path::Path};

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

pub async fn permanently_delete_repository_path(
    repository: &Path,
    relative_path: &Path,
) -> io::Result<()> {
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
    let metadata = tokio::fs::symlink_metadata(&target).await?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        tokio::fs::remove_dir_all(target).await
    } else {
        tokio::fs::remove_file(target).await
    }
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
        permanently_delete_repository_path, FolderOpenAction,
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
}
