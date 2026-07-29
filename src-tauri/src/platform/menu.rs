use super::{
    keybinding_model::{Keybinding, KeybindingModifier},
    menu_model::{MenuAction, MenuItemModel, MenuModel, NativeMenuRole},
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
#[cfg(target_os = "macos")]
use tauri::App;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime,
};

pub const MENU_EVENT: &str = "menu-event";

pub struct NativeMenuState {
    actions: Mutex<BTreeMap<String, MenuAction>>,
    renderer_ready: AtomicBool,
}

impl NativeMenuState {
    pub fn new() -> Self {
        Self {
            actions: Mutex::new(BTreeMap::new()),
            renderer_ready: AtomicBool::new(false),
        }
    }

    fn replace_actions(&self, actions: BTreeMap<String, MenuAction>) -> Result<(), String> {
        *self
            .actions
            .lock()
            .map_err(|_| "native menu action state is poisoned".to_owned())? = actions;
        self.renderer_ready.store(true, Ordering::Release);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn install_bootstrap(
    app: &mut App,
    bindings: &BTreeMap<String, Keybinding>,
) -> Result<(), String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    let application = Submenu::with_id(app, "bootstrap-application", "rdc", true)
        .map_err(|error| error.to_string())?;
    application
        .append(&PredefinedMenuItem::hide(app, None).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    application
        .append(&PredefinedMenuItem::hide_others(app, None).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    application
        .append(&PredefinedMenuItem::show_all(app, None).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    application
        .append(&PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;

    let accelerator = bindings.get("quit").map(accelerator_text);
    application
        .append(
            &MenuItem::with_id(app, "quit", "Quit rdc", true, accelerator.as_deref())
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    menu.append(&application)
        .map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;

    let state = app.state::<NativeMenuState>();
    state
        .actions
        .lock()
        .map_err(|_| "native menu state is poisoned".to_owned())?
        .insert("quit".to_owned(), MenuAction::Quit);
    Ok(())
}

pub fn replace_native_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &NativeMenuState,
    model: &MenuModel,
    bindings: &BTreeMap<String, Keybinding>,
) -> Result<(), String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    let mut actions = BTreeMap::new();
    for item in &model.items {
        if let Some(item) = build_item(app, item, bindings, &mut actions)? {
            append_to_menu(&menu, &item).map_err(|error| error.to_string())?;
        }
    }
    app.set_menu(menu).map_err(|error| error.to_string())?;
    state.replace_actions(actions)
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    let state = app.state::<NativeMenuState>();
    let action = state
        .actions
        .lock()
        .ok()
        .and_then(|actions| actions.get(id).cloned());
    let Some(action) = action else {
        return;
    };

    if action == MenuAction::Quit && !state.renderer_ready.load(Ordering::Acquire) {
        app.exit(0);
        return;
    }

    let _ = app.emit(MENU_EVENT, action);
}

enum BuiltItem<R: Runtime> {
    Normal(MenuItem<R>),
    Submenu(Submenu<R>),
    Predefined(PredefinedMenuItem<R>),
    Check(CheckMenuItem<R>),
}

fn build_item<R: Runtime>(
    app: &AppHandle<R>,
    model: &MenuItemModel,
    bindings: &BTreeMap<String, Keybinding>,
    actions: &mut BTreeMap<String, MenuAction>,
) -> Result<Option<BuiltItem<R>>, String> {
    match model {
        MenuItemModel::Separator { visible, .. } => {
            if !visible {
                return Ok(None);
            }
            PredefinedMenuItem::separator(app)
                .map(BuiltItem::Predefined)
                .map(Some)
                .map_err(|error| error.to_string())
        }
        MenuItemModel::MenuItem {
            id,
            enabled,
            visible,
            label,
            action,
            role,
            ..
        } => {
            if !visible {
                return Ok(None);
            }
            if let Some(action) = action {
                actions.insert(id.clone(), action.clone());
            } else if let Some(role) = role {
                return predefined_item(app, *role, label)
                    .map(BuiltItem::Predefined)
                    .map(Some);
            }
            let accelerator = bindings.get(id).map(accelerator_text);
            MenuItem::with_id(app, id, label, *enabled, accelerator.as_deref())
                .map(BuiltItem::Normal)
                .map(Some)
                .map_err(|error| error.to_string())
        }
        MenuItemModel::SubmenuItem {
            id,
            enabled,
            visible,
            label,
            menu,
            role,
            ..
        } => {
            if !visible {
                return Ok(None);
            }
            if *role == Some(NativeMenuRole::Services) {
                return predefined_item(app, NativeMenuRole::Services, label)
                    .map(BuiltItem::Predefined)
                    .map(Some);
            }

            let submenu =
                Submenu::with_id(app, id, label, *enabled).map_err(|error| error.to_string())?;
            for child in &menu.items {
                if let Some(child) = build_item(app, child, bindings, actions)? {
                    append_to_submenu(&submenu, &child).map_err(|error| error.to_string())?;
                }
            }
            #[cfg(target_os = "macos")]
            match role {
                Some(NativeMenuRole::Window) => submenu
                    .set_as_windows_menu_for_nsapp()
                    .map_err(|error| error.to_string())?,
                Some(NativeMenuRole::Help) => submenu
                    .set_as_help_menu_for_nsapp()
                    .map_err(|error| error.to_string())?,
                _ => {}
            }
            Ok(Some(BuiltItem::Submenu(submenu)))
        }
        MenuItemModel::Checkbox {
            id,
            enabled,
            visible,
            label,
            checked,
            action,
            ..
        }
        | MenuItemModel::Radio {
            id,
            enabled,
            visible,
            label,
            checked,
            action,
            ..
        } => {
            if !visible {
                return Ok(None);
            }
            if let Some(action) = action {
                actions.insert(id.clone(), action.clone());
            }
            let accelerator = bindings.get(id).map(accelerator_text);
            CheckMenuItem::with_id(app, id, label, *enabled, *checked, accelerator.as_deref())
                .map(BuiltItem::Check)
                .map(Some)
                .map_err(|error| error.to_string())
        }
    }
}

fn predefined_item<R: Runtime>(
    app: &AppHandle<R>,
    role: NativeMenuRole,
    label: &str,
) -> Result<PredefinedMenuItem<R>, String> {
    // The TypeScript normalizer uses the role's wire value as a structural fallback label.
    // Passing that fallback into muda would replace localized labels such as "Hide rdc" with
    // lowercase implementation names such as "hide".
    let label = explicit_role_label(role, label);
    let result = match role {
        NativeMenuRole::Services => PredefinedMenuItem::services(app, label),
        NativeMenuRole::Hide => PredefinedMenuItem::hide(app, label),
        NativeMenuRole::HideOthers => PredefinedMenuItem::hide_others(app, label),
        NativeMenuRole::Unhide => PredefinedMenuItem::show_all(app, label),
        NativeMenuRole::Quit => PredefinedMenuItem::quit(app, label),
        NativeMenuRole::Undo => PredefinedMenuItem::undo(app, label),
        NativeMenuRole::Redo => PredefinedMenuItem::redo(app, label),
        NativeMenuRole::Cut => PredefinedMenuItem::cut(app, label),
        NativeMenuRole::Copy => PredefinedMenuItem::copy(app, label),
        NativeMenuRole::Paste => PredefinedMenuItem::paste(app, label),
        NativeMenuRole::SelectAll => PredefinedMenuItem::select_all(app, label),
        NativeMenuRole::Minimize => PredefinedMenuItem::minimize(app, label),
        NativeMenuRole::Zoom => PredefinedMenuItem::maximize(app, label),
        NativeMenuRole::Close => PredefinedMenuItem::close_window(app, label),
        NativeMenuRole::Front => PredefinedMenuItem::bring_all_to_front(app, label),
        NativeMenuRole::ToggleFullscreen => PredefinedMenuItem::fullscreen(app, label),
        NativeMenuRole::Window | NativeMenuRole::Help => {
            return Err(format!("submenu-only native role used on item: {role:?}"));
        }
    };
    result.map_err(|error| error.to_string())
}

fn explicit_role_label(role: NativeMenuRole, label: &str) -> Option<&str> {
    (label != role_name(role) && !label.is_empty()).then_some(label)
}

fn role_name(role: NativeMenuRole) -> &'static str {
    match role {
        NativeMenuRole::Services => "services",
        NativeMenuRole::Hide => "hide",
        NativeMenuRole::HideOthers => "hideOthers",
        NativeMenuRole::Unhide => "unhide",
        NativeMenuRole::Quit => "quit",
        NativeMenuRole::Undo => "undo",
        NativeMenuRole::Redo => "redo",
        NativeMenuRole::Cut => "cut",
        NativeMenuRole::Copy => "copy",
        NativeMenuRole::Paste => "paste",
        NativeMenuRole::SelectAll => "selectAll",
        NativeMenuRole::Minimize => "minimize",
        NativeMenuRole::Zoom => "zoom",
        NativeMenuRole::Close => "close",
        NativeMenuRole::Front => "front",
        NativeMenuRole::Window => "window",
        NativeMenuRole::Help => "help",
        NativeMenuRole::ToggleFullscreen => "togglefullscreen",
    }
}

fn append_to_menu<R: Runtime>(menu: &Menu<R>, item: &BuiltItem<R>) -> tauri::Result<()> {
    match item {
        BuiltItem::Normal(item) => menu.append(item),
        BuiltItem::Submenu(item) => menu.append(item),
        BuiltItem::Predefined(item) => menu.append(item),
        BuiltItem::Check(item) => menu.append(item),
    }
}

fn append_to_submenu<R: Runtime>(menu: &Submenu<R>, item: &BuiltItem<R>) -> tauri::Result<()> {
    match item {
        BuiltItem::Normal(item) => menu.append(item),
        BuiltItem::Submenu(item) => menu.append(item),
        BuiltItem::Predefined(item) => menu.append(item),
        BuiltItem::Check(item) => menu.append(item),
    }
}

fn accelerator_text(binding: &Keybinding) -> String {
    binding
        .modifiers
        .iter()
        .map(|modifier| match modifier {
            KeybindingModifier::Alt => "Alt",
            KeybindingModifier::Control => "Control",
            KeybindingModifier::Meta => "Command",
            KeybindingModifier::Shift => "Shift",
        })
        .chain(std::iter::once(binding.key.as_str()))
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::{accelerator_text, explicit_role_label};
    use crate::platform::keybinding_model::{Keybinding, KeybindingModifier};
    use crate::platform::menu_model::NativeMenuRole;

    #[test]
    fn converts_structured_bindings_only_at_the_native_api_boundary() {
        assert_eq!(
            accelerator_text(&Keybinding {
                modifiers: vec![KeybindingModifier::Alt, KeybindingModifier::Meta],
                key: "KeyI".to_owned(),
            }),
            "Alt+Command+KeyI"
        );
    }

    #[test]
    fn leaves_structural_role_names_to_the_native_localizer() {
        assert_eq!(explicit_role_label(NativeMenuRole::Hide, "hide"), None);
        assert_eq!(explicit_role_label(NativeMenuRole::Cut, "Cut"), Some("Cut"));
    }
}
