use super::custom_integration_model::{CustomIntegration, CustomIntegrationPathValidation};
use std::fmt;
use std::path::Path;

// Private, as it was before the seam was extracted — this is an implementation detail of
// `validate_custom_integration_path`, not part of the module's surface.
use executable::has_execute_access;

pub const TARGET_PATH_ARGUMENT: &str = "%TARGET_PATH%";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ArgumentParseError;

impl fmt::Display for ArgumentParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("custom integration arguments contain unmatched quotes")
    }
}

impl std::error::Error for ArgumentParseError {}

/// Split a user-entered argument string without evaluating it in a shell.
pub fn parse_custom_integration_arguments(
    arguments: &str,
) -> Result<Vec<String>, ArgumentParseError> {
    shlex::split(arguments).ok_or(ArgumentParseError)
}

pub fn check_target_path_argument(arguments: &[String]) -> bool {
    arguments
        .iter()
        .any(|argument| argument.contains(TARGET_PATH_ARGUMENT))
}

pub async fn validate_custom_integration_path(path: &Path) -> CustomIntegrationPathValidation {
    if path.as_os_str().is_empty() {
        return invalid_path_validation();
    }

    let Ok(path_metadata) = tokio::fs::symlink_metadata(path).await else {
        return invalid_path_validation();
    };
    let file_type = path_metadata.file_type();
    let is_executable_file =
        (file_type.is_file() || file_type.is_symlink()) && has_execute_access(path);

    if is_executable_file {
        return CustomIntegrationPathValidation {
            is_valid: true,
            bundle_id: None,
        };
    }

    #[cfg(target_os = "macos")]
    if file_type.is_dir() {
        if let Some(bundle_id) = app_bundle_identifier(path).await {
            return CustomIntegrationPathValidation {
                is_valid: true,
                bundle_id: Some(bundle_id),
            };
        }
    }

    invalid_path_validation()
}

pub async fn is_valid_custom_integration(custom_integration: &CustomIntegration) -> bool {
    let path_result = validate_custom_integration_path(&custom_integration.path).await;
    let Ok(arguments) = parse_custom_integration_arguments(&custom_integration.arguments) else {
        return false;
    };

    path_result.is_valid && check_target_path_argument(&arguments)
}

/// "Can this path be executed" — the one platform-specific question this module asks.
///
/// Isolated here on purpose. Everything else in this file is portable (argument parsing, the
/// `%TARGET_PATH%` expansion, the validation flow), but the Unix answer needs
/// `std::os::unix::ffi::OsStrExt` and `libc::access`. Those imports used to sit at file scope, which
/// meant ten Unix-specific lines made the other two hundred and fifty uncompilable on Windows. The
/// exported signature is platform-neutral, so callers are unaware and Phase 10 adds an arm here
/// rather than restructuring the module. See AGENTS.md rule 11.
mod executable {
    use std::path::Path;

    #[cfg(unix)]
    pub fn has_execute_access(path: &Path) -> bool {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };

        // SAFETY: `path` is NUL-terminated and remains alive for the duration of
        // the call. `access` preserves upstream's OS-level filesystem check,
        // including ACLs, rather than approximating executability from mode bits.
        unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
    }

    // Phase 10 owns the Windows arm, and it is a behavioural decision rather than a translation:
    // Windows has no execute permission bit, so "executable" means something else there —
    // `PATHEXT` membership, or an `AccessCheck` against the file's DACL. Picking one is exactly the
    // judgement Phase 10 exists for, so this deliberately does not guess. Adding it is additive:
    // define `has_execute_access` under `#[cfg(windows)]` with the same signature.
    #[cfg(not(unix))]
    pub fn has_execute_access(_path: &Path) -> bool {
        compile_error!(
            "has_execute_access has no non-Unix implementation yet — see Phase 10 in REMAINING.md"
        )
    }
}

fn invalid_path_validation() -> CustomIntegrationPathValidation {
    CustomIntegrationPathValidation {
        is_valid: false,
        bundle_id: None,
    }
}

#[cfg(target_os = "macos")]
async fn app_bundle_identifier(path: &Path) -> Option<String> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("app") {
        return None;
    }

    let output = tokio::process::Command::new("/usr/bin/mdls")
        .args(["-name", "kMDItemCFBundleIdentifier", "-raw"])
        .arg(path)
        .output()
        .await
        .ok()?;

    output
        .status
        .success()
        .then(|| parse_bundle_identifier(&output.stdout))
        .flatten()
}

