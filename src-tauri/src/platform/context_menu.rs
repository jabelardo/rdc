//! The ephemeral popup menu behind `show_context_menu_at`.
//!
//! Deliberately separate from `menu.rs`'s app-level [`MenuAction`]/`NativeMenuState`: those model
//! a single persistent menu whose items always act on "whatever is currently selected" (the
//! checked-out branch, the selected repository). A context menu is invoked per-row and has to act
//! on *that* row regardless of what's selected elsewhere, so its items carry no action of their
//! own — the frontend keeps the per-invocation closure and this module only relays back which id
//! was picked.
//!
//! Linux drives GTK directly rather than going through muda; see [`popup_non_blocking`].

use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Runtime,
};

/// Emitted to the frontend with the selected item's id. Ids are per-invocation and carry a random
/// token, so a menu opened in one window can't be confused with one opened in another.
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

#[cfg(not(target_os = "linux"))]
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

/// Pop up a GTK menu and return immediately, without waiting for it to be dismissed.
///
/// This bypasses muda (and so Tauri's `popup_menu`/`popup_menu_at`) on Linux, because muda's GTK
/// backend cannot survive the interaction this project kept hitting on Wayland. Its
/// `show_context_menu` (`muda-0.19.3/src/platform_impl/gtk/mod.rs:1416-1500`) raises the menu and
/// then blocks in a hand-rolled `loop { gtk::main_iteration() }` fed only by `connect_cancel` and
/// `connect_selection_done`, with no `grab-broken` handler and no timeout. When the popup is
/// anchored to the real window — which is exactly what positioning it correctly requires — the
/// compositor treats it as a child surface of that window and *withdraws it* when the window loses
/// focus, emitting neither of those two signals. Nothing then breaks the loop, so the main thread
/// stays inside a nested GTK main loop: the app keeps repainting, but every later popup, menu
/// action and window-close request that needs the main thread never completes. Passing no position
/// avoided the wedge only because it anchors to the root window instead, which is not a real child
/// popup — the same reason it lands in the middle of the screen and warns about a missing parent.
///
/// Owning the popup here removes the trap rather than working around it: item activation is
/// reported through `activate` (which fires when it fires), dismissal needs no signal at all
/// because nothing is waiting on one, and the compositor withdrawing the menu is simply the menu
/// going away.
#[cfg(target_os = "linux")]
pub fn popup_non_blocking(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    items: Vec<ContextMenuItemModel>,
) -> Result<(), String> {
    use tauri::Manager;

    let app = window.app_handle().clone();
    // GTK objects are main-thread only, and a `#[tauri::command]` does not run there. Nothing after
    // this point can be reported to the caller — the closure runs after the command has already
    // returned — so a failure to show the menu is logged rather than surfaced. Deliberate: the
    // alternative is holding the command open until the popup has been raised, and waiting on the
    // popup is the entire class of bug this function exists to avoid.
    app.clone()
        .run_on_main_thread(move || {
            if let Err(error) = popup_on_main_thread(&app, &window, x, y, &items) {
                log::error!("could not show the context menu: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn popup_on_main_thread(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    items: &[ContextMenuItemModel],
) -> Result<(), String> {
    use gtk::gdk;
    use gtk::glib;
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::*;
    use tauri::Emitter;

    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let gdk_window = gtk_window
        .window()
        .ok_or_else(|| "the window is not realized yet".to_owned())?;

    let menu = gtk::Menu::new();
    for item in items {
        match item {
            ContextMenuItemModel::Separator => {
                menu.append(&gtk::SeparatorMenuItem::new());
            }
            ContextMenuItemModel::Item { id, label, enabled } => {
                let menu_item = gtk::MenuItem::with_label(label);
                menu_item.set_sensitive(*enabled);
                let app = app.clone();
                let id = id.clone();
                menu_item.connect_activate(move |_| {
                    let _ = app.emit(CONTEXT_MENU_EVENT, &id);
                });
                menu.append(&menu_item);
            }
        }
    }
    menu.show_all();

    // Hold a reference to the menu that is currently up, so it survives the end of this function,
    // and dismiss whichever menu it replaces — see `retain`.
    retain(menu.clone());
    menu.connect_hide(|menu| {
        let menu = menu.clone();
        // Dropping the widget from inside its own signal emission would free memory GTK is still
        // walking, so release it once the emission has finished.
        glib::idle_add_local_once(move || release(&menu));
    });

    // GTK dismisses a menu again on the button release that opened it unless the triggering event
    // carries a timestamp, and a synthetic event has none. Same workaround muda applies.
    let mut event = gdk::Event::new(gdk::EventType::ButtonPress);
    event.set_device(
        gdk_window
            .display()
            .default_seat()
            .and_then(|seat| seat.pointer())
            .as_ref(),
    );
    let event_ptr: *mut gdk::ffi::GdkEvent = event.to_glib_none().0;
    if !event_ptr.is_null() {
        // SAFETY: `event_ptr` borrows the live GdkEvent owned by `event`, is checked non-null, and
        // this runs on the main thread, so nothing else is touching it.
        unsafe {
            (*event_ptr).button.time = (glib::monotonic_time() / 1000) as _;
        }
    }

    // `x`/`y` arrive relative to the webview, which is the one side that knows the zoom factor;
    // GTK wants them relative to the window. Translate from the webview widget itself, *not* from
    // the container holding it: tauri packs the GTK menu bar into that same container and reorders
    // it to the front (muda's `init_for_gtk_window`), so the container's origin is above the menu
    // bar while `clientY` is measured from below it — anchoring off the container would put every
    // popup a menu-bar height too high. Asking GTK also means no height is ever assumed, so this
    // stays exact across desktop environments and themes, whether or not the menu bar is shown,
    // and collapses to zero in custom-title-bar mode where nothing sits above the webview.
    let (offset_x, offset_y) = window
        .default_vbox()
        .ok()
        .and_then(|vbox| webview_child(&vbox))
        .and_then(|webview| webview.translate_coordinates(&gtk_window, 0, 0))
        .unwrap_or((0, 0));

    menu.popup_at_rect(
        &gdk_window,
        &gdk::Rectangle::new(x as i32 + offset_x, y as i32 + offset_y, 0, 0),
        gdk::Gravity::NorthWest,
        gdk::Gravity::NorthWest,
        Some(&event),
    );
    Ok(())
}

/// The webview inside the window's default container, skipping the GTK menu bar tauri packs into
/// that same container.
#[cfg(target_os = "linux")]
fn webview_child(vbox: &gtk::Box) -> Option<gtk::Widget> {
    use gtk::prelude::*;

    vbox.children()
        .into_iter()
        .find(|child| child.downcast_ref::<gtk::MenuBar>().is_none())
}

// Main-thread only, like every GTK object it holds, so this needs no lock.
#[cfg(target_os = "linux")]
thread_local! {
    static CURRENT_MENU: std::cell::RefCell<Option<gtk::Menu>> =
        const { std::cell::RefCell::new(None) };
}

/// Makes `menu` the current one, dismissing whichever it replaces.
///
/// The previous menu is popped down rather than merely dropped. A menu that is still up holds a GTK
/// grab, which redirects all input in the window group to it, and its own refcount keeps it alive
/// regardless of this handle — so dropping the last handle would strand that grab with nothing left
/// to release it, leaving the window input-dead. That is the same failure this module exists to
/// avoid, and it is reachable without any compositor involvement: opening a menu takes several IPC
/// round-trips, so two quick triggers can both be in flight at once.
#[cfg(target_os = "linux")]
fn retain(menu: gtk::Menu) {
    use gtk::prelude::*;

    // Replace before popping down, so the borrow is released first: `popdown` emits `hide`, whose
    // handler must be free to touch this same cell.
    let previous = CURRENT_MENU.with(|current| current.borrow_mut().replace(menu));
    if let Some(previous) = previous {
        previous.popdown();
    }
}

/// Releases `menu` only if it is still the current one. A menu's `hide` can arrive after the next
/// menu has already been opened, and clearing unconditionally would drop the reference to *that*
/// one instead.
#[cfg(target_os = "linux")]
fn release(menu: &gtk::Menu) {
    use gtk::glib::translate::ToGlibPtr;

    CURRENT_MENU.with(|current| {
        let mut current = current.borrow_mut();
        let is_same = current.as_ref().is_some_and(|held| {
            let held: *mut gtk::ffi::GtkMenu = held.to_glib_none().0;
            let menu: *mut gtk::ffi::GtkMenu = menu.to_glib_none().0;
            std::ptr::eq(held, menu)
        });
        if is_same {
            *current = None;
        }
    });
}
