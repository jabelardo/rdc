# Linux Wayland visual-matrix approval — 2026-08-02

**Platform**: Fedora 44 (toolbox) on Bluefin host, Wayland, WebKitGTK 2.52.5, git 2.55
**Capture method**: qa-linux-matrix.sh (debug-only Rust state driver + host PrtScn)
**Captures**: 18 PNGs (Light + Dark × 3 viewports × Changes/collapsed/History)
**Findings**: `findings.md` (6 PASS, 12 PASS-with-notes, 0 FAIL)

## Verdict: approved

All 18 cells pass. Two non-blocking notes recorded for post-MVP follow-up:

1. **Sidebar sections collapsed in expanded cells** — REPOSITORIES/BRANCHES sections show
   collapsed arrows; the sidebar takes width but no content is visible. The driver does not
   explicitly expand them. Recorded in `qa/phase-8b/visual-matrix.md` §Post-MVP follow-ups.
2. **Native title shows "RDC" only** — deferred to tao 0.36 / next tauri stable release.
   Recorded in `MIGRATION_MAP.md` §8.

## Evidence location

```
qa/phase-8b/evidence/linux-fedora44-wayland-2026-08-02/
├── findings.md
├── normal-expanded-light.png
├── normal-expanded-dark.png
├── default-expanded-light.png
├── default-expanded-dark.png
├── compact-expanded-light.png
├── compact-expanded-dark.png
├── normal-collapsed-light.png
├── normal-collapsed-dark.png
├── default-collapsed-light.png
├── default-collapsed-dark.png
├── compact-collapsed-light.png
├── compact-collapsed-dark.png
├── normal-history-light.png
├── normal-history-dark.png
├── default-history-light.png
├── default-history-dark.png
├── compact-history-light.png
└── compact-history-dark.png
```
