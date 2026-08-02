# Application-menu MVP alignment — Linux live Wayland evidence

**Platform**: Fedora 44 toolbox on Bluefin host, Wayland session
**Commit**: 51f2914 (pre-E2E-fix) + harness fixes on main
**Date**: 2026-08-02
**Build**: `pnpm tauri dev` (debug) with WEBKIT_DISABLE_COMPOSITING_MODE=1
**Fixture**: `/tmp/rdc-phase8b-linux-menu-gate` (schema 2, 12 scenarios)

## States exercised

### State 1 — No repository registered or selected
**Verdict**: PASS ✓

| Menu | Items | Labels | Accelerators | Enablement |
|---|---|---|---|---|
| File | New repo, Open new window, Add local, Clone, Options, Exit | upstream labels ✓ | Ctrl+N/Alt+N/O/Shift+O/, /Q ✓ | Open new window greyed (no repo) ✓ |
| View | Changes, History, Repo list, Branches list, Go to Summary, Reset zoom, Zoom in/out, Expand/Contract, Reload, DevTools | upstream labels ✓ | all correct ✓ | repo-scoped greyed; zoom/expand always enabled ✓ |
| Repository | Push, Pull, Fetch, Remove…, Open in shell, Show in File Manager, Open in editor | upstream labels ✓ | all correct ✓ | all remote ops greyed; Remove/File Manager greyed (no repo) ✓ |
| Branch | New branch… | upstream label ✓ | Ctrl+Shift+N ✓ | greyed (no repo) ✓ |
| Help | Report issue, View RDC on GitHub, Show logs, About | rdc labels ✓ | — | all enabled ✓ |

### State 2 — Clean repository selected, no integrations
**Verdict**: PASS ✓

- Repo appears in sidebar (clean, selected, highlighted blue) ✓
- View menu: Changes, History, Repo list, Branches list, Go to Summary → all **enabled** (were greyed in State 1) ✓
- Repository menu: Remove… **enabled**, Show in File Manager **enabled** ✓
- Branch menu: New branch… **enabled** ✓
- Zoom/Expand/Contract: still enabled ✓
- Dev-only items: still enabled ✓

### State 5 — Push busy state (delayedPush fixture)
**Verdict**: PASS ✓

- **Idle**: Push enabled (unpublished branch publish-me), Pull greyed (no upstream), Fetch enabled ✓
- **Busy** (Push in progress, "Pushing to origin — ..." visible in toolbar):
  - Push: **greyed** ✓ (busy state — correct!)
  - Fetch: **greyed** ✓ (busy state — correct!)
  - Pull: greyed ✓ (no upstream, always disabled)
  - Remove…: **enabled** ✓ (not a remote op, always available)
  - Show in File Manager: **enabled** ✓
- Progress indicator visible in toolbar ✓

### State 6 — Merge conflict state
**Verdict**: PASS ✓

- Branch menu: New branch… **greyed** ✓ (mergeInProgress = true → branchActionsDisabled)
- Workspace shows "Merge in progress" banner with conflict resolution controls ✓
- Sidebar shows branches (main, conflict-side) ✓

## Not captured in this session (recorded for follow-up)

- **State 3/4** (populated Changes/History): menus behave identically to State 2 — same enablement based on repo selection. Populated repo just has modified files; menu items don't change based on file content.
- **State 7** (two windows): needs interactive verification — open new window, check menus are window-scoped.
- **Edit menu**: not captured for States 2–6. Contains native roles (undo/redo/cut/copy/paste) + Select All — always enabled regardless of state. E2E verified (28/28).
- **Keyboard navigation** (arrows, Escape, Alt mnemonics): wired in code, needs interactive verification.
- **Popup placement**: not captured in this session.

## Evidence files

```
/tmp/rdc-qa-evidence-menu/
├── 1-no-repository.png         (state 1 — empty state, all menus)
├── 1-file-menu.png             (state 1 — File menu open)
├── 1-view-menu.png             (state 1 — View menu open)
├── 1-repository-menu.png       (state 1 — Repository menu open)
├── 2-clean-changes.png         (state 2 — clean repo selected)
├── 2-view-menu.png             (state 2 — Repository menu actually)
├── 2-repository-menu.png       (state 2 — View menu actually)
├── 2-branch-menu.png           (state 2 — Branch menu open)
├── 5-push-idle.png             (state 5 — delayedPush, idle)
├── 5-push-busy.png             (state 5 — push in progress, menu not open)
├── 5-push-busy3.png            (state 5 — push in progress, menu OPEN ✓)
└── 6-branch-conflict.png       (state 6 — merge conflict, Branch menu)
```
