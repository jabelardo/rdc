// The IPC surface lives in `commands`; see that module for the conventions.
mod commands;

// WebKitGTK's native-Wayland GPU compositing path has known unresolved
// crash/render bugs as of 2026 (e.g. tauri-apps/wry#1727), and Wayland is
// now the only session type on the project's primary target (GNOME/KDE
// both dropped native X11). Force software compositing unconditionally
// rather than betting on GPU-accelerated Wayland rendering being stable —
// must be set before the webview initializes.
#[cfg(target_os = "linux")]
fn disable_webkit_compositing() {
    // SAFETY: called once, single-threaded, before any GTK/WebKitGTK
    // initialization — no concurrent env access exists yet at this point.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    disable_webkit_compositing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::git::get_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
