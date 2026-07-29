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
        classify_folder_open, move_to_trash, parse_macos_bundle_metadata, FolderOpenAction,
    };
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
}
