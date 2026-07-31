# macOS development-build checklist

WKWebView has no supported `tauri-driver` backend. This checklist and its evidence are the macOS
native acceptance record; do not label it automated.

## 1. Foundation prerequisites

- Run `baseline-layout-checklist.md` in expanded and collapsed states at 800×600.
- With the generated `primary` fixture selected, pass Gates A, B, C, D and E in
  `selected-repository-baseline-checklist.md` before testing toolbar actions or repository workflows.
- Move, resize, maximize and restore the overlay-titlebar window. Double-click the persistent drag
  strip under each available `AppleActionOnDoubleClick` behavior; no rejected promise may appear.
- Complete the macOS visual-matrix cells in their specified order before functional workflows.

## 2. Read-only repository journey

- Launch with clean config/data, add `primary`, inspect status and text diff, switch to History and
  inspect commit metadata/files/diff, then quit and relaunch. Repository registration, selection and
  view geometry must persist as designed.
- Exercise repository/sidebar selection, Changes/History navigation and refresh without a pointer.

## 3. Reversible local journey

- Include/exclude a file and individual diff lines, then restore the fixture's intended selection.
- Create and check out a branch, then return to the original branch.

## 4. Mutating local journey

- Discard a selected line and a whole file using a disposable fixture reset between destructive
  checks.
- Commit the intended selection, exercise the hook prompt/terminal output, and complete the minimum
  supported merge-conflict resolution without leaving the repository stranded.

## 5. Remote journey

- Using the generated local bare remote, run Fetch before Pull, then unpublished-branch Push, and
  finally Clone into a fresh destination. Verify progress, disabled/running/error presentation does
  not disturb the accepted toolbar/workspace frame.

## 6. Native integrations, accessibility and lifecycle

- Open every enabled MVP native-menu item. Confirm labels, accelerators, enablement, Preferences,
  About, dialogs and contextual menus target the focused repository window.
- Launch the selected editor, terminal and Finder action. Missing integrations fail visibly without
  presenting a hollow success.
- Complete Preferences, dialogs and repository/change/history navigation without a pointer. Verify
  modal focus entry, both Tab boundaries, Escape policy and focus restoration.
- Request close with ordinary state and during protected work; confirm hide/quit policy,
  last-window behavior and clean relaunch.
- Record config/log locations and inspect the log after each group for renderer rejections or native
  errors, then perform one final log review.
