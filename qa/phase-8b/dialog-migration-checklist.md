# Dialog Migration — Per-Dialog Visual Validation Checklist

**Policy:** Every migrated dialog gets a human Light/Dark visual check *before* its sub-slice closes. The automated gate set (1015 tests, tsc, lint, format, bundle-boundary, build) catches behavior, not appearance. A wrong shade, misaligned header, or clipped `<pre>` is invisible to every automated gate.

Record the result for each dialog, in each theme, at the normal 715×356 floor and compact widths.

How to open each dialog: **Help → Show Dialog** (dev/test builds only). Validate in **Light** and **Dark** via Preferences → Theme. (System mode delegates to the OS and cannot be controlled during a visual pass — infrastructure is in place via `resolveSystemTheme()` → Tauri's `window.theme()`; no spike needed.)

---

## Sub-slice 2.0 — Pilot Dialogs (visual sign-off required before 2.1)

These three were the first migrated. Validate them in **Help → Show Dialog**. The debug menu injects stub state automatically — no real data needed.

| Dialog (menu label) | Type | Theme | Backdrop | Header alignment | Width / content | Footer / actions | Focus / Escape | Nested stack | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|---|
| Manage remotes… | Dialog | Light | | list / URLs fit | Close button | | | | |
| Manage remotes… | Dialog | Dark | | list / URLs fit | Close button | | | | |
| Hook failure… | AlertDialog | Light | | terminal output fits | Abort / Ignore | No-op on Escape | N/A | | |
| Hook failure… | AlertDialog | Dark | | terminal output fits | Abort / Ignore | No-op on Escape | N/A | | |
| Add remote… | Dialog | Light | | form fits | Cancel / Add | | | | |
| Add remote… | Dialog | Dark | | form fits | Cancel / Add | | | | |
| Manage remotes + Add remote (nested) | — | Light | | — | — | | | Top traps focus; Escape/Close/backdrop closes only top; closing returns focus to bottom | |
| Manage remotes + Add remote (nested) | — | Dark | | — | — | | | | |

---

## Sub-slice 2.1 — Mechanical Migrations (one row per dialog as it lands)

| Dialog (menu label) | Type | Theme | Backdrop | Header | Width / content | Footer | Focus / Escape | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|
| About | Dialog | Light | | | | Close | | Always available | |
| About | Dialog | Dark | | | | Close | | | |
| Preferences | Dialog | Light | | | Form fields layout | Close | | Always available | |
| Preferences | Dialog | Dark | | | Form fields layout | Close | | | |
| Clone | Dialog | Light | | | Cancel / Choose path / Clone | | Always available | |
| Clone | Dialog | Dark | | | Cancel / Choose path / Clone | | | | |
| Discard file… | AlertDialog | Light | | | Discard / Permanently discard | | Stub state injected by debug menu | |
| Discard file… | AlertDialog | Dark | | | Discard / Permanently discard | | | | |
| Discard all… | AlertDialog | Light | | | Discard all / Permanently discard all | | Stub state injected by debug menu | |
| Discard all… | AlertDialog | Dark | | | Discard all / Permanently discard all | | | | |
| Rename branch… | Dialog | Light | | | Cancel / Rename | | Stub state injected by debug menu | |
| Rename branch… | Dialog | Dark | | | Cancel / Rename | | | | |
| Delete branch… | AlertDialog | Light | | | Close / Delete | | Stub state injected by debug menu | |
| Delete branch… | AlertDialog | Dark | | | Close / Delete | | | | |
| Merge… | Dialog | Light | | | Cancel / Merge | | Stub state injected by debug menu | |
| Merge… | Dialog | Dark | | | Cancel / Merge | | | | |
| Remove repository… | AlertDialog | Light | | | Cancel / Remove | | Stub state injected by debug menu | |
| Remove repository… | AlertDialog | Dark | | | Cancel / Remove | | | | |

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

## Debug Stub-State Mechanism (implemented)

The `src/lib/debug/inject-test-state.ts` module populates every store the dialogs read from with minimal stub data (fake repo, branches, remotes, working-tree files, hook failure). Each debug menu event calls `injectDebugState()` before opening the dialog.

The real menu events are completely untouched — clicking "Rename branch" from the context menu uses real data, always. Only the **Help → Show Dialog** submenu triggers stub injection via debug-prefixed events (e.g., `debug-show-rename-branch-dialog` instead of `rename-branch`).

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
- **Toolbar error display** (`<p class="repository-toolbar-status is-error">`) is an inline error pattern that should migrate to the message system (toast notifications) per `MESSAGE_SYSTEM_PLAN.md` Slices 2-7. Not a stage-2 blocker — tracked here so it isn't forgotten during the message-system migration.

---

## Gate Rule

**No sub-slice closes until every dialog in that slice has a PASS in Light and Dark.** The automated gate set is necessary but not sufficient — visual correctness is a human judgement.

---

## Discard all at scale — 99 and 1000 files

**Why two counts.** They are not the same check twice. `VirtualList` virtualizes past **100** rows, so
99 renders every row in the DOM and 1000 renders a window of them. The bug being guarded against is a
list that looks right at 99 and is empty, clipped, or unscrollable at 1000 — or a dialog that grows
past the window at either count.

**Fixtures.** `pnpm fixture:phase8b -- <target>` creates `discardMany99` and `discardMany1000`; take
their `repository` paths from `fixture-manifest.json`. Their file counts are asserted by the
fixture's own test, so a manifest count is trustworthy. Both mix tracked modifications with untracked
files under deliberately long nested paths.

**How to open.** Add the fixture repository, then **Repository → Discard all changes**. Not the debug
Show Dialog menu — that injects three stub files and cannot reach these counts.

> Discard-all is reachable only from the native menu, and the QA driver has no menu-event hook, so
> **none of this is covered by E2E**. That gap is itself a QA cycle 2 item; until it closes this table
> is the only verification these paths get.

| Check | 99 · Light | 99 · Dark | 1000 · Light | 1000 · Dark |
|---|---|---|---|---|
| Question states the exact count ("…to these 99 files:" / "…these 1000 files:") | | | | |
| Every path is listed — the list is present, not replaced by a count | | | | |
| List scrolls, and scrolling reaches the last path | | | | |
| Dialog height stays within the window; footer buttons remain visible and clickable | | | | |
| Dialog width unchanged from a small discard (the list must not widen it) | | | | |
| Long nested paths wrap rather than overflow horizontally | | | | |
| Cancel leaves all files changed (`git status --porcelain` count unchanged) | | | | |
| Confirm: tracked files return to baseline, untracked files are gone from disk | | | | |
| Confirm: the working-tree pane ends up empty and `git status --porcelain` is empty | | | | |

### Record alongside the table

- **Perceived duration of the confirmed discard at 1000 files**, and whether the app looked hung.
  There is deliberately **no progress indicator and no cancel** — the dialog shows "Discarding…" with
  every dismissal refused (Convention 8). This measurement is the input to deciding whether progress
  reporting is needed before MVP, so record the number even if it feels fine.
- **Whether the OS trash actually received ~500 files** at the 1000 case. The removal is one batched
  IPC call now; a trash implementation that silently drops items would still leave the working tree
  looking correct.
- **Any per-path failure message.** A partial failure should report a count ("Failed to remove N
  files, starting with …"), leave the successfully-removed files properly discarded, and re-prompt
  with a count that reflects what actually remains.
