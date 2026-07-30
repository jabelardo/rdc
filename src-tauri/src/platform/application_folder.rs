#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use thiserror::Error;

#[cfg(target_os = "macos")]
#[derive(Debug, Error)]
pub enum ApplicationFolderError {
    #[error("the current executable is not inside a macOS application bundle")]
    NotBundled,
    #[error("application bundle has no file name")]
    MissingBundleName,
    #[error("could not move the application bundle: {0}")]
    Move(String),
}

#[cfg(any(target_os = "macos", test))]
pub fn bundle_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_owned)
}

#[cfg(any(target_os = "macos", test))]
pub fn is_in_application_folder(executable: &Path, home: Option<&Path>) -> bool {
    let Some(bundle) = bundle_from_executable(executable) else {
        return false;
    };
    let parent = bundle.parent();
    parent == Some(Path::new("/Applications"))
        || home.is_some_and(|home| parent == Some(&home.join("Applications")))
}

#[cfg(any(target_os = "macos", test))]
fn applescript_string(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(any(target_os = "macos", test))]
pub fn finder_move_script(source: &Path) -> String {
    format!(
        "tell application \"Finder\" to move POSIX file \"{}\" to folder \"Applications\" of startup disk with replacing",
        applescript_string(source)
    )
}

#[cfg(target_os = "macos")]
pub async fn move_to_applications_folder(
    executable: &Path,
) -> Result<PathBuf, ApplicationFolderError> {
    let source = bundle_from_executable(executable).ok_or(ApplicationFolderError::NotBundled)?;
    let name = source
        .file_name()
        .ok_or(ApplicationFolderError::MissingBundleName)?;
    let destination = Path::new("/Applications").join(name);
    if source == destination {
        return Ok(destination);
    }

    let output = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", &finder_move_script(&source)])
        .output()
        .await
        .map_err(|error| ApplicationFolderError::Move(error.to_string()))?;
    if !output.status.success() {
        return Err(ApplicationFolderError::Move(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::{bundle_from_executable, finder_move_script, is_in_application_folder};
    use std::path::{Path, PathBuf};

    #[test]
    fn finds_the_bundle_around_a_packaged_executable() {
        assert_eq!(
            bundle_from_executable(Path::new("/tmp/rdc.app/Contents/MacOS/rdc")),
            Some(PathBuf::from("/tmp/rdc.app"))
        );
        assert_eq!(bundle_from_executable(Path::new("/tmp/rdc")), None);
    }

    #[test]
    fn recognizes_system_and_user_application_folders_only() {
        let home = Path::new("/Users/alice");
        assert!(is_in_application_folder(
            Path::new("/Applications/rdc.app/Contents/MacOS/rdc"),
            Some(home)
        ));
        assert!(is_in_application_folder(
            Path::new("/Users/alice/Applications/rdc.app/Contents/MacOS/rdc"),
            Some(home)
        ));
        assert!(!is_in_application_folder(
            Path::new("/tmp/rdc.app/Contents/MacOS/rdc"),
            Some(home)
        ));
    }

    #[test]
    fn finder_script_escapes_paths_as_data() {
        let script = finder_move_script(Path::new("/tmp/a \"quoted\" \\\\ app.app"));
        assert_eq!(
            script,
            "tell application \"Finder\" to move POSIX file \"/tmp/a \\\"quoted\\\" \\\\\\\\ app.app\" to folder \"Applications\" of startup disk with replacing"
        );
    }
}
