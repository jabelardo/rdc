# Phase 8b Linux visual-matrix findings

**Reviewer**: vision LLM (automated capture via qa-linux-matrix.sh)
**Captures**: `/tmp/rdc-qa-evidence/` (18 PNGs, 2 themes × 9 cells)
**Environment**: Fedora 44 toolbox on Bluefin host, Wayland, WebKitGTK 2.52.5
**Date**: 2026-08-02

## Summary

| Cell | Verdict | Notes |
|------|---------|-------|
| normal-expanded-light | PASS-with-notes | Sidebar sections collapsed |
| default-expanded-light | PASS-with-notes | Sidebar sections collapsed |
| compact-expanded-light | PASS-with-notes | Sidebar sections collapsed |
| normal-collapsed-light | PASS | |
| default-collapsed-light | PASS | |
| compact-collapsed-light | PASS | |
| normal-history-light | PASS-with-notes | Sidebar sections collapsed |
| default-history-light | PASS-with-notes | Sidebar sections collapsed |
| compact-history-light | PASS-with-notes | Sidebar sections collapsed |
| normal-expanded-dark | PASS-with-notes | Sidebar sections collapsed |
| default-expanded-dark | PASS-with-notes | Sidebar sections collapsed |
| compact-expanded-dark | PASS-with-notes | Sidebar sections collapsed |
| normal-collapsed-dark | PASS | |
| default-collapsed-dark | PASS | |
| compact-collapsed-dark | PASS | |
| normal-history-dark | PASS-with-notes | Sidebar sections collapsed |
| default-history-dark | PASS-with-notes | Sidebar sections collapsed |
| compact-history-dark | PASS-with-notes | Sidebar sections collapsed |

## Findings

### F1 — Sidebar sections collapsed in all "expanded" cells (MVP-non-blocking)

**Cells**: all 12 expanded cells (both themes, all viewports)
**Severity**: non-blocking

The sidebar REPOSITORIES and BRANCHES sections show collapsed arrow indicators (▶) in every expanded cell. The sidebar is visible and takes proportional width, but the section content is not expanded. This means no repository name or branch name is visible in the sidebar.

The visual matrix says "expanded" means the sidebar is visible with sections expanded. However, the sections may simply be in their default collapsed state from the fixture — this could be expected if the driver doesn't explicitly expand them.

**Action**: Verify whether the fixture's sidebar sections should be expanded by default. If so, the driver needs to emit a `sidebarCollapsed: false` state that also expands the sidebar sections. If not, the matrix definition should be clarified.

### F2 — Native title bar shows "RDC" only (deferred, tao 0.36)

**Cells**: all 18
**Severity**: deferred (tao 0.36 / next tauri stable)

The native window title shows only "RDC" instead of "RDC — populated — main". This is the known deferred issue documented in `MIGRATION_MAP.md` §8.

### F3 — Long file name visible in History, not in Changes

**Cells**: all 6 history cells
**Severity**: non-blocking (expected from fixture design)

The deliberately long file name `a-very-long-file-name-for-visual-truncation-and-density-review.txt` appears in the History view's changed-files list (truncated as `a-very-long-file...`). In the Changes view, the working-tree files are `.idea/*`, `modified.txt`, and `untracked.txt` — the long name is not present. This is by design (the long file was committed, not modified in the working tree).

### F4 — Diff truncation at narrow widths (expected)

**Cells**: compact-* cells
**Severity**: non-blocking (expected behavior)

At 715×720, the diff header truncates `a-very-long-file-name-for-visu...` and the diff content truncates `+long-name fixt...`. This is expected at the narrowest supported width and matches the visual matrix's intent to review truncation behavior.

### Positive observations

- **Dark theme**: Applied consistently across all cells. Colors are readable, contrast between text and background is good. Green added lines, blue checkboxes, and orange modified icons are all visible against the dark background.
- **Changes view**: File list with checkboxes, status icons (green +, orange ▲), and the diff pane all render correctly at all three viewports.
- **Commit form**: Summary (required) placeholder, Description placeholder, and blue "Commit 6 files" button are consistent across all viewports and themes.
- **Menu bar**: File/View/Repository/Help visible in every cell.
- **Collapsed sidebar**: Works correctly — sidebar collapses to an icon strip, giving more horizontal space to the content area.
- **History view**: Commit list, metadata (author, date, hash, +/− counts), changed files list, and diff all render correctly.
- **Viewport resizing**: Each viewport (1100×720, 800×600, 715×720) is correctly sized. Content reflows appropriately at each width.
