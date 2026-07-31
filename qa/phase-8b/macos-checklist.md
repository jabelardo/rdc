# macOS development-build checklist

- Run `baseline-layout-checklist.md` in expanded and collapsed states at the default 800×600 window
  before the platform workflow checks below. This result establishes only the macOS baseline.
- Launch with a clean rdc config/data state; add the generated `primary` fixture and confirm selection
  survives a complete quit and relaunch.
- Move the overlay-titlebar window before and after scrolling. Double-click the drag strip under each
  `AppleActionOnDoubleClick` behavior available on the test machine; no rejected promise may appear.
- Open every enabled native menu item used by the MVP. Confirm labels, accelerators, enablement,
  Preferences/About, dialogs and contextual menus target the focused repository window.
- Complete status/diff, include/exclude, discard, commit, History, branch create/checkout, Fetch, Pull,
  unpublished-branch Push and Clone journeys using the generated local remote.
- Launch the selected external editor, terminal and file manager. Missing integrations must fail
  visibly without presenting a hollow success.
- Request close with ordinary state and during protected work; confirm hide/quit policy, last-window
  behavior and clean relaunch.
- Complete Preferences and repository/change/history navigation without a pointer. Verify modal focus
  entry, both Tab boundaries, Escape policy and focus restoration.
- Review Light/Dark/System, normal/compact, Reduce Motion and increased-contrast presentation using
  `visual-matrix.md`.
- Record log/config locations and inspect the log for unhandled renderer rejections or native errors.

WKWebView has no supported `tauri-driver` backend. This checklist and its evidence are the macOS
native acceptance record; do not label it automated.
