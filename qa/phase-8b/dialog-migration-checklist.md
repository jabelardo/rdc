# Dialog Migration — Per-Dialog Visual Validation Checklist

**Policy:** Every migrated dialog gets a human Light/Dark visual check *before* its sub-slice closes. The automated gate set (1015 tests, tsc, lint, format, bundle-boundary, build) catches behavior, not appearance. A wrong shade, misaligned header, or clipped `<pre>` is invisible to every automated gate.

Record the result for each dialog, in each theme, at the normal 715×356 floor and compact widths.

How to open each dialog: **Help → Show Dialog** (dev/test builds only). Validate in **Light** and **Dark** via Preferences → Theme. (System mode delegates to the OS and cannot be controlled during a visual pass — infrastructure is in place via `resolveSystemTheme()` → Tauri's `window.theme()`; no spike needed.)

---

## Sub-slice 2.0 — Pilot Dialogs (visual sign-off required before 2.1)

These three were the first migrated. Validate them in **Help → Show Dialog** (or via the real commit flow for Hook failure…).

> **Deferred:** All pilot dialogs need state the debug menu cannot produce yet. See "Deferred Dialogs" below for the stub-state plan.

| Dialog (menu label) | Type | Theme | Backdrop | Header alignment | Width / content | Footer / actions | Focus / Escape | Nested stack | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|---|
| Hook failure… | AlertDialog | Light | | terminal output fits | Abort / Ignore | No-op on Escape | N/A | DEFERRED | |
| Hook failure… | AlertDialog | Dark | | terminal output fits | Abort / Ignore | No-op on Escape | N/A | DEFERRED | |
| Manage remotes… | Dialog | Light | | list / URLs fit | Close button | | | DEFERRED | |
| Manage remotes… | Dialog | Dark | | list / URLs fit | Close button | | | DEFERRED | |
| Add remote… | Dialog | Light | | form fits | Cancel / Add | | | DEFERRED | |
| Add remote… | Dialog | Dark | | form fits | Cancel / Add | | | DEFERRED | |
| Manage remotes + Add remote (nested) | — | Light | | — | — | | | DEFERRED — nested case | |
| Manage remotes + Add remote (nested) | — | Dark | | — | — | | | DEFERRED — nested case | |

---

## Sub-slice 2.1 — Mechanical Migrations (one row per dialog as it lands)

| Dialog (menu label) | Type | Theme | Backdrop | Header | Width / content | Footer | Focus / Escape | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|
| About | Dialog | Light | | | | Close | | TESTABLE — always available | |
| About | Dialog | Dark | | | | Close | | TESTABLE | |
| Preferences | Dialog | Light | | | Form fields layout | Close | | TESTABLE — always available | |
| Preferences | Dialog | Dark | | | Form fields layout | Close | | TESTABLE | |
| Clone | Dialog | Light | | | Cancel / Choose path / Clone | | TESTABLE — always available | |
| Clone | Dialog | Dark | | | Cancel / Choose path / Clone | | TESTABLE | |
| Discard file… | AlertDialog | Light | | | Discard / Permanently discard | | DEFERRED — needs working tree files | |
| Discard file… | AlertDialog | Dark | | | Discard / Permanently discard | | DEFERRED | |
| Discard all… | AlertDialog | Light | | | Discard all / Permanently discard all | | DEFERRED — needs dirty working tree | |
| Discard all… | AlertDialog | Dark | | | Discard all / Permanently discard all | | DEFERRED | |
| Rename branch… | Dialog | Light | | | Cancel / Rename | | DEFERRED — needs current branch | |
| Rename branch… | Dialog | Dark | | | Cancel / Rename | | DEFERRED | |
| Delete branch… | AlertDialog | Light | | | Close / Delete | | DEFERRED — needs branches | |
| Delete branch… | AlertDialog | Dark | | | Close / Delete | | DEFERRED | |
| Merge… | Dialog | Light | | | Cancel / Merge | | DEFERRED — needs multiple branches | |
| Merge… | Dialog | Dark | | | Cancel / Merge | | DEFERRED | |
| Remove repository… | AlertDialog | Light | | | Cancel / Remove | | DEFERRED — needs selected repo | |
| Remove repository… | AlertDialog | Dark | | | Cancel / Remove | | DEFERRED | |

---

## Verification Checklist — What to Look For (per dialog)

### Backdrop
- [ ] Dimmed but content readable (no overly dark/light backdrop)
- [ ] `forced-colors` override works (Windows High Contrast) — `App.css:1810` targets the correct selector (Radix's `[data-slot="dialog-overlay"]` / `[data-slot="alert-dialog-overlay"]`)

### Header Alignment
- [ ] Left-aligned at all sizes (shadcn's `AlertDialogHeader` centers by default below `sm:` breakpoint; override `place-items-start text-left` must hold)
- [ ] `DialogTitle` / `AlertDialogTitle` text not clipped

### Width & Content Clearance
- [ ] Custom width overrides applied and not clipped
- [ ] `<pre className="commit-terminal-output">` in Hook failure — full lines visible, no horizontal scroll inside the dialog
- [ ] Manage remotes list: URLs with `break-all` wrap inside the dialog, no horizontal overflow
- [ ] Add remote form: both inputs fit, no clipping at 715px floor

### Footer / Actions
- [ ] `DialogFooter` / `AlertDialogFooter` reads as a footer (border-t, bg-muted/50), not as body content
- [ ] Destructive buttons (Discard, Delete) keep `destructive-button` styling
- [ ] Explicit Close/Cancel buttons present where expected
- [ ] `showCloseButton={true}` (the X) doesn't create duplicate-close UX alongside explicit buttons

### Focus / Escape
- [ ] First focusable element gets focus on open
- [ ] Tab cycles within the dialog (focus trap)
- [ ] Escape closes dismissible dialogs; **no-op on decision-required** (Hook failure…)
- [ ] Closing via X / Close / Cancel / Escape returns focus to the trigger

### Nested Stack (Manage remotes → Add remote…)
- [ ] Top dialog (Add remote…) traps focus; Escape closes only the top
- [ ] Backdrop-click closes only the top dialog
- [ ] Closing Add remote… returns focus to Manage remotes… (not to the app)
- [ ] Opening Add remote… from Manage remotes… doesn't lose the filter/list state

### Forced Colors (Windows High Contrast)
- [ ] Dialog panel uses `Canvas` / `CanvasText` correctly
- [ ] Border visible, focus ring visible

---

## Deferred Dialogs — What's Needed

Most dialogs require app state (a selected repository, working tree files, branches, remotes) that doesn't exist when the app launches empty. The debug menu handlers open the dialog, but with no state the dialog has nothing to show or the handler returns early (e.g. `if (firstFile === undefined) return`). These need a **debug stub-state injection** mechanism.

| Dialog | Required state | Stub mechanism | Difficulty |
|---|---|---|---|
| Hook failure… | `workingTreeStore.hookFailure` | Debug menu handler calls `workingTreeStore.debugSetHookFailure({ hook: "pre-commit", terminalOutput: "lint failed\n" })` | Medium — requires new debug-only method on `WorkingTreeStore` |
| Manage remotes… | `appStore.selectedRepository` + `remoteState.remotes` | Debug menu handler selects a repo and calls `remoteStore.debugSetRemotes([{ name: "origin", url: "https://github.com/user/repo.git" }])` | Medium — needs debug method on `RemoteStore` |
| Add remote… | `appStore.selectedRepository` | Debug menu handler selects a repo, then sets `showAddRemote = true` | Easy — repo selection is already handled by the existing stub |
| Discard file… | `workingTreeStore.workingDirectory.files` with ≥1 file | Debug menu handler stubs a `WorkingDirectoryFileChange` into the store, then sets `discardFileID` | Medium — `WorkingDirectoryFileChange` has a specific shape (`id`, `path`, `status`, etc.) |
| Discard all… | `workingTreeStore.workingDirectory.files` with ≥1 file | Same as discard-file stub, plus triggers `requestDiscardAll` | Medium |
| Rename branch… | `branchState.currentBranch` (non-null) | Debug menu handler sets `branchToRename` to a stub branch `{ name: "main", type: BranchType.Local }` | Easy — `Branch` is a simple type |
| Delete branch… | `branchState.branches` with ≥2 local branches | Debug menu handler sets `branchToDelete` to a stub branch | Easy |
| Merge… | `branchState.branches` with ≥2 local branches + `currentBranch` | Debug menu handler sets `mergePickerOpen = true` | Easy |
| Remove repository… | `appStore.selectedRepository` | Debug menu handler calls `setRepositoryToRemove(selectedRepository)` | Easy — already partially wired |

**Proposed approach:** Add a `debug-only` submodule (`src/lib/debug/`) behind `__DEV__` that:
1. Exports a `injectDebugState(stores)` function callable from the debug menu
2. Sets up minimal stub state on every store the dialogs read from (a fake repo, a fake branch, fake working-tree files, a fake remote, a fake hook failure)
3. Is tree-shaken from production builds (only imported in `use-app-controller.ts` behind `__DEV__`)
4. Is called by each `debug-show-*` menu handler *before* opening the dialog, so the dialog has content to show

This is a small, self-contained spike — one file, one new menu event (`debug-inject-test-state`), called once from each handler. It unblocks visual validation of every dialog without real data.

---

## How to Run the Visual Pass

1. **Start the dev build:** `pnpm tauri dev`
2. **Open any repository** (needed for the app to initialize, but the stub-state mechanism overrides store data)
3. **Cycle themes:** Light → Dark (via Preferences dialog)
4. **For each dialog in the table above:** open it from Help → Show Dialog, verify every checklist item, record PASS/FAIL
5. **For nested case:** open Manage remotes… → click "New remote" → verify Add remote… stacks on top; verify Escape/backdrop/Close behavior on both levels
6. **Record result** in the "Signed off" column (initials + date)
7. **If FAIL:** note the issue in "Notes", make the fix, re-verify

---

## Pre-existing Known Issues / Decisions to Revisit

- **Backdrop color:** shadcn uses `bg-black/10` + `backdrop-blur-xs` (10% black + blur); rdc's old `Modal` used `bg-[rgb(0_0_0/42%)]` (42% solid). The blur is a visible change — confirm it's acceptable in both themes.
- **Padding:** shadcn `p-4` vs rdc `p-6`. The tighter padding is intentional (adopting shadcn defaults per user direction); verify no content feels cramped.
- **Border:** shadcn `ring-1 ring-foreground/10` (subtle inner ring) vs rdc `border border-[var(--border)]` (solid outer border). Confirm visual weight is correct in both themes.
- **DialogFooter styling:** shadcn adds `border-t bg-muted/50 p-4 -mx-4 -mb-4`; rdc's `dialogActionsClassName` was `mt-6 flex justify-end gap-3` (no border/bg). The footer bar is a visible change — confirm it's acceptable.
- **AlertDialogHeader centering:** shadcn centers by default below `sm:` (640px). rdc's 715px floor is above it, but the override `place-items-start text-left` must be verified at all widths including compact mode.
- **Dialog vs AlertDialog dismissal:** AlertDialog with no `onOpenChange` blocks Escape/backdrop by spec (Hook failure…). Dialog with `onOpenChange` gated by `manageRunning` must allow dismissal when not running, block when running. Verify both.
- **System mode** delegates to the OS (`preferences-store.ts` → `resolveSystemTheme()` → Tauri's `window.theme()`) — infrastructure is in place, no spike needed. It cannot be exercised during a visual pass since you can't toggle the OS preference from within the app; validation covers Light and Dark only.

---

## Gate Rule

**No sub-slice closes until every TESTABLE dialog in that slice has a PASS in Light and Dark.** DEFERRED dialogs must have their stub-state mechanism implemented and their visual pass completed before sub-slice 2.0 or 2.1 is marked done. The automated gate set is necessary but not sufficient — visual correctness is a human judgement.
