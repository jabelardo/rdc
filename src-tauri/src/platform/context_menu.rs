use super::context_menu_model::{ContextMenuItemModel, ContextMenuItemType, ContextMenuRole};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Runtime, WebviewWindow,
};
use tokio::sync::oneshot;

const ITEM_ID_PREFIX: &str = "rdc-context-menu:";

pub struct ContextMenuState {
    next_token: AtomicU64,
    pending: Mutex<BTreeMap<u64, PendingMenu>>,
    item_paths: Mutex<BTreeMap<String, (u64, Vec<usize>)>>,
}

struct PendingMenu {
    sender: oneshot::Sender<Option<Vec<usize>>>,
}

struct StartedMenu {
    token: u64,
    plan: Vec<PlannedItem>,
    receiver: oneshot::Receiver<Option<Vec<usize>>>,
}

impl ContextMenuState {
    pub fn new() -> Self {
        Self {
            next_token: AtomicU64::new(1),
            pending: Mutex::new(BTreeMap::new()),
            item_paths: Mutex::new(BTreeMap::new()),
        }
    }

    fn start(&self, items: &[ContextMenuItemModel]) -> Result<StartedMenu, String> {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let mut next_item = 0;
        let mut paths = BTreeMap::new();
        let plan = plan_items(items, token, &[], &mut next_item, &mut paths)?;
        let (sender, receiver) = oneshot::channel();

        self.pending
            .lock()
            .map_err(|_| "context menu state is poisoned".to_owned())?
            .insert(token, PendingMenu { sender });
        self.item_paths
            .lock()
            .map_err(|_| "context menu item state is poisoned".to_owned())?
            .extend(paths);

        Ok(StartedMenu {
            token,
            plan,
            receiver,
        })
    }

    fn finish(&self, token: u64, selection: Option<Vec<usize>>) -> bool {
        let pending = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&token));
        let Some(pending) = pending else {
            return false;
        };

        if let Ok(mut paths) = self.item_paths.lock() {
            paths.retain(|_, (item_token, _)| *item_token != token);
        }
        let _ = pending.sender.send(selection);
        true
    }

    pub fn handle_event(&self, id: &str) -> bool {
        let selected = self
            .item_paths
            .lock()
            .ok()
            .and_then(|paths| paths.get(id).cloned());
        let Some((token, path)) = selected else {
            return false;
        };
        self.finish(token, Some(path))
    }

    pub fn dismiss_pending(&self) {
        let tokens: Vec<u64> = self
            .pending
            .lock()
            .ok()
            .map(|pending| pending.keys().copied().collect())
            .unwrap_or_default();
        for token in tokens {
            self.finish(token, None);
        }
    }
}

#[derive(Debug, PartialEq)]
enum PlannedItem {
    Normal {
        id: String,
        label: String,
        enabled: bool,
        path: Vec<usize>,
    },
    Checkbox {
        id: String,
        label: String,
        enabled: bool,
        checked: bool,
        path: Vec<usize>,
    },
    Separator,
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<PlannedItem>,
    },
}

fn plan_items(
    items: &[ContextMenuItemModel],
    token: u64,
    parent_path: &[usize],
    next_item: &mut usize,
    paths: &mut BTreeMap<String, (u64, Vec<usize>)>,
) -> Result<Vec<PlannedItem>, String> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut path = parent_path.to_vec();
            path.push(index);

            if item.role == Some(ContextMenuRole::EditMenu) {
                return Err("the Wayland-safe edit context menu is deferred to Phase 7".to_owned());
            }
            if item.kind == Some(ContextMenuItemType::Separator) {
                return Ok(PlannedItem::Separator);
            }
            if let Some(submenu) = &item.submenu {
                return Ok(PlannedItem::Submenu {
                    label: item.label.clone().unwrap_or_default(),
                    enabled: item.enabled.unwrap_or(true),
                    items: plan_items(submenu, token, &path, next_item, paths)?,
                });
            }

            let id = format!("{ITEM_ID_PREFIX}{token}:{}", *next_item);
            *next_item += 1;
            paths.insert(id.clone(), (token, path.clone()));
            let label = item.label.clone().unwrap_or_default();
            let enabled = item.enabled.unwrap_or(true);
            if item.kind == Some(ContextMenuItemType::Checkbox) {
                Ok(PlannedItem::Checkbox {
                    id,
                    label,
                    enabled,
                    checked: item.checked.unwrap_or(false),
                    path,
                })
            } else {
                Ok(PlannedItem::Normal {
                    id,
                    label,
                    enabled,
                    path,
                })
            }
        })
        .collect()
}

enum BuiltContextItem<R: Runtime> {
    Normal(MenuItem<R>),
    Checkbox(CheckMenuItem<R>),
    Separator(PredefinedMenuItem<R>),
    Submenu(Submenu<R>),
}

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    plan: &[PlannedItem],
) -> Result<Vec<BuiltContextItem<R>>, String> {
    plan.iter()
        .map(|item| match item {
            PlannedItem::Normal {
                id, label, enabled, ..
            } => MenuItem::with_id(app, id, label, *enabled, None::<&str>)
                .map(BuiltContextItem::Normal)
                .map_err(|error| error.to_string()),
            PlannedItem::Checkbox {
                id,
                label,
                enabled,
                checked,
                ..
            } => CheckMenuItem::with_id(app, id, label, *enabled, *checked, None::<&str>)
                .map(BuiltContextItem::Checkbox)
                .map_err(|error| error.to_string()),
            PlannedItem::Separator => PredefinedMenuItem::separator(app)
                .map(BuiltContextItem::Separator)
                .map_err(|error| error.to_string()),
            PlannedItem::Submenu {
                label,
                enabled,
                items,
            } => {
                let submenu =
                    Submenu::new(app, label, *enabled).map_err(|error| error.to_string())?;
                for child in build_items(app, items)? {
                    append_item(&submenu, &child)?;
                }
                Ok(BuiltContextItem::Submenu(submenu))
            }
        })
        .collect()
}

