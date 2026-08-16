# Visual review matrix

Enter this matrix only after both `baseline-layout-checklist.md` and all five gates in
`selected-repository-baseline-checklist.md` pass on the platform being tested. This matrix refines a
settled shell across themes and sizes; it is not where the toolbar, navigation or workspace frame is
decided.

Review Changes and History with the Repositories/Branches sidebar expanded and collapsed. For every
cell inspect hierarchy, density, alignment, truncation, focus indication, semantic diff colors,
empty/loading/error states and toolbar grouping. Validate against Desktop Plus's successful
principles and native platform conventions without copying its layout or values.

**Tooltips near a window edge are worth a deliberate look in every cell.** They were positioning
themselves off-screen at the left edge until 2026-08-16, and the arithmetic that fixes it is now
unit-tested — but only the arithmetic. Whether Radix applies it is a browser-level behaviour no test
in this repository reaches, and it differs between WKWebView and WebKitGTK. Hover the sidebar
resizer with the sidebar collapsed (its trigger sits ~100px from the left, and its bubble is wide
enough to want to overflow), then the leftmost and rightmost toolbar buttons.

| Platform/session | Viewport | Light | Dark | System |
|---|---|---|---|---|
| macOS native WKWebView | normal (at least 1100×720) | pending | pending | pending |
| macOS native WKWebView | default (800×600) | pending | pending | pending |
| macOS native WKWebView | compact width (715×720) | pending | pending | pending |
| Fedora 44 Wayland (Bluefin host) | normal (at least 1100×720) | approved 2026-08-02 | approved 2026-08-02 | — |
| Fedora 44 Wayland (Bluefin host) | default (800×600) | approved 2026-08-02 | approved 2026-08-02 | — |
| Fedora 44 Wayland (Bluefin host) | compact width (715×720) | approved 2026-08-02 | approved 2026-08-02 | — |

Gate E separately owns the 715×356 native floor and continuous transitions. The compact visual row
keeps enough height to judge hierarchy while using the narrowest supported width; do not resurrect
the obsolete, unreachable 620 px endpoint.

Review the cells in this order per platform: normal Light, default Light, compact Light, then normal,
default and compact Dark/System. For each cell capture representative presentation states rather
than repeating every functional workflow:

- `clean` and `populated` scenario states.
- Changes list, selected text diff, commit form and progress/error presentation.
- History list, commit metadata, changed files and selected diff.
- Sidebar panel disclosure, whole-sidebar collapse and long repository/file names.
- Keyboard focus, Reduce Motion and increased-contrast/forced-colors behavior where the OS exposes it.

Use the manifest's named reproducible states rather than trying to catch transient UI by eye:
`clean` for clean Changes/History; `populated` for working-tree and long-name states; `delayedPush`
for progress; `commitHook` for terminal/error presentation; and `unreachableRemote` or a missing
integration for actionable failure presentation. Record which scenario backs each capture.

## Post-MVP follow-ups from the Linux Wayland cycle

- **Sidebar section disclosure in expanded cells**: the REPOSITORIES and BRANCHES sections
  remained collapsed in every "expanded" cell. The driver does not explicitly expand them; the
  sidebar is visible but empty. Verify whether the matrix intends section content to be visible
  when the sidebar is "expanded", and if so, drive the sections open. Non-blocking for MVP.
