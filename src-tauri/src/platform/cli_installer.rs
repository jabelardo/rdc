#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "macos", test))]
use thiserror::Error;

#[cfg(target_os = "macos")]
pub const INSTALLED_CLI_PATH: &str = "/usr/local/bin/rdc";

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Error)]
pub enum CliInstallerError {
    #[error("the packaged command line launcher is unavailable at {0}")]
    MissingPackagedLauncher(PathBuf),
    #[error("could not install the command line launcher: {0}")]
    Filesystem(#[from] std::io::Error),
    #[cfg(target_os = "macos")]
    #[error("administrator authorization failed: {0}")]
    Authorization(String),
}

#[cfg(any(target_os = "macos", test))]
pub fn install_without_elevation(
    packaged_path: &Path,
    installed_path: &Path,
) -> Result<(), CliInstallerError> {
    if !packaged_path.is_file() {
        return Err(CliInstallerError::MissingPackagedLauncher(
            packaged_path.to_owned(),
        ));
    }
    if std::fs::read_link(installed_path).is_ok_and(|target| target == packaged_path) {
        return Ok(());
    }
    match std::fs::remove_file(installed_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = installed_path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "installed launcher path has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    link::symlink_file(packaged_path, installed_path)?;
    Ok(())
}

/// Creating a file symlink, per platform.
///
/// This module is gated `any(target_os = "macos", test)` — a macOS feature whose logic is tested
/// everywhere. That `test` arm is the point: it compiles this file on *every* platform's test
/// profile, so the `std::os::unix::fs::symlink` call that used to be inline here broke a Windows
/// `cargo check --all-targets` even though the feature is macOS-only. Gate the OS call, not the
/// module. See AGENTS.md rule 11.
///
/// Unlike `custom_integration`'s executability check, this one has an exact Windows counterpart, so
/// both arms are real rather than one arm and a deferral.
mod link {
    use std::io;
    use std::path::Path;

    #[cfg(unix)]
    pub fn symlink_file(original: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    /// Windows splits the call by target kind; the packaged launcher is always a file.
    ///
    /// Note this may fail at runtime without Developer Mode or elevation. That is correct
    /// behaviour, not a gap: the caller already maps `io::Error` to
    /// `CliInstallerError::Filesystem`, and the installer itself is macOS-only at runtime.
    #[cfg(windows)]
    pub fn symlink_file(original: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(original, link)
    }
}

#[cfg(any(target_os = "macos", test))]
pub fn elevated_install_script(packaged_path: &Path, installed_path: &Path) -> String {
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
    }

    let parent = installed_path.parent().unwrap_or_else(|| Path::new("/"));
    format!(
        "/bin/rm -f -- {} && /bin/mkdir -p -- {} && /bin/ln -s -- {} {}",
        shell_quote(installed_path),
        shell_quote(parent),
        shell_quote(packaged_path),
        shell_quote(installed_path)
    )
}

#[cfg(target_os = "macos")]
pub async fn install(packaged_path: &Path) -> Result<(), CliInstallerError> {
    if !packaged_path.is_file() {
        return Err(CliInstallerError::MissingPackagedLauncher(
            packaged_path.to_owned(),
        ));
    }

    let packaged = packaged_path.to_owned();
    let installed = PathBuf::from(INSTALLED_CLI_PATH);
    let ordinary_packaged = packaged.clone();
    let ordinary_installed = installed.clone();
    if tokio::task::spawn_blocking(move || {
        install_without_elevation(&ordinary_packaged, &ordinary_installed)
    })
    .await
    .map_err(|error| CliInstallerError::Filesystem(std::io::Error::other(error)))?
    .is_ok()
    {
        return Ok(());
    }

    let shell_script = elevated_install_script(&packaged, &installed);
    let apple_script = format!(
        "do shell script \"{}\" with administrator privileges",
        shell_script.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", &apple_script])
        .output()
        .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CliInstallerError::Authorization(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn installs_and_replaces_the_launcher_without_elevation() {
        let directory = tempdir().expect("tempdir");
        let packaged = directory.path().join("RDC's launcher");
        std::fs::write(&packaged, "#!/bin/sh\n").expect("packaged launcher");
        let installed = directory.path().join("bin").join("rdc");

        install_without_elevation(&packaged, &installed).expect("first install");
        assert_eq!(
            std::fs::read_link(&installed).expect("installed link"),
            packaged
        );

        let stale = directory.path().join("stale");
        std::fs::write(&stale, "stale").expect("stale launcher");
        std::fs::remove_file(&installed).expect("remove link");
        symlink(&stale, &installed).expect("stale link");

        install_without_elevation(&packaged, &installed).expect("replacement");
        assert_eq!(
            std::fs::read_link(&installed).expect("replacement link"),
            packaged
        );
    }

    #[test]
    fn identical_existing_link_is_a_no_op() {
        let directory = tempdir().expect("tempdir");
        let packaged = directory.path().join("rdc-launcher");
        std::fs::write(&packaged, "#!/bin/sh\n").expect("packaged launcher");
        let installed = directory.path().join("rdc");
        symlink(&packaged, &installed).expect("installed link");

        install_without_elevation(&packaged, &installed).expect("idempotent install");

        assert_eq!(
            std::fs::read_link(&installed).expect("installed link"),
            packaged
        );
    }

    #[test]
    fn refuses_to_install_a_missing_packaged_launcher() {
        let directory = tempdir().expect("tempdir");
        let packaged = directory.path().join("missing");
        let installed = directory.path().join("bin").join("rdc");

        assert!(matches!(
            install_without_elevation(&packaged, &installed),
            Err(CliInstallerError::MissingPackagedLauncher(path)) if path == packaged
        ));
    }

    #[test]
    fn elevation_script_quotes_every_filesystem_argument() {
        let script = elevated_install_script(
            Path::new("/Applications/RDC's App.app/Contents/Resources/rdc-cli"),
            Path::new("/usr/local/a bin/rdc"),
        );

        assert_eq!(
            script,
            "/bin/rm -f -- '/usr/local/a bin/rdc' && /bin/mkdir -p -- '/usr/local/a bin' && /bin/ln -s -- '/Applications/RDC'\"'\"'s App.app/Contents/Resources/rdc-cli' '/usr/local/a bin/rdc'"
        );
    }
}
