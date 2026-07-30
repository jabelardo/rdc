use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const CONFIG_FILE_NAME: &str = "main-process-config.json";

#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TitleBarStyle {
    #[default]
    Native,
    Custom,
    NativeWithoutMenuBar,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainProcessConfig {
    pub title_bar_style: TitleBarStyle,
    pub hide_window_on_quit: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainProcessConfigUpdate {
    pub title_bar_style: Option<TitleBarStyle>,
    pub hide_window_on_quit: Option<bool>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not read main-process config at {path}: {source}")]
    Read {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("main-process config is not valid JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("could not write main-process config at {path}: {source}")]
    Write {
        path: String,
        #[source]
        source: io::Error,
    },
}

pub fn parse_main_process_config(source: &str) -> Result<MainProcessConfig, ConfigError> {
    let value: Value = serde_json::from_str(source)?;
    let title_bar_style = value
        .get("titleBarStyle")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_value(Value::String(value.to_owned())).ok())
        .unwrap_or_default();

    let hide_window_on_quit = value
        .get("hideWindowOnQuit")
        .and_then(Value::as_bool)
        .unwrap_or_default();

    Ok(MainProcessConfig {
        title_bar_style,
        hide_window_on_quit,
    })
}

pub async fn update_main_process_config(
    directory: PathBuf,
    update: MainProcessConfigUpdate,
) -> Result<MainProcessConfig, ConfigError> {
    let mut config = read_main_process_config(&directory)?;
    if let Some(title_bar_style) = update.title_bar_style {
        config.title_bar_style = title_bar_style;
    }
    if let Some(hide_window_on_quit) = update.hide_window_on_quit {
        config.hide_window_on_quit = hide_window_on_quit;
    }

    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|source| ConfigError::Write {
            path: directory.display().to_string(),
            source,
        })?;
    let path = directory.join(CONFIG_FILE_NAME);
    let contents = serde_json::to_vec(&config)?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|source| ConfigError::Write {
            path: path.display().to_string(),
            source,
        })?;
    Ok(config)
}

