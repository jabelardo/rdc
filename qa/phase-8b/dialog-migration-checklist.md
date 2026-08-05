# Dialog Migration — Per-Dialog Visual Validation Checklist

**Policy:** Every migrated dialog gets a human Light/Dark visual check *before* its sub-slice closes. The automated gate set (1015 tests, tsc, lint, format, bundle-boundary, build) catches behavior, not appearance. A wrong shade, misaligned header, or clipped `<pre>` is invisible to every automated gate.

Record the result for each dialog, in each theme, at the normal 715×356 floor and compact widths.

---

## Sub-slice 2.0 — Pilot Dialogs (visual sign-off required before 2.1)

| Dialog | Type | Theme | Backdrop | Header alignment | Width / `<pre>` clearance | Footer / actions | Focus / Escape | Nested stack (manage→add) | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|---|
| hook-failure | AlertDialog | Light | | | N/A | Abort / Ignore | | N/A | | |
| hook-failure | AlertDialog | Dark | | | N/A | Abort / Ignore | | N/A | | |
| hook-failure | AlertDialog | System | | | N/A | Abort / Ignore | | N/A | | |
| manage-remotes | Dialog | Light | | | list / URLs fit | Close button | | | | |
| manage-remotes | Dialog | Dark | | | list / URLs fit | Close button | | | | |
| manage-remotes | Dialog | System | | | list / URLs fit | Close button | | | | |
| add-remote | Dialog | Light | | | form fits | Cancel / Add | | | | |
| add-remote | Dialog | Dark | | | form fits | Cancel / Add | | | | |
| add-remote | Dialog | System | | | form fits | Cancel / Add | | | | |
| manage→add nested | — | Light | | | — | — | | | | |
| manage→add nested | — | Dark | | | — | — | | | | |
| manage→add nested | — | System | | | — | — | | | | |

---

## Sub-slice 2.1 — Mechanical Migrations (one row per dialog as it lands)

| Dialog | Type | Theme | Backdrop | Header | Width / content | Footer | Focus / Escape | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|
| discard-file | AlertDialog | Light | | | | | | | |
| discard-file | AlertDialog | Dark | | | | | | | |
| discard-file | AlertDialog | System | | | | | | | |
| discard-all | AlertDialog | Light | | | | | | | |
| discard-all | AlertDialog | Dark | | | | | | | |
| discard-all | AlertDialog | System | | | | | | | |
| rename-branch | Dialog | Light | | | | | | | |
| rename-branch | Dialog | Dark | | | | | | | |
| rename-branch | Dialog | System | | | | | | | |
| delete-branch | AlertDialog | Light | | | | | | | |
| delete-branch | AlertDialog | Dark | | | | | | | |
| delete-branch | AlertDialog | System | | | | | | | |
| merge-picker | Dialog | Light | | | | | | | |
| merge-picker | Dialog | Dark | | | | | | | |
| merge-picker | Dialog | System | | | | | | | |
| remove-repository | AlertDialog | Light | | | | | | | |
| remove-repository | AlertDialog | Dark | | | | | | | |
| remove-repository | AlertDialog | System | | | | | | | |
| about | Dialog | Light | | | | | | | |
| about | Dialog | Dark | | | | | | | |
| about | Dialog | System | | | | | | | |
| preferences | Dialog | Light | | | | | | | |
| preferences | Dialog | Dark | | | | | | | |
| preferences | Dialog | System | | | | | | | |
| clone | Dialog | Light | | | | | | | |
| clone | Dialog | Dark | | | | | | | |
| clone | Dialog | System | | | | | | | |

---

## Verification Checklist — What to Look For (per dialog)

