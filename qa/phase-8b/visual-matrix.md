# Visual review matrix

Enter this matrix only after `baseline-layout-checklist.md` passes. This matrix refines a settled
shell across themes, sizes and platforms; it is not where the top-level application structure is
decided.

Review Changes and History with the Repositories/Branches sidebar expanded and collapsed. For every
cell inspect hierarchy, density, alignment, truncation, focus indication, semantic diff colors,
empty/loading/error states and toolbar grouping. Validate against Desktop Plus's successful
principles and native platform conventions without copying its layout or values.

| Platform/session | Viewport | Light | Dark | System |
|---|---|---|---|---|
| macOS native WKWebView | normal (at least 1100×720) | pending | pending | pending |
| macOS native WKWebView | compact (620×720) | pending | pending | pending |
| Ubuntu 26.04 native Wayland | normal (at least 1100×720) | pending | pending | pending |
| Ubuntu 26.04 native Wayland | compact (620×720) | pending | pending | pending |

For each cell capture:

- Empty repository and populated fixture states.
- Changes list, selected text diff, commit form and progress/error presentation.
- History list, commit metadata, changed files and selected diff.
- Sidebar panel disclosure, whole-sidebar collapse and long repository/file names.
- Keyboard focus, Reduce Motion and increased-contrast/forced-colors behavior where the OS exposes it.
