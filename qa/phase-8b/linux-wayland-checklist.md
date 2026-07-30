# Ubuntu 26.04 native-Wayland checklist

- Confirm the session is native Wayland (`XDG_SESSION_TYPE=wayland`) and record compositor, WebKitGTK,
  Tauri and system Git versions.
- Launch the development build with `WEBKIT_DISABLE_COMPOSITING_MODE=1` supplied by rdc startup code,
  not an interactive-shell workaround.
- Resize repeatedly between normal and compact widths; move, maximize, restore and refocus the window.
  Look specifically for startup crashes, blur, stale frames, missing repaint and misplaced popup menus.
- Complete the generated fixture's status/diff, discard, commit, History, branch, Fetch, Pull, Push and
  Clone journeys. Confirm selection persists after a complete process restart.
- Exercise native open/save dialogs, file manager, editor and terminal launch on the installed desktop.
- Complete keyboard/modal/accessibility checks and every Linux row in `visual-matrix.md`.
- Confirm config and logs live below the identifier-scoped XDG directories and inspect the log for
  renderer/native errors.

The Xvfb WebDriver suite is prerequisite automation, not a substitute for this rendering check.