### Backdrop
- [ ] Dimmed but content readable (no overly dark/light backdrop)
- [ ] `forced-colors` override works (Windows High Contrast) — `App.css:1810` targets the correct selector (Radix's `[data-slot="dialog-overlay"]` / `[data-slot="alert-dialog-overlay"]`)

### Header Alignment
- [ ] Left-aligned at all sizes (shadcn's `AlertDialogHeader` centers by default below `sm:` breakpoint; override `place-items-start text-left` must hold)
- [ ] `DialogTitle` / `AlertDialogTitle` text not clipped

### Width & Content Clearance
- [ ] Custom width override (`sm:max-w-md` for manage-remotes, `sm:max-w-sm` for add-remote, `sm:max-w-md` for hook-failure `<pre>`) applied and not clipped
- [ ] `<pre className="commit-terminal-output">` in hook-failure — full lines visible, no horizontal scroll inside the dialog
- [ ] Manage-remotes list: URLs with `break-all` wrap inside the dialog, no horizontal overflow
- [ ] Add-remote form: both inputs fit, no clipping at 715px floor

### Footer / Actions
- [ ] `DialogFooter` / `AlertDialogFooter` reads as a footer (border-t, bg-muted/50), not as body content
- [ ] Destructive buttons (Discard, Delete) keep `destructive-button` styling
- [ ] Explicit Close/Cancel buttons present where expected
- [ ] `showCloseButton={true}` (the X) doesn't create duplicate-close UX alongside explicit buttons

### Focus / Escape
- [ ] First focusable element gets focus on open
- [ ] Tab cycles within the dialog (focus trap)
- [ ] Escape closes dismissible dialogs; **no-op on decision-required** (hook-failure)
- [ ] Closing via X / Close / Cancel / Escape returns focus to the trigger

### Nested Stack (manage-remotes → add-remote)
- [ ] Top dialog (add-remote) traps focus; Escape closes only the top
- [ ] Backdrop-click closes only the top dialog
- [ ] Closing add-remote returns focus to manage-remotes (not to the app)
- [ ] Opening add-remote from manage-remotes doesn't lose the filter/list state

### Forced Colors (Windows High Contrast)
- [ ] Dialog panel uses `Canvas` / `CanvasText` correctly
- [ ] Border visible, focus ring visible

---

## How to Run the Visual Pass

1. **Start the dev build:** `pnpm tauri dev` (or `pnpm dev` + `pnpm tauri dev` in another terminal)
2. **Open a repository** with working tree changes, remotes, and branches to exercise all dialogs
3. **Cycle themes:** System → Light → Dark (Preferences dialog, or OS-level theme switch)
4. **For each dialog in the table above:** open it, verify every checklist item, record PASS/FAIL
5. **For nested case:** open Manage Remotes → click "New remote" → verify add-remote stacks on top; verify Escape/backdrop/Close behavior on both levels
5. **Record result** in the "Signed off" column (initials + date)
6. **If FAIL:** note the issue in "Notes", make the fix, re-verify

---

## Pre-existing Known Issues / Decisions to Revisit

- **Backdrop color:** shadcn uses `bg-black/10` + `backdrop-blur-xs` (10% black + blur); rdc's old `Modal` used `bg-[rgb(0_0_0/42%)]` (42% solid). The blur is a visible change — confirm it's acceptable in both themes.
- **Padding:** shadcn `p-4` vs rdc `p-6`. The tighter padding is intentional (adopting shadcn defaults per user direction); verify no content feels cramped.
- **Border:** shadcn `ring-1 ring-foreground/10` (subtle inner ring) vs rdc `border border-[var(--border)]` (solid outer border). Confirm visual weight is correct in both themes.
- **DialogFooter styling:** shadcn adds `border-t bg-muted/50 p-4 -mx-4 -mb-4`; rdc's `dialogActionsClassName` was `mt-6 flex justify-end gap-3` (no border/bg). The footer bar is a visible change — confirm it's acceptable.
- **AlertDialogHeader centering:** shadcn centers by default below `sm:` (640px). rdc's 715px floor is above it, but the override `place-items-start text-left` must be verified at all widths including compact mode.
- **Dialog vs AlertDialog dismissal:** AlertDialog with no `onOpenChange` blocks Escape/backdrop by spec (hook-failure). Dialog with `onOpenChange` gated by `manageRunning` must allow dismissal when not running, block when running. Verify both.

---

## Gate Rule

**No sub-slice closes until every dialog in that slice has a PASS in all three themes.** The automated gate set is necessary but not sufficient — visual correctness is a human judgement.