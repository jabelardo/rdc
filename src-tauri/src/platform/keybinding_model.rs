use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeybindingModifier {
    Alt,
    Control,
    Meta,
    Shift,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Keybinding {
    pub modifiers: Vec<KeybindingModifier>,
    pub key: String,
}