#[cfg(any(target_os = "macos", test))]
fn parse_bundle_identifier(output: &[u8]) -> Option<String> {
    let bundle_id = String::from_utf8_lossy(output).trim().to_owned();
    (!bundle_id.is_empty() && bundle_id != "(null)").then_some(bundle_id)
}

pub fn expand_target_path_argument(arguments: Vec<String>, target_path: &str) -> Vec<String> {
    arguments
        .into_iter()
        .map(|argument| {
            if argument == format!("'{TARGET_PATH_ARGUMENT}'")
                || argument == format!("\"{TARGET_PATH_ARGUMENT}\"")
            {
                target_path.to_owned()
            } else {
                argument.replace(TARGET_PATH_ARGUMENT, target_path)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        check_target_path_argument, expand_target_path_argument, is_valid_custom_integration,
        parse_bundle_identifier, parse_custom_integration_arguments,
        validate_custom_integration_path, TARGET_PATH_ARGUMENT,
    };
    use crate::platform::custom_integration_model::CustomIntegration;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;
    use tempfile::tempdir;

    #[test]
    fn parses_quotes_spaces_and_empty_arguments_without_a_shell() {
        assert_eq!(
            parse_custom_integration_arguments(
                r#"--wait "%TARGET_PATH%" 'two words' "" $(not-a-command)"#
            )
            .expect("valid arguments"),
            [
                "--wait",
                TARGET_PATH_ARGUMENT,
                "two words",
                "",
                "$(not-a-command)"
            ]
        );
    }

    #[test]
    fn rejects_an_unclosed_quote() {
        assert!(parse_custom_integration_arguments(r#""unfinished"#).is_err());
    }

    #[test]
    fn detects_and_expands_whole_or_embedded_target_placeholders() {
        let arguments = vec![
            "--folder".to_owned(),
            TARGET_PATH_ARGUMENT.to_owned(),
            format!("--reuse-window={TARGET_PATH_ARGUMENT}"),
        ];

        assert!(check_target_path_argument(&arguments));
        assert_eq!(
            expand_target_path_argument(arguments, "/repos/a project"),
            [
                "--folder",
                "/repos/a project",
                "--reuse-window=/repos/a project"
            ]
        );
    }

    #[test]
    fn does_not_claim_arguments_without_the_placeholder_are_valid() {
        assert!(!check_target_path_argument(&[
            "--folder".to_owned(),
            "/somewhere/else".to_owned()
        ]));
    }

    #[test]
    fn parses_spotlight_bundle_identifiers_without_accepting_missing_metadata() {
        assert_eq!(
            parse_bundle_identifier(b"com.example.Editor\n"),
            Some("com.example.Editor".to_owned())
        );
        assert_eq!(parse_bundle_identifier(b""), None);
        assert_eq!(parse_bundle_identifier(b"(null)\n"), None);
    }

    #[tokio::test]
    async fn validates_executable_files_and_symlinks_only() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("editor");
        std::fs::write(&executable, "#!/bin/sh\n").expect("write executable");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .expect("make executable");

        assert!(validate_custom_integration_path(&executable).await.is_valid);

        let link = directory.path().join("editor-link");
        symlink(&executable, &link).expect("create symlink");
        assert!(validate_custom_integration_path(&link).await.is_valid);

        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644))
            .expect("remove executable bit");
        assert!(!validate_custom_integration_path(&executable).await.is_valid);
        assert!(!validate_custom_integration_path(&link).await.is_valid);
        assert!(
            !validate_custom_integration_path(directory.path())
                .await
                .is_valid
        );
        assert!(
            !validate_custom_integration_path(&directory.path().join("missing"))
                .await
                .is_valid
        );
        assert!(
            !validate_custom_integration_path(&PathBuf::new())
                .await
                .is_valid
        );
    }

    #[tokio::test]
    async fn validates_the_whole_integration_including_the_target_placeholder() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("editor");
        std::fs::write(&executable, "#!/bin/sh\n").expect("write executable");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .expect("make executable");

        let integration = |arguments: &str| CustomIntegration {
            path: executable.clone(),
            arguments: arguments.to_owned(),
            bundle_id: None,
        };

        assert!(is_valid_custom_integration(&integration(r#"--wait "%TARGET_PATH%""#)).await);
        assert!(!is_valid_custom_integration(&integration("--wait")).await);
        assert!(
            !is_valid_custom_integration(&integration(r#"--wait "%TARGET_PATH%" "unfinished"#))
                .await
        );
    }
}
