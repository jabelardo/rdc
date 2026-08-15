# Dialog Migration — Per-Dialog Visual Validation Checklist

**Policy:** Every migrated dialog gets a human Light/Dark visual check, and it happens **in the Phase 8b cycle** — not as a gate on the sub-slice that built it. The automated gate set catches behavior, not appearance: a wrong shade, misaligned header, or clipped `<pre>` is invisible to every automated gate, which is why these rows exist at all.

What a development slice owes this file is its **rows**, written while the author still remembers what changed. What it does not owe is a signature. See "Where QA happens" in [`COMPONENT_MIGRATION_PROCESS.md`](../../COMPONENT_MIGRATION_PROCESS.md) for why: sign-off attached to individual slices fragments the cycle, pulls a person in to approve surfaces still expected to change, and is invalidated by the next slice touching the same dialog.

Record the result for each dialog, in each theme, at the normal 715×356 floor and compact widths.

How to open each dialog: **Help → Show Dialog** (dev/test builds only). Validate in **Light** and **Dark** via Preferences → Theme. (System mode delegates to the OS and cannot be controlled during a visual pass — infrastructure is in place via `resolveSystemTheme()` → Tauri's `window.theme()`; no spike needed.)

**Current migration status (2026-08-15).** The component-migration queue is complete, and so is the
shadcn/Radix foundation: the hand-rolled `Modal` and `Tooltip` are both gone. Preferences is a Radix
dialog; its Light/Dark sign-off remains. Rebase, Clone, Commit, Merge, Cherry-pick and Revert use the
shared category-1 blocking progress dialog; Fetch, Push and Pull now use the shared modal too.
Checkout shows operation text in its existing control. Interactive squash/reorder remains deferred
with interactive rebase. The functional Linux-container E2E gate passes 42/42; the checkbox rows
below remain human visual-signoff records rather than automated claims.

## Multi-window and operation progress

Validate these behaviors as operation progress moves from the current dialog-only implementation to
the repository-scoped lifecycle in [`OPERATION_PROGRESS_PLAN.md`](../../OPERATION_PROGRESS_PLAN.md):

- [ ] An operation in repository A leaves a window showing repository B usable.
- [ ] Windows showing the same repository mirror the operation state and cannot start conflicting
      work behind the owner window's progress state.
- [ ] The initiating window owns progress controls; peer windows do not show a second competing
      Cancel control.
- [ ] Closing or losing the initiating window leaves native operation ownership and recovery state
      explicit; it does not silently clear a running operation.
- [ ] A stalled operation produces a visible timeout/error event and never remains indefinitely in a
      generic “in progress” state.
- [ ] Cancel is shown only when the native operation contract declares it and its recovery path has
      been tested; otherwise the dialog remains progress-only with honest failure/recovery messaging.

---

## Message system — rows contributed by MESSAGE_SYSTEM_PLAN.md

Every store-owned error field is now either a toast or a dialog-owned inline failure. These are the
judgements the automated gates cannot make.

- [ ] **Commit validation as a toast.** Submitting an empty commit message, or one with no files
      included, now shows "Enter a commit message." / "Include at least one file." bottom-right
      rather than inline under the commit box. **This is the row most likely to come back as a
      defect**, and it is deliberately unresolved: the plan's target end state routes validation
      through the message system, but the toast is far from where the user is looking and from the
      field they must fix. Judge it with eyes on the app; reverting it to inline is small.
- [ ] **A repeated message collapses rather than stacking.** Provoke the same failure twice (e.g.
      refresh a repository whose directory has been deleted) and confirm one toast with a count,
      not two toasts.
- [ ] **Toast severity reads at a glance** in Light and Dark: error and warning carry the
      `--error-*`/`--warning-*` surfaces, info is the neutral popover surface rather than sonner's
      default blue.
- [ ] **A dialog-owned failure stays in its dialog, and the dialog stays escapable.** Make Remove
      repository fail; confirm the dialog stays open, shows the failure inline, and Cancel still
      closes it. Same for Add remote and Preferences.
- [ ] **`DialogFailure` under forced colors** (Windows high-contrast, and macOS Increase contrast):
      the block keeps a visible border and readable text. It carries a layout-free `dialog-failure`
      class purely so the `forced-colors` rule that `.application-error` used to own still applies.
- [ ] **Screen-reader announcement of a toast**, including a collapsed one — a repeat updates the
      existing toast's text, so confirm the count is announced rather than silently changing.

## Preferences — rows contributed by the Component 7 redesign

Preferences is now a category layout: a vertical rail with a fixed-height panel beside it, 600px.

- [ ] **The dialog does not resize when the category changes.** Click through Appearance →
      Integrations → Git → Prompts and watch the frame, not the content. This is the reason the
      content height is fixed rather than content-sized; if it still jumps, the fix did not take.
- [ ] **The rail never scrolls, the panel does.** Only Prompts is long enough to test this today —
      at the compact viewport it should scroll inside its pane with all four categories still
      reachable.
- [ ] **Arrow keys move between categories** (up/down, wrapping), and Tab moves into the panel's
      controls rather than to the next category.
- [ ] **Light and Dark**: the selected category is legible against the rail, and the rail's right
      border reads as a divider rather than an edge.
- [ ] **Long values do not break out.** Pick the longest editor and shell names available and
      confirm the selects truncate inside the panel rather than widening the dialog — the failure
      desktop-plus documents in its own preferences SCSS.
- [ ] **Category names still fit rdc's vocabulary.** Appearance, Integrations, Git and Prompts are
      taken from desktop-plus; judge whether they read right for rdc before more settings arrive and
      the names get expensive to change.

## Manage remotes — rows contributed by the Component 8 redesign

The list is now a fixed-height bordered scroll region with icon-only row actions.

- [ ] **The dialog is the same size with two remotes and with twenty.** Add several remotes and
      confirm the list scrolls inside its border rather than the dialog growing.
- [ ] **A long URL truncates rather than widening the dialog.** Add a remote with a very long URL
      and confirm the name stays fully visible while the URL ellipsises — the name is what
      identifies the row.
- [ ] **The icon actions are discoverable.** The trash icon is visible on every row without
      hovering — deliberately unlike the changed-files list — and its tooltip names the remote.
      Confirm the tooltip appears on keyboard focus, not only on hover.
- [ ] **Light and Dark**: the row dividers and the list border read as one list rather than as
      separate cards, and the icon buttons have enough contrast against the row.
- [ ] **Compact viewport**: the row still fits name, URL and action without the action being pushed
      off or the URL collapsing to nothing.

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

| Dialog (menu label) | Type | Theme | Backdrop | Header | Width / content | Footer | Progress mechanism? | Focus / Escape | Notes | Signed off |
|---|---|---|---|---|---|---|---|---|---|---|
| About | Dialog | Light | | | | Close | — | | Always available | |
| About | Dialog | Dark | | | | Close | — | | | |
| Preferences | Dialog | Light | | | Form fields layout | Close | — | | Always available | |
| Preferences | Dialog | Dark | | | Form fields layout | Close | — | | | |
| Clone | Dialog | Light | | | Cancel / Browse… / Clone | **Cat 1 — progress dialog** | | Always available | Migrated |
| Clone | Dialog | Dark | | | Cancel / Browse… / Clone | **Cat 1 — progress dialog** | | | Migrated | |
| Discard file… | AlertDialog | Light | | | Discard / Permanently discard | — | | Stub state injected by debug menu | |
| Discard file… | AlertDialog | Dark | | | Discard / Permanently discard | — | | | |
| Discard all… | AlertDialog | Light | | | Discard all / Permanently discard all | Busy only (no data) | | Stub state injected by debug menu | |
| Discard all… | AlertDialog | Dark | | | Discard all / Permanently discard all | Busy only (no data) | | | |
| Rename branch… | Dialog | Light | | | Cancel / Rename | — | | Stub state injected by debug menu | Migrated |
| Rename branch… | Dialog | Dark | | | Cancel / Rename | — | | | Migrated | |
| Delete branch… | AlertDialog | Light | | | Close / Delete | — | | Stub state injected by debug menu | |
| Delete branch… | AlertDialog | Dark | | | Close / Delete | — | | | |
| Merge… | Dialog | Light | | | Cancel / Merge | **Cat 1 — shared progress dialog wired** | | Stub state injected by debug menu | Migrated; progress wired |
| Merge… | Dialog | Dark | | | Cancel / Merge | **Cat 1 — shared progress dialog wired** | | | Migrated; progress wired | |
| Rebase… | Dialog | Light | | | Cancel / Rebase | **Cat 1 — shared progress dialog wired** | | Stub state injected by debug menu | Migrated; progress wired |
| Rebase… | Dialog | Dark | | | Cancel / Rebase | **Cat 1 — shared progress dialog wired** | | | Migrated; progress wired | |
| Remove repository… | AlertDialog | Light | | | Cancel / Remove | — | | Stub state injected by debug menu | |
| Remove repository… | AlertDialog | Dark | | | Cancel / Remove | — | | | |

> **Commit is not an action dialog, but it has a category-1 progress dialog.** The Changes pane starts
> the operation; `OperationProgressDialog` owns the undismissable in-flight state and renders the
> bounded terminal stream. An intercepted hook temporarily replaces it with the hook-failure decision
> dialog, then the commit progress dialog returns when the decision resolves.

### Operation progress — lifecycle states

Reached through **Test → Show Dialog → Operation progress…**, which is a chooser rather than a
dialog: pick a state, operation and role, press Show, and the real `OperationProgressDialog` opens
with nothing added to it. Most of these states cannot be produced by hand in a review session — a
hard timeout is two minutes of inactivity, recovery-required needs Git to fail *while* recovering —
which is why they get a preview rather than a reproduction recipe.

Check each against Slice 16's rules: the operation is named, the status line reads as the state
below, and **only** `running` / `takingLongerThanExpected` offer cancellation. Any preview action
closes the preview, since there is no operation behind it.

| State | Light | Dark | Notes |
|---|---|---|---|
| Running | | | Determinate bar, cancel offered |
| Taking longer than expected | | | Still cancellable; the wording must not read as a failure |
| Cancelling… | | | No cancel button; the request is already in flight |
| Recovering repository… | | | Not cancellable at all |
| Completed | | | |
| Completed before cancellation | | | The race: cancellation asked for, operation won |
| Cancelled | | | |
| Timed out | | | |
| Failed | | | Error message is the status line |
| Outcome unknown | | | Failed without knowing what it left behind |
| Stopped waiting (Push) | | | Push's own wording; the remote may have accepted the update |
| Recovery required | | | **Must offer no way out** — the repository is still locked |

Roles to spot-check on any one state: `owner` (controls), `observer` ("Started in another window",
no controls), `unowned` ("Take control and cancel").

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

---

## Merge dialog — the three outcomes

Reviewable **either** way, and both are worth one pass.

- **`Help → Show Dialog → Merge…`** — no repository needed. Mergeability is normally computed by git,
  so the stub branches carry canned previews chosen to reach every state the dialog renders
  differently: clean at 1, 4 and 1284 commits (the singular, plural and thousands wordings),
  conflicts, unrelated histories, and one already-merged branch so the candidate filter has something
  to remove. `inject-test-state.test.ts` asserts that coverage, so the preview cannot quietly stop
  exercising a state.
- **The `mergeStates` fixture repository, via Repository → Merge…** — the same three outcomes
  produced by real ancestry rather than canned answers, which is what confirms the git side agrees
  with the stubs.

Expected in the debug preview: `develop` **and** `origin/develop` are both absent — only the local
ref is named as merged, and the remote one shares its commit, so the SHA half of the filter is what
removes it. One stub branch is deliberately too long for its row, so the truncation and the
tooltip's full name are both exercised.

| Check | Light | Dark |
|---|---|---|
| `already-merged` is **absent** from the list — merging it could only report "already up to date" | | |
| `clean-merge` is offered, and selecting it reports **2 commits** | | |
| `conflicting-merge` is offered, and selecting it warns about **1 conflicted file** | | |
| A conflicting branch still allows the merge — conflicts are an outcome, not a refusal | | |
| Nothing selected: the message slot explains what the space is for, and the buttons do not move when a branch is then chosen | | |
| The selected row is visibly marked | | |
| Hovering a row shows a tooltip with its full name and an absolute last-modified time | | |
| The long stub branch is truncated in the row, and its tooltip shows the whole name | | |
| Up/Down move the selection, including across a group heading; Down from the filter field enters the list | | |
| Switching to Squash restates the preview and relabels the button to "Squash into \<branch\>" | | |
| The strategy caret greys and un-greys together with the action button beside it | | |
| The default strategy honours Preferences → Default merge, re-read each time the dialog opens | | |

> If a branch you expected to be offered is missing, check whether it points at an already-merged
> commit: the filter matches on **SHA as well as ref name**, which is deliberate — it is what lets one
> `git branch --merged` call also account for remote branches, since that command reports local refs
> only.

---

## Rebase dialog — every preview state

Reviewable **either** way, and both are worth one pass.

- **`Help → Show Dialog → Rebase…`** — no repository needed. Rebaseability is normally computed by
  git from the branches' ancestry, so the stub branches carry canned previews chosen to reach every
  state the dialog renders differently: update (both ahead and behind), fast-forward (behind only)
  at 1 and 1284 commits for the singular/plural and thousands wordings, already up to date (not
  behind), unrelated histories, and one branch too long for its row so the tooltip has something to
  reveal. `inject-test-state.test.ts` asserts that coverage, so the preview cannot quietly stop
  exercising a state.
- **A real repository, via the debug menu after selecting it** — the same states produced by real
  ancestry (`getAheadBehind(current…base)`) rather than canned answers. A branch you are already on
  must be absent; a branch behind the current one must read "already up to date" and refuse.

| Check | Light | Dark |
|---|---|---|
| The current branch is **absent** from the list — you cannot rebase onto yourself | | |
| A diverged base reads "This will update *main* by applying its N commits on top of *base*" | | |
| A fast-forward base reads "This will fast-forward main by N commits to match *base*" | | |
| "1 commit" is singular; a 1,284-commit fast-forward shows the thousands separator | | |
| A base the current branch has already passed reads "already up to date" and disables the button | | |
| Unrelated histories are refused with the button disabled | | |
| Nothing selected: the message slot explains what the space is for | | |
| The title states the direction — "Rebase *main*" — and the button is a plain single-action "Rebase" with no strategy caret | | |
| Up/Down move the selection; the tooltip shows the truncated branch's full name | | |
| The button greys while the preview loads, and says "Rebasing…" while running | | |

> A rebase conflict is reported in the dialog rather than closing into rdc's conflict surface, which
> tracks only merge conflicts. That copy is deliberately honest about the boundary; in-app rebase
> conflict recovery (continue/abort) is planned work, not claimed here.
