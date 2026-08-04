//! The ephemeral popup menu behind `show_context_menu_at`.
//!
//! Deliberately separate from `menu.rs`'s app-level [`MenuAction`]/[`NativeMenuState`]: those model
//! a single persistent menu whose items always act on "whatever is currently selected" (the
//! checked-out branch, the selected repository). A context menu is invoked per-row and has to act
//! on *that* row regardless of what's selected elsewhere, so its items carry no action of their
//! own — the frontend keeps the per-invocation closure and this module only relays back which id
//! was picked.

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Runtime,
};

/// Emitted to the frontend with the selected item's id whenever any native menu fires a selection —
/// the app-level menu's ids and a context menu's ids are drawn from disjoint namespaces (the latter
/// are per-invocation indices), so relaying every selection here and letting the frontend filter by
/// id it recognizes is simpler than threading a separate channel per popup.
pub const CONTEXT_MENU_EVENT: &str = "context-menu-event";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContextMenuItemModel {
    Item {
        id: String,
        label: String,
        enabled: bool,
    },
    Separator,
}

pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    items: &[ContextMenuItemModel],
) -> Result<Menu<R>, String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for item in items {
        match item {
            ContextMenuItemModel::Separator => {
                let separator =
                    PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
                menu.append(&separator).map_err(|error| error.to_string())?;
            }
            ContextMenuItemModel::Item { id, label, enabled } => {
                let menu_item = MenuItem::with_id(app, id, label, *enabled, None::<&str>)
                    .map_err(|error| error.to_string())?;
                menu.append(&menu_item).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(menu)
}
