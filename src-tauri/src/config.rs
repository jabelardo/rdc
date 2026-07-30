use std::{fs, io, path::Path};

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

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub struct MainProcessConfig {
    pub title_bar_style: TitleBarStyle,
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
}

pub fn parse_main_process_config(source: &str) -> Result<MainProcessConfig, ConfigError> {
    let value: Value = serde_json::from_str(source)?;
    let title_bar_style = value
        .get("titleBarStyle")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_value(Value::String(value.to_owned())).ok())
        .unwrap_or_default();

    Ok(MainProcessConfig { title_bar_style })
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
    use super::{
        parse_main_process_config, read_main_process_config, title_bar_decision, HostPlatform,
        TitleBarStyle, CONFIG_FILE_NAME,
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
        assert!(!directory.path().join(CONFIG_FILE_NAME).exists());
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