fn append_item<R: Runtime>(menu: &Submenu<R>, item: &BuiltContextItem<R>) -> Result<(), String> {
    let result = match item {
        BuiltContextItem::Normal(item) => menu.append(item),
        BuiltContextItem::Checkbox(item) => menu.append(item),
        BuiltContextItem::Separator(item) => menu.append(item),
        BuiltContextItem::Submenu(item) => menu.append(item),
    };
    result.map_err(|error| error.to_string())
}

pub async fn show_contextual_menu<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    state: &ContextMenuState,
    items: &[ContextMenuItemModel],
) -> Result<Option<Vec<usize>>, String> {
    let StartedMenu {
        token,
        plan,
        receiver,
    } = state.start(items)?;
    let root = match Submenu::new(app, "", true) {
        Ok(root) => root,
        Err(error) => {
            state.finish(token, None);
            return Err(error.to_string());
        }
    };
    let built_items = match build_items(app, &plan) {
        Ok(items) => items,
        Err(error) => {
            state.finish(token, None);
            return Err(error);
        }
    };
    for item in built_items {
        if let Err(error) = append_item(&root, &item) {
            state.finish(token, None);
            return Err(error);
        }
    }

    let popup_result = window.popup_menu(&root);
    if let Err(error) = popup_result {
        state.finish(token, None);
        return Err(error.to_string());
    }

    let app_for_marker = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        app_for_marker
            .state::<ContextMenuState>()
            .finish(token, None);
    }) {
        state.finish(token, None);
        return Err(error.to_string());
    }

    receiver
        .await
        .map_err(|_| "context menu result channel closed".to_owned())
}

pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    app.state::<ContextMenuState>().handle_event(id)
}

#[cfg(test)]
mod tests {
    use super::{
        plan_items, ContextMenuItemModel, ContextMenuItemType, ContextMenuRole, PlannedItem,
    };
    use std::collections::BTreeMap;

    fn item(label: &str) -> ContextMenuItemModel {
        ContextMenuItemModel {
            label: Some(label.to_owned()),
            kind: None,
            checked: None,
            enabled: None,
            role: None,
            submenu: None,
        }
    }

    #[test]
    fn preserves_renderer_indices_through_nested_items_and_separators() {
        let items = vec![
            ContextMenuItemModel {
                submenu: Some(vec![
                    ContextMenuItemModel {
                        kind: Some(ContextMenuItemType::Separator),
                        ..item("")
                    },
                    ContextMenuItemModel {
                        kind: Some(ContextMenuItemType::Checkbox),
                        checked: Some(true),
                        enabled: Some(false),
                        ..item("Chosen")
                    },
                ]),
                ..item("Parent")
            },
            item("Last"),
        ];
        let mut next_item = 0;
        let mut paths = BTreeMap::new();

        let plan = plan_items(&items, 7, &[], &mut next_item, &mut paths).expect("valid plan");

        assert_eq!(
            plan,
            vec![
                PlannedItem::Submenu {
                    label: "Parent".to_owned(),
                    enabled: true,
                    items: vec![
                        PlannedItem::Separator,
                        PlannedItem::Checkbox {
                            id: "rdc-context-menu:7:0".to_owned(),
                            label: "Chosen".to_owned(),
                            enabled: false,
                            checked: true,
                            path: vec![0, 1],
                        },
                    ],
                },
                PlannedItem::Normal {
                    id: "rdc-context-menu:7:1".to_owned(),
                    label: "Last".to_owned(),
                    enabled: true,
                    path: vec![1],
                },
            ]
        );
        assert_eq!(paths.get("rdc-context-menu:7:0"), Some(&(7, vec![0, 1])));
    }

    #[test]
    fn refuses_the_edit_placeholder_until_the_wayland_safe_phase_7_path_exists() {
        let items = vec![ContextMenuItemModel {
            role: Some(ContextMenuRole::EditMenu),
            ..item("")
        }];

        let error = plan_items(&items, 1, &[], &mut 0, &mut BTreeMap::new())
            .expect_err("edit menu is deliberately deferred");

        assert!(error.contains("Phase 7"));
    }

    #[tokio::test]
    async fn selection_resolves_the_pending_popup_and_removes_its_ids() {
        let state = super::ContextMenuState::new();
        let started = state.start(&[item("Chosen")]).expect("starts");

        assert!(state.handle_event("rdc-context-menu:1:0"));
        assert_eq!(
            started.receiver.await.expect("sender remains"),
            Some(vec![0])
        );
        assert!(!state.handle_event("rdc-context-menu:1:0"));
    }

    #[tokio::test]
    async fn dismissal_resolves_null() {
        let state = super::ContextMenuState::new();
        let started = state.start(&[item("Ignored")]).expect("starts");

        assert!(state.finish(started.token, None));
        assert_eq!(started.receiver.await.expect("sender remains"), None);
    }

    #[tokio::test]
    async fn dismiss_pending_resolves_every_open_popup_as_null() {
        let state = super::ContextMenuState::new();
        let first = state.start(&[item("A")]).expect("starts");
        let second = state.start(&[item("B")]).expect("starts");

        state.dismiss_pending();

        assert_eq!(first.receiver.await.expect("sender remains"), None);
        assert_eq!(second.receiver.await.expect("sender remains"), None);
        // Both tokens are gone, so neither selection can resolve a second time.
        assert!(!state.handle_event("rdc-context-menu:1:0"));
        assert!(!state.handle_event("rdc-context-menu:2:0"));
    }
}