pub fn read_main_process_config(directory: &Path) -> Result<MainProcessConfig, ConfigError> {
    let path = directory.join(CONFIG_FILE_NAME);
    match fs::read_to_string(&path) {
        Ok(source) => parse_main_process_config(&source),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(MainProcessConfig::default()),
        Err(source) => Err(ConfigError::Read {
            path: path.display().to_string(),
            source,
        }),
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum HostPlatform {
    MacOs,
    Windows,
    Linux,
    Other,
}

impl HostPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct TitleBarDecision {
    pub decorations: bool,
    pub macos_title_bar_overlay: bool,
}

pub fn title_bar_decision(platform: HostPlatform, style: TitleBarStyle) -> TitleBarDecision {
    match platform {
        HostPlatform::MacOs => TitleBarDecision {
            decorations: true,
            macos_title_bar_overlay: true,
        },
        HostPlatform::Windows => TitleBarDecision {
            decorations: false,
            macos_title_bar_overlay: false,
        },
        HostPlatform::Linux => TitleBarDecision {
            decorations: style != TitleBarStyle::Custom,
            macos_title_bar_overlay: false,
        },
        HostPlatform::Other => TitleBarDecision {
            decorations: true,
            macos_title_bar_overlay: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        parse_main_process_config, read_main_process_config, title_bar_decision,
        update_main_process_config, HostPlatform, MainProcessConfigUpdate, TitleBarStyle,
        CONFIG_FILE_NAME,
    };

    #[test]
    fn parses_all_three_upstream_title_bar_values() {
        for (wire, expected) in [
            ("native", TitleBarStyle::Native),
            ("custom", TitleBarStyle::Custom),
            (
                "native-without-menu-bar",
                TitleBarStyle::NativeWithoutMenuBar,
            ),
        ] {
            let config = parse_main_process_config(&format!(r#"{{"titleBarStyle":"{wire}"}}"#))
                .expect("valid config");
            assert_eq!(config.title_bar_style, expected);
        }
    }

    #[test]
    fn missing_or_unknown_style_uses_upstreams_native_default() {
        for source in [
            "{}",
            r#"{"titleBarStyle":"future-style"}"#,
            r#"{"titleBarStyle":42}"#,
        ] {
            let config = parse_main_process_config(source).expect("valid JSON");
            assert_eq!(config.title_bar_style, TitleBarStyle::Native);
        }
    }

    #[test]
    fn malformed_json_is_reported_instead_of_silently_rewritten() {
        assert!(parse_main_process_config("{").is_err());
    }

    #[test]
    fn a_missing_config_file_uses_the_default() {
        let directory = tempfile::tempdir().expect("temp dir");

        let config = read_main_process_config(directory.path()).expect("missing config is valid");

        assert_eq!(config.title_bar_style, TitleBarStyle::Native);
        assert!(!config.hide_window_on_quit);
        assert!(!directory.path().join(CONFIG_FILE_NAME).exists());
    }

    #[tokio::test]
    async fn partial_updates_preserve_the_other_field_and_use_camel_case() {
        let directory = tempfile::tempdir().expect("temp dir");
        update_main_process_config(
            directory.path().to_owned(),
            MainProcessConfigUpdate {
                title_bar_style: Some(TitleBarStyle::Custom),
                hide_window_on_quit: None,
            },
        )
        .await
        .expect("first update");
        let config = update_main_process_config(
            directory.path().to_owned(),
            MainProcessConfigUpdate {
                title_bar_style: None,
                hide_window_on_quit: Some(true),
            },
        )
        .await
        .expect("second update");

        assert_eq!(config.title_bar_style, TitleBarStyle::Custom);
        assert!(config.hide_window_on_quit);
        assert_eq!(
            fs::read_to_string(directory.path().join(CONFIG_FILE_NAME)).expect("saved config"),
            r#"{"titleBarStyle":"custom","hideWindowOnQuit":true}"#
        );
    }

    #[tokio::test]
    async fn an_update_survives_a_fresh_config_read() {
        let directory = tempfile::tempdir().expect("temp dir");
        update_main_process_config(
            directory.path().to_owned(),
            MainProcessConfigUpdate {
                title_bar_style: Some(TitleBarStyle::NativeWithoutMenuBar),
                hide_window_on_quit: Some(true),
            },
        )
        .await
        .expect("update");

        let reloaded =
            read_main_process_config(directory.path()).expect("a fresh owner should read the file");

        assert_eq!(
            reloaded.title_bar_style,
            TitleBarStyle::NativeWithoutMenuBar
        );
        assert!(reloaded.hide_window_on_quit);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_writes_are_reported() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp dir");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o500))
            .expect("read-only directory");

        let error = update_main_process_config(
            directory.path().to_owned(),
            MainProcessConfigUpdate {
                hide_window_on_quit: Some(true),
                ..MainProcessConfigUpdate::default()
            },
        )
        .await
        .expect_err("write should fail");

        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restore directory permissions");
        assert!(error.to_string().contains("could not write"));
    }

    #[test]
    fn platform_decisions_match_upstreams_window_constructor() {
        for style in [
            TitleBarStyle::Native,
            TitleBarStyle::Custom,
            TitleBarStyle::NativeWithoutMenuBar,
        ] {
            let macos = title_bar_decision(HostPlatform::MacOs, style);
            assert!(macos.decorations);
            assert!(macos.macos_title_bar_overlay);

            let windows = title_bar_decision(HostPlatform::Windows, style);
            assert!(!windows.decorations);
            assert!(!windows.macos_title_bar_overlay);
        }

        assert!(title_bar_decision(HostPlatform::Linux, TitleBarStyle::Native).decorations);
        assert!(
            title_bar_decision(HostPlatform::Linux, TitleBarStyle::NativeWithoutMenuBar)
                .decorations
        );
        assert!(!title_bar_decision(HostPlatform::Linux, TitleBarStyle::Custom).decorations);
    }
}
