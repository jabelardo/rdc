use super::keybinding_model::{Keybinding, KeybindingModifier};
use std::{
    collections::BTreeMap,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use thiserror::Error;

const CONFIG_FILE_NAME: &str = "keybindings.json";

const COMMON_DEFAULTS: [(&str, &str); 48] = [
    ("preferences", "CmdOrCtrl+,"),
    ("repository-preferences", "CmdOrCtrl+Shift+,"),
    ("new-repository", "CmdOrCtrl+N"),
    ("new-window", "CmdOrCtrl+Alt+N"),
    ("add-local-repository", "CmdOrCtrl+O"),
    ("clone-repository", "CmdOrCtrl+Shift+O"),
    ("select-all", "CmdOrCtrl+A"),
    ("find", "CmdOrCtrl+F"),
    ("show-changes", "CmdOrCtrl+1"),
    ("show-history", "CmdOrCtrl+2"),
    ("show-compare", "CmdOrCtrl+3"),
    ("show-repository-list", "CmdOrCtrl+T"),
    ("show-branches-list", "CmdOrCtrl+B"),
    ("show-worktrees-list", "CmdOrCtrl+Alt+W"),
    ("go-to-commit-message", "CmdOrCtrl+G"),
    ("toggle-stashed-changes", "Ctrl+H"),
    ("toggle-changes-filter", "CmdOrCtrl+L"),
    ("reset-zoom", "CmdOrCtrl+0"),
    ("zoom-in", "CmdOrCtrl+="),
    ("zoom-out", "CmdOrCtrl+-"),
    ("increase-active-resizable-width", "CmdOrCtrl+9"),
    ("decrease-active-resizable-width", "CmdOrCtrl+8"),
    ("reload-window", "CmdOrCtrl+Alt+R"),
    ("push", "CmdOrCtrl+P"),
    ("pull", "CmdOrCtrl+Shift+P"),
    ("fetch", "CmdOrCtrl+Shift+T"),
    ("remove-repository", "CmdOrCtrl+Backspace"),
    ("view-repository-on-github", "CmdOrCtrl+Shift+G"),
    ("open-in-shell", "Ctrl+`"),
    ("open-working-directory", "CmdOrCtrl+Shift+F"),
    ("open-external-editor", "CmdOrCtrl+Shift+A"),
    ("open-with-external-editor", "CmdOrCtrl+Shift+Alt+A"),
    ("create-issue-in-repository-on-github", "CmdOrCtrl+I"),
    ("create-worktree", "CmdOrCtrl+Shift+W"),
    ("create-branch", "CmdOrCtrl+Shift+N"),
    ("rename-branch", "CmdOrCtrl+Shift+R"),
    ("delete-branch", "CmdOrCtrl+Shift+D"),
    ("discard-all-changes", "CmdOrCtrl+Shift+Backspace"),
    ("stash-all-changes", "CmdOrCtrl+Shift+S"),
    (
        "update-branch-with-contribution-target-branch",
        "CmdOrCtrl+Shift+U",
    ),
    ("compare-to-branch", "CmdOrCtrl+Shift+B"),
    ("merge-branch", "CmdOrCtrl+Shift+M"),
    ("squash-and-merge-branch", "CmdOrCtrl+Shift+H"),
    ("rebase-branch", "CmdOrCtrl+Shift+E"),
    ("compare-on-github", "CmdOrCtrl+Shift+C"),
    ("branch-on-github", "CmdOrCtrl+Alt+B"),
    ("preview-pull-request", "CmdOrCtrl+Alt+P"),
    ("create-pull-request", "CmdOrCtrl+R"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
// All variants are exercised by the platform-independent default-map tests, while a production
// binary naturally constructs only the variant for the OS it was compiled on.
#[allow(dead_code)]
pub enum BindingPlatform {
    MacOs,
    Windows,
    Other,
}

#[derive(Debug, Error)]
pub enum KeybindingError {
    #[error("unknown menu item id: {0}")]
    UnknownMenuId(String),
    #[error("keybinding for {0} has a repeated modifier")]
    RepeatedModifier(String),
    #[error("keybinding for {menu_id} uses unsupported physical key code: {key}")]
    UnsupportedKey { menu_id: String, key: String },
    #[error("keybinding for {menu_id} conflicts with {conflicting_menu_id}")]
    Conflict {
        menu_id: String,
        conflicting_menu_id: String,
    },
    #[error("failed to read keybinding overrides from {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse keybinding overrides from {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to create keybinding config directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to serialize keybinding overrides: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to write keybinding overrides to {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to reset keybinding overrides at {path}: {source}")]
    Reset {
        path: PathBuf,
        source: std::io::Error,
    },
}

pub fn default_keybindings(platform: BindingPlatform) -> BTreeMap<String, Keybinding> {
    let mut bindings = COMMON_DEFAULTS
        .into_iter()
        .map(|(id, accelerator)| (id.to_owned(), parse_accelerator(accelerator, platform)))
        .collect::<BTreeMap<_, _>>();
    let quit = match platform {
        BindingPlatform::MacOs => "Command+Q",
        BindingPlatform::Windows => "Alt+F4",
        BindingPlatform::Other => "CmdOrCtrl+Q",
    };
    let devtools = match platform {
        BindingPlatform::MacOs => "Alt+Command+I",
        BindingPlatform::Windows | BindingPlatform::Other => "Ctrl+Shift+I",
    };
    bindings.insert("quit".to_owned(), parse_accelerator(quit, platform));
    bindings.insert(
        "show-devtools".to_owned(),
        parse_accelerator(devtools, platform),
    );
    bindings
}

pub async fn get_keybindings(
    config_directory: &Path,
    platform: BindingPlatform,
) -> Result<BTreeMap<String, Keybinding>, KeybindingError> {
    let defaults = default_keybindings(platform);
    let overrides = read_overrides(config_directory).await?;
    validate_overrides(&defaults, overrides)
}

pub async fn set_keybinding(
    config_directory: &Path,
    platform: BindingPlatform,
    menu_id: &str,
    binding: Keybinding,
) -> Result<BTreeMap<String, Keybinding>, KeybindingError> {
    let defaults = default_keybindings(platform);
    if !defaults.contains_key(menu_id) {
        return Err(KeybindingError::UnknownMenuId(menu_id.to_owned()));
    }

    let mut overrides = read_overrides(config_directory).await?;
    let binding = normalize_binding(menu_id, binding)?;
    let mut merged = validate_overrides(&defaults, overrides.clone())?;

    if let Some((conflicting_menu_id, _)) = merged.iter().find(|(candidate_id, candidate)| {
        candidate_id.as_str() != menu_id && **candidate == binding
    }) {
        return Err(KeybindingError::Conflict {
            menu_id: menu_id.to_owned(),
            conflicting_menu_id: conflicting_menu_id.clone(),
        });
    }

    if defaults[menu_id] == binding {
        overrides.remove(menu_id);
    } else {
        overrides.insert(menu_id.to_owned(), binding.clone());
    }
    write_overrides(config_directory, &overrides).await?;
    merged.insert(menu_id.to_owned(), binding);
    Ok(merged)
}

pub async fn reset_keybindings(
    config_directory: &Path,
    platform: BindingPlatform,
) -> Result<BTreeMap<String, Keybinding>, KeybindingError> {
    let path = config_file_path(config_directory);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(source) => return Err(KeybindingError::Reset { path, source }),
    }
    Ok(default_keybindings(platform))
}

async fn read_overrides(
    config_directory: &Path,
) -> Result<BTreeMap<String, Keybinding>, KeybindingError> {
    let path = config_file_path(config_directory);
    let contents = match tokio::fs::read(&path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(source) => return Err(KeybindingError::Read { path, source }),
    };
    serde_json::from_slice(&contents).map_err(|source| KeybindingError::Parse { path, source })
}

async fn write_overrides(
    config_directory: &Path,
    overrides: &BTreeMap<String, Keybinding>,
) -> Result<(), KeybindingError> {
    tokio::fs::create_dir_all(config_directory)
        .await
        .map_err(|source| KeybindingError::CreateDirectory {
            path: config_directory.to_owned(),
            source,
        })?;
    let contents = serde_json::to_vec_pretty(overrides).map_err(KeybindingError::Serialize)?;
    let path = config_file_path(config_directory);
    tokio::fs::write(&path, contents)
        .await
        .map_err(|source| KeybindingError::Write { path, source })
}

fn validate_overrides(
    defaults: &BTreeMap<String, Keybinding>,
    overrides: BTreeMap<String, Keybinding>,
) -> Result<BTreeMap<String, Keybinding>, KeybindingError> {
    let mut merged = defaults.clone();
    for (menu_id, binding) in overrides {
        if !defaults.contains_key(&menu_id) {
            return Err(KeybindingError::UnknownMenuId(menu_id));
        }
        let binding = normalize_binding(&menu_id, binding)?;
        merged.insert(menu_id, binding);
    }

    let entries = merged.iter().collect::<Vec<_>>();
    for (index, (menu_id, binding)) in entries.iter().enumerate() {
        if let Some((conflicting_menu_id, _)) = entries
            .iter()
            .skip(index + 1)
            .find(|(_, candidate)| *candidate == *binding)
        {
            return Err(KeybindingError::Conflict {
                menu_id: (*menu_id).clone(),
                conflicting_menu_id: (*conflicting_menu_id).clone(),
            });
        }
    }
    Ok(merged)
}

fn normalize_binding(
    menu_id: &str,
    mut binding: Keybinding,
) -> Result<Keybinding, KeybindingError> {
    binding.modifiers.sort_by_key(|modifier| match modifier {
        KeybindingModifier::Control => 0,
        KeybindingModifier::Alt => 1,
        KeybindingModifier::Shift => 2,
        KeybindingModifier::Meta => 3,
    });
    let original_length = binding.modifiers.len();
    binding.modifiers.dedup();
    if binding.modifiers.len() != original_length {
        return Err(KeybindingError::RepeatedModifier(menu_id.to_owned()));
    }
    if !is_supported_key_code(&binding.key) {
        return Err(KeybindingError::UnsupportedKey {
            menu_id: menu_id.to_owned(),
            key: binding.key,
        });
    }
    Ok(binding)
}

fn is_supported_key_code(key: &str) -> bool {
    matches!(
        key,
        "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "ArrowUp"
            | "Backquote"
            | "Backslash"
            | "Backspace"
            | "BracketLeft"
            | "BracketRight"
            | "Comma"
            | "Delete"
            | "End"
            | "Enter"
            | "Equal"
            | "Escape"
            | "Help"
            | "Home"
            | "Insert"
            | "Minus"
            | "PageDown"
            | "PageUp"
            | "Period"
            | "Quote"
            | "Semicolon"
            | "Slash"
            | "Space"
            | "Tab"
    ) || key
        .strip_prefix("Key")
        .is_some_and(|suffix| suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_uppercase())
        || key
            .strip_prefix("Digit")
            .is_some_and(|suffix| suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit())
        || key.strip_prefix('F').is_some_and(|suffix| {
            suffix
                .parse::<u8>()
                .is_ok_and(|function_key| (1..=24).contains(&function_key))
        })
}

fn config_file_path(config_directory: &Path) -> PathBuf {
    config_directory.join(CONFIG_FILE_NAME)
}

fn parse_accelerator(accelerator: &str, platform: BindingPlatform) -> Keybinding {
    let mut parts = accelerator.split('+').collect::<Vec<_>>();
    let key = canonical_key(parts.pop().unwrap_or_default());
    let modifiers = parts
        .into_iter()
        .map(|modifier| match modifier {
            "Alt" => KeybindingModifier::Alt,
            "Ctrl" => KeybindingModifier::Control,
            "Command" => KeybindingModifier::Meta,
            "Shift" => KeybindingModifier::Shift,
            "CmdOrCtrl" if platform == BindingPlatform::MacOs => KeybindingModifier::Meta,
            "CmdOrCtrl" => KeybindingModifier::Control,
            unknown => panic!("unknown default accelerator modifier: {unknown}"),
        })
        .collect();
    normalize_binding("<default>", Keybinding { modifiers, key })
        .expect("hard-coded default keybindings must be valid")
}

fn canonical_key(key: &str) -> String {
    if key.len() == 1 {
        let character = key.as_bytes()[0] as char;
        if character.is_ascii_alphabetic() {
            return format!("Key{}", character.to_ascii_uppercase());
        }
        if character.is_ascii_digit() {
            return format!("Digit{character}");
        }
    }

    match key {
        "," => "Comma",
        "`" => "Backquote",
        "=" => "Equal",
        "-" => "Minus",
        named => named,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        default_keybindings, get_keybindings, reset_keybindings, set_keybinding, BindingPlatform,
        KeybindingError, COMMON_DEFAULTS,
    };
    use crate::platform::keybinding_model::{Keybinding, KeybindingModifier};
    use std::collections::BTreeMap;

    #[test]
    fn extracts_fifty_unique_logical_bindings_from_upstreams_fifty_two_declarations() {
        // The local source audit checks all 52 declarations item-for-item. The runtime map has 50
        // keys because preferences and repository-preferences each occur once in the macOS app menu
        // and once in the non-macOS File menu with identical defaults.
        assert_eq!(COMMON_DEFAULTS.len() + 2 + 2, 52);
        for platform in [
            BindingPlatform::MacOs,
            BindingPlatform::Windows,
            BindingPlatform::Other,
        ] {
            assert_eq!(default_keybindings(platform).len(), 50);
        }
    }

    #[test]
    fn resolves_platform_modifiers_and_platform_specific_defaults() {
        let mac = default_keybindings(BindingPlatform::MacOs);
        assert_eq!(mac["preferences"].modifiers, [KeybindingModifier::Meta]);
        assert_eq!(mac["quit"].key, "KeyQ");
        assert_eq!(
            mac["show-devtools"].modifiers,
            [KeybindingModifier::Alt, KeybindingModifier::Meta]
        );

        let windows = default_keybindings(BindingPlatform::Windows);
        assert_eq!(
            windows["preferences"].modifiers,
            [KeybindingModifier::Control]
        );
        assert_eq!(windows["quit"].key, "F4");
        assert_eq!(windows["open-in-shell"].key, "Backquote");
        assert_eq!(windows["preferences"].key, "Comma");
    }

    #[tokio::test]
    async fn persists_only_overrides_and_merges_them_with_defaults() {
        let directory = tempfile::tempdir().expect("temp directory");
        let custom = Keybinding {
            modifiers: vec![KeybindingModifier::Shift, KeybindingModifier::Control],
            key: "KeyK".to_owned(),
        };

        let updated = set_keybinding(directory.path(), BindingPlatform::Other, "pull", custom)
            .await
            .expect("set binding");
        assert_eq!(
            updated["pull"].modifiers,
            [KeybindingModifier::Control, KeybindingModifier::Shift]
        );
        assert_eq!(updated.len(), 50);

        let persisted: BTreeMap<String, Keybinding> = serde_json::from_slice(
            &tokio::fs::read(directory.path().join("keybindings.json"))
                .await
                .expect("read overrides"),
        )
        .expect("parse overrides");
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted["pull"], updated["pull"]);

        assert_eq!(
            get_keybindings(directory.path(), BindingPlatform::Other)
                .await
                .expect("reload bindings"),
            updated
        );
    }

    #[tokio::test]
    async fn rejects_conflicts_unknown_ids_and_invalid_physical_keys() {
        let directory = tempfile::tempdir().expect("temp directory");
        let defaults = default_keybindings(BindingPlatform::Other);

        let conflict = set_keybinding(
            directory.path(),
            BindingPlatform::Other,
            "pull",
            defaults["push"].clone(),
        )
        .await
        .expect_err("conflicting binding");
        assert!(matches!(
            conflict,
            KeybindingError::Conflict {
                ref menu_id,
                ref conflicting_menu_id
            } if menu_id == "pull" && conflicting_menu_id == "push"
        ));

        let unknown = set_keybinding(
            directory.path(),
            BindingPlatform::Other,
            "not-a-menu-item",
            defaults["pull"].clone(),
        )
        .await
        .expect_err("unknown id");
        assert!(matches!(unknown, KeybindingError::UnknownMenuId(_)));

        let invalid = set_keybinding(
            directory.path(),
            BindingPlatform::Other,
            "pull",
            Keybinding {
                modifiers: vec![KeybindingModifier::Control],
                key: "p".to_owned(),
            },
        )
        .await
        .expect_err("logical key instead of physical code");
        assert!(matches!(invalid, KeybindingError::UnsupportedKey { .. }));
    }

    #[tokio::test]
    async fn resetting_removes_overrides_and_is_idempotent() {
        let directory = tempfile::tempdir().expect("temp directory");
        set_keybinding(
            directory.path(),
            BindingPlatform::MacOs,
            "pull",
            Keybinding {
                modifiers: vec![KeybindingModifier::Meta, KeybindingModifier::Shift],
                key: "KeyK".to_owned(),
            },
        )
        .await
        .expect("set binding");

        let defaults = default_keybindings(BindingPlatform::MacOs);
        assert_eq!(
            reset_keybindings(directory.path(), BindingPlatform::MacOs)
                .await
                .expect("first reset"),
            defaults
        );
        assert_eq!(
            reset_keybindings(directory.path(), BindingPlatform::MacOs)
                .await
                .expect("second reset"),
            defaults
        );
        assert!(!directory.path().join("keybindings.json").exists());
    }

    #[tokio::test]
    async fn malformed_config_is_reported_instead_of_discarded() {
        let directory = tempfile::tempdir().expect("temp directory");
        tokio::fs::write(directory.path().join("keybindings.json"), b"{")
            .await
            .expect("write malformed config");

        assert!(matches!(
            get_keybindings(directory.path(), BindingPlatform::Windows)
                .await
                .expect_err("malformed config"),
            KeybindingError::Parse { .. }
        ));
    }

    #[tokio::test]
    async fn override_validation_is_independent_of_json_key_order() {
        let directory = tempfile::tempdir().expect("temp directory");
        let defaults = default_keybindings(BindingPlatform::Other);
        let overrides = BTreeMap::from([
            ("pull".to_owned(), defaults["push"].clone()),
            (
                "push".to_owned(),
                Keybinding {
                    modifiers: vec![KeybindingModifier::Control],
                    key: "KeyK".to_owned(),
                },
            ),
        ]);
        tokio::fs::write(
            directory.path().join("keybindings.json"),
            serde_json::to_vec(&overrides).expect("serialize overrides"),
        )
        .await
        .expect("write overrides");

        let bindings = get_keybindings(directory.path(), BindingPlatform::Other)
            .await
            .expect("collectively conflict-free overrides");
        assert_eq!(bindings["pull"], defaults["push"]);
        assert_eq!(bindings["push"].key, "KeyK");
    }
}
