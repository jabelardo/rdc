use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct MenuModel {
    #[serde(rename = "type")]
    pub kind: MenuKind,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub items: Vec<MenuItemModel>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MenuKind {
    Menu,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum MenuItemModel {
    #[serde(rename = "menuItem")]
    MenuItem {
        id: String,
        enabled: bool,
        visible: bool,
        label: String,
        #[serde(rename = "accessKey")]
        access_key: Option<String>,
        #[serde(default)]
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<MenuAction>,
        #[serde(default)]
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<NativeMenuRole>,
    },
    #[serde(rename = "submenuItem")]
    SubmenuItem {
        id: String,
        enabled: bool,
        visible: bool,
        label: String,
        #[serde(rename = "accessKey")]
        access_key: Option<String>,
        menu: MenuModel,
        #[serde(default)]
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<NativeMenuRole>,
    },
    #[serde(rename = "separator")]
    Separator { id: String, visible: bool },
    #[serde(rename = "checkbox")]
    Checkbox {
        id: String,
        enabled: bool,
        visible: bool,
        label: String,
        #[serde(rename = "accessKey")]
        access_key: Option<String>,
        checked: bool,
        #[serde(default)]
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<MenuAction>,
    },
    #[serde(rename = "radio")]
    Radio {
        id: String,
        enabled: bool,
        visible: bool,
        label: String,
        #[serde(rename = "accessKey")]
        access_key: Option<String>,
        checked: bool,
        #[serde(default)]
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<MenuAction>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum MenuAction {
    MenuEvent { event: String },
    OpenExternal { url: String },
    ShowLogs,
    Zoom { direction: ZoomDirection },
    ReloadWindow,
    ShowDevtools,
    CrashMainProcess,
    Quit,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ZoomDirection {
    Reset,
    In,
    Out,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub enum NativeMenuRole {
    #[serde(rename = "services")]
    Services,
    #[serde(rename = "hide")]
    Hide,
    #[serde(rename = "hideOthers")]
    HideOthers,
    #[serde(rename = "unhide")]
    Unhide,
    #[serde(rename = "quit")]
    Quit,
    #[serde(rename = "undo")]
    Undo,
    #[serde(rename = "redo")]
    Redo,
    #[serde(rename = "cut")]
    Cut,
    #[serde(rename = "copy")]
    Copy,
    #[serde(rename = "paste")]
    Paste,
    #[serde(rename = "selectAll")]
    SelectAll,
    #[serde(rename = "minimize")]
    Minimize,
    #[serde(rename = "zoom")]
    Zoom,
    #[serde(rename = "close")]
    Close,
    #[serde(rename = "front")]
    Front,
    #[serde(rename = "window")]
    Window,
    #[serde(rename = "help")]
    Help,
    #[serde(rename = "togglefullscreen")]
    ToggleFullscreen,
}
