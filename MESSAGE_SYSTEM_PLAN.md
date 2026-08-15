# Unified message system — errors, warnings and information

**Status**: complete, 2026-08-15. Every slice landed — the system itself, coalescing, all seven
stores, and the in-dialog-failure decision that Slices 1 and 7 were blocked on. Alongside them: the
toast severity colours, and the repository-availability gate that stops five stores each discovering
a deleted directory in their own words. **`.application-error` is at zero, from 17**, which is this
plan's own definition of done.

Every store failure is now either a toast or a dialog-owned inline failure, and no store carries
error *text* it renders itself. What some still carry is a *signal* — `loadFailed`, `diffFailed` —
because a pane that branches on failure must not claim "No local changes." over a repository it
could not read; and a failure *destined for a dialog* — `managementError`, `discardError`,
`dialogError` — which is the inline channel rather than debt.
**Blocks**: Phase 8b QA cycle 2 — the accessibility and dispatch rows for whatever this produces are
walked in that cycle, so this needs to land before it, not during it. This plan writes those rows;
it does not walk them (see “Where QA happens” in `COMPONENT_MIGRATION_PROCESS.md`).

## The failure this plan exists to remove

One `getStatus` failure, on a repository whose directory had been deleted, produced this on macOS
during Phase 8b cycle 2:

```text
toolbar (top right)   [object Object]
conflict banner       failed to run git for 'getStatus' in /private/tmp/…/populated:
                      No such file or directory (os error 2)
changed-files pane    failed to run git for 'getStatus' in /private/tmp/…/populated:
                      No such file or directory (os error 2)
```

Three simultaneous renderings of one event, in three visual styles, one of them unreadable. It is
the clearest statement of the problem available, and every design decision below should be checked
against it:

1. **Duplication is the primary defect, not styling.** Three stores each refreshed the same dead
   repository and each caught its own rejection. That is three genuine failures with one root cause,
   and the user does not care that three code paths were involved.
2. **Moving these to toasts does not fix it by itself.** The naive migration produces three toasts
   instead of three panels — arguably worse, because they stack and each needs dismissing. Slice 1
   cannot be considered done if this screenshot reproduces with toasts.
3. `[object Object]` is the `String(error)`-on-a-`CommandError` bug described below, confirmed live
   in **15 non-test call sites**.

**Requirement, therefore: coalescing is part of the system, not a later refinement.** See
“Coalescing” under Design.

## What is actually missing

There is no unified message system anywhere in rdc, and none was ever planned. Confirmed by
reading the actual code, not by assuming from the plans:

- ~7 stores each carry their own `error`/`operationError`/`commitError`/`diffError`/`detailsError`
  field, each rendered by an independently copy-pasted `<p className="application-error"
  role="alert">` in a different component (`app-shell.tsx`, `changes-workspace.tsx`,
  `history-workspace.tsx`, `repository-sidebar.tsx`, `repository-toolbar.tsx`,
  `merge-conflicts.tsx`, and five places inside `app-dialogs.tsx`). The *class* is shared; the
  *state and wiring* is not — there is no component or hook behind it.
- There is no warning or info/success channel at all, except one single-purpose panel
  (`merge-conflicts.tsx`'s conflict banner). A completed action — a successful push, a renamed
  branch — currently produces no positive feedback anywhere; success is only ever implicit (a
  progress bar disappearing, a list updating).
- GitHub Desktop's own answer to this (`models/popup.ts`, `models/banner.ts`) was never ported to
  rdc — both sit in the circular-dependency "hub" `MIGRATION_MAP.md` §9 describes, blocked on
  unrelated dialog-prop imports. This is not a design already half-planned elsewhere; it's a true
  greenfield decision.
- **A real, currently-untested bug rides along.** Tauri's `invoke()` rejects with the raw
  deserialized `CommandError` object (`{message, kind, isAuthFailure}`), not a JS `Error`. Most
  stores' catch blocks do `error: String(error)` directly on that rejection — `String()` on a
  plain object yields `"[object Object]"`, not the message. Only `remote-store.ts`/`clone-store.ts`
  avoid this, via `remote-error.ts`'s `describeRemoteError`, which correctly uses `isCommandError`
  (`git-ipc.ts:87`) to pull the real fields out. Every other store's own tests only ever reject
  with `new Error(...)`, so this gap has never been exercised by anything.

Native OS-level notifications (`src-tauri/src/platform/notification.rs`,
`src/lib/notifications/**`) are a separate, already-built, currently-unused subsystem for desktop
notifications. Not part of this plan, not a substitute for it — an in-app toast is not the same
thing as an OS notification, and this plan does not touch that code.

## Design

**Shape.** A toast stack, docked bottom-right, stacking every simultaneous message rather than
capping at one. Three severities, matching the ask exactly — `error`, `warning`, `info` — no
separate "success" tier; a success confirmation is simply an `info` message. Error and warning
messages persist until dismissed (an ✕ button in the toast); `info` auto-dismisses after a few
seconds. Accessibility reuses the app's own existing convention instead of inventing one:
`role="alert"` for error/warning, `role="status"` for info — exactly what today's
`.application-error` blocks and progress text already use.

**The component itself is `UI_FOUNDATION_PLAN.md`'s Phase 1, not a bespoke build.** rdc is
adopting shadcn/Radix as its UI foundation, and the toast is deliberately the pilot for that
adoption — built first, on the new tooling and token migration, rather than hand-rolled now and
retrofit onto shadcn later. Read `UI_FOUNDATION_PLAN.md` before starting this slice: it covers the
tooling setup (`npx shadcn init`), the token migration every shadcn component depends on, and
`sonner` (shadcn's current toast recommendation) as the rendering layer. Everything below this
point — the store, the formatting helper, the severity/dismissal design above — is app-specific
logic that stays exactly as designed regardless of which component renders it.

**Coalescing.** `push` collapses a message that is already present rather than adding a second copy.
Two questions have to be answered explicitly, because the screenshot above is what happens when they
are not:

- **What makes two messages the same?** Start with exact `(severity, text)` equality. It is the
  honest minimum, it fixes the screenshot (the two readable panels carry byte-identical text), and
  it needs no classification the frontend does not already have. Do not invent fuzzy matching.
- **What does the user see when a message repeats?** A repeat count on the existing toast, and its
  dismissal timer reset. Not a new toast, and not silence — silence would hide a second genuine
  failure that happens to read the same.

Exact-text equality does **not** collapse `[object Object]` against the readable copy of the same
failure — they are different strings. That is fine and worth stating plainly: fixing the formatting
bug is what makes them equal, so the two halves of this plan depend on each other. Slice 1 must
verify the screenshot's scenario end to end, not each half in isolation.

**Settled, by the next screenshot: coalescing is not enough on its own.** With the toolbar and
banner migrated, the same deleted directory produced *two* toasts — `failed to run git for
'getBranches'` from the remote store and `failed to run git for 'getStatus'` from the conflict
store. One cause, two sentences, nothing for exact-text matching to merge.

The answer chosen was neither a `MessageKey` nor fuzzier matching, both of which would have deduped
a message the user should never have been shown. Those sentences name a git plumbing call; the
actual condition is "this repository is gone". So the question is now asked **once, upstream of the
loads**, in `repositoryIsAvailable` (`use-app-controller.ts`) via the `getRepositoryType` command
that already existed for adding a repository, and worded once in
`src/lib/repository-availability.ts`. No store discovers the deletion at all, so there is nothing
left to coalesce — and coalescing stays as the safety net for genuinely repeated identical events.

Two properties of that gate are deliberate:

- **It fails open.** If the availability check itself cannot answer, the loads proceed and the
  stores report as they did before. The gate exists to improve *reporting*; refusing to load
  anything because the improvement is unavailable would be a worse failure than the one it prevents.
- **It costs one `git rev-parse`** against the four or five the refresh was going to run anyway.

**Explicitly out of scope**: ongoing operation progress (fetch/push/pull/clone percentages,
"Pushing to origin…" text). That is live state for the duration of an operation, not a point-in-
time event — it stays exactly as it is today, rendered by its own store's `progress` field. This
system is for things that happened, not things that are happening.

**Also out of scope: native operation lifecycle errors.** Since this plan was written,
`OPERATION_PROGRESS_PLAN.md` landed a repository-scoped native operation registry, and
`OperationRecord.error` (`models/operation.ts`) now owns the terminal outcome of Fetch, Push, Pull,
Clone, Commit, Merge, Rebase, Cherry-pick, Revert and Checkout — including cancellation, timeout and
recovery-required states. Those are rendered by `OperationProgressDialog` and must stay there: they
are the terminal state of a *specific, identified* operation the user is watching, they carry
recovery meaning, and a peer window showing the same repository has to see them too.

The boundary is therefore:

| Owner | Covers | Surface |
|---|---|---|
| `OperationRecord.error` | terminal state of a tracked native operation | `OperationProgressDialog` / shared progress body |
| this message system | everything else that failed | toast |

`remote-store.ts` is the worked example: it already gave up `operation`, `progress` and
`operationError` to the native record and kept `error` for *management* failures (Add/Remove/Set-URL
remote). Slice 5 below inherits that split rather than re-litigating it.

**State** — `src/lib/stores/message-store.ts`, following the exact convention every other store
already uses (`preferences-store.ts:136-180`: a plain class, a `listeners: Set<(state) => void>`,
`onDidUpdate` returning an unsubscribe function, no shared base class — there isn't one anywhere
in this codebase, so this doesn't introduce one either):

```ts
export type MessageSeverity = 'error' | 'warning' | 'info'
export type Message = {
  readonly id: string
  readonly severity: MessageSeverity
  readonly text: string
  /** 1 for a first occurrence; incremented when an identical message is pushed again. */
  readonly count: number
}
export type MessageState = { readonly messages: ReadonlyArray<Message> }

export class MessageStore {
  /** Collapses onto an existing message with the same severity and text, incrementing its count. */
  public push(severity: MessageSeverity, text: string): void
  public dismiss(id: string): void
  public onDidUpdate(listener: (state: MessageState) => void): () => void
}
```

`count` is the landed store's one required change. Slice 0 shipped without it because it shipped
without consumers; the screenshot is what the first three consumers produce if it stays absent.
A collapsed `info` message restarts its auto-dismiss timer, so a repeating background event stays
visible while it is still happening.

Instantiated once alongside the other top-level stores, wired into `use-app-controller.ts` with the
same `useState` + `useEffect(() => store.onDidUpdate(setState), [store])` pattern already used for
every other store there (`use-app-controller.ts:318-425`), and rendered by mapping `state.messages`
onto `sonner`'s toast calls (or its `<Toaster>` + imperative `toast()` API — settle the exact
wiring in `UI_FOUNDATION_PLAN.md` Phase 1, since that's where the component itself is decided) from
`app-shell.tsx`.

**Formatting** — `src/lib/remote-error.ts`'s `describeRemoteError` already does the right thing for
remote operations only. Generalize the `CommandError`-aware part into a new
`src/lib/format-error.ts`:

```ts
export function describeError(error: unknown): string {
  // isCommandError(error) -> error.message
  // error instanceof Error -> error.message
  // otherwise -> String(error)
}

export function reportError(error: unknown): void {
  messageStore.push('error', describeError(error))
}
```

Refactor `describeRemoteError` to call `describeError` first, then layer its remote-specific
special cases (non-fast-forward, merge conflicts, local-changes-overwritten, auth failure, the
PAC/proxy fallback sentence) on top — no duplicated `CommandError`-unwrapping logic, and the bug
fix (correct formatting for a raw `CommandError` rejection) applies everywhere at once, not just to
remote errors.

**Target end state.** No store's `State` type carries an `error`/`operationError`/`*Error` field
once its slice lands. Every mutating store method that can fail rejects (throws) rather than
catching internally and setting a field; the `use-app-controller.ts` wrapper function that calls it
is the one place that catches and calls `reportError`. Validation that currently lives inside a
store and sets `operationError` directly (e.g. `branch-store.ts:206,305,312,326`'s name checks)
throws a descriptive `Error` instead, caught by the same wrapper. This is the actual "unified"
outcome, not just relocating where existing state gets rendered — after the last slice, grepping
for `application-error` should return nothing outside this plan's own history.

## SETTLED — where an in-dialog failure appears

**Decided 2026-08-15, on measurement rather than argument.** The three candidates and their costs
were:

| Option | Gains | Costs |
|---|---|---|
| **Inline in the dialog** | The failed action keeps its context and stays retryable without redoing the selection | A second error surface exists; its element has to be real, not a token swap |
| **Toast, dialog closes** | One error channel app-wide | Context is gone — retrying a discard means re-selecting the files |
| **Toast, dialog stays open** | One channel *and* retryable | Feared to be overlapped by the modal; the plan required this be checked, not reasoned about |

### What the check found

Mounting a toast behind an open `AlertDialog` and measuring, rather than reasoning:

| Question | Measured |
|---|---|
| Does the modal overlap the toast? | **No.** Sonner is `z-index: 999999999`; the Radix overlay and content are `z-50`. |
| Is the toast announced? | **Yes.** Radix's `aria-hidden` sweep does not reach the toaster; it keeps its `aria-live="polite"`. |
| Is the toast **dismissible**? | **No.** The modal sets `pointer-events: none` on `<body>`; the toaster is a body child; `pointer-events` is inherited; sonner never re-enables it — its only rule sets `none` on *invisible* toasts. |

So the feared risk does not occur, and a different one does: behind a modal the toast is perfectly
visible and completely inert. Since error toasts persist until dismissed, option 3 produces a toast
the user **cannot get rid of** until they close the dialog. Rescuable only by forcing
`pointer-events: auto` on the toaster, which deliberately punches a hole in the modal.

### The decision

**A failure renders inline in the dialog that owns the action that failed.** It goes to the message
system only when no dialog owns it.

Note the test is **ownership, not timing.** "While a dialog is open" was the original phrasing and it
is wrong, because a dialog that dismisses itself before its action completes makes the case vanish —
see the finding below. Ask *which surface the user acted on*, not *what happened to be on screen*.

Two obligations come with it, and neither is optional:

1. **A dialog that can show a failure may not dismiss optimistically.** It stays open until the
   action settles: closes on success, renders the failure inline on failure.
2. **It must keep an enabled Cancel/Close path once the action is no longer in flight**, so a user
   who cannot or will not retry is never trapped in a dialog that keeps failing. This composes with
   `COMPONENT_MIGRATION_PROCESS.md` Convention 8 rather than contradicting it: refuse dismissal
   *during* the operation, always permit it *after* a failure.

This does not weaken the plan's premise. `OPERATION_PROGRESS_PLAN.md` already established that a
native operation's terminal error belongs to its progress dialog rather than the toast, because it
is the terminal state of something the user is watching. A dialog owning the failure of the action
just confirmed *in it* is the same principle, not an exception to it.

### The finding that forced the ownership wording

**Corrected on implementation: one handler, not three.** `confirmRename` and `confirmDelete` were
already right — they close only when `dialogError === null`, and their Cancel refuses only while
`operation !== null`, which is exactly Convention 17. The grep that found them matched their
close-on-success lines without their guards. The real case is `confirmRemoveRepository`
(`use-app-controller.ts`), which nulls its dialog state **before** awaiting the action:

```ts
setRepositoryToRemove(null);                                   // dialog closes first
await runRepositoryAction(() => appStore.removeRepository(r)); // then it can fail
```

That is option 2 arrived at by accident: the dialog is already gone, so the failure has nowhere to
be inline and lands in the top-level error instead. It was nearly preserved by inertia while
implementing the opposite decision. Fixing it was therefore part of this work rather than a
follow-up — without it the decision could not be honoured at the one site that needed it.

### What was done

All four steps landed together, 2026-08-15.

1. **One element.** `DialogFailure` (`src/lib/ui/dialogs/dialog-failure.tsx`) is how a dialog shows
   the failure of the action it confirmed — the shape `ConfirmDialog` already had, extracted and
   adopted by the preferences and add-remote dialogs. It stays distinct from `DialogMessage`, and
   the distinction is worth keeping: `DialogMessage` is a height-holding slot for whatever a dialog
   has to *say*, reserving its space so buttons never move under the pointer; `DialogFailure` is the
   *outcome of an attempt*, which only appears after the user has committed, so it may take space
   when it arrives.
2. **The optimistic close is gone.** `confirmRemoveRepository` keeps its dialog open until the
   removal settles, closes on success, renders the failure inline, and keeps Cancel enabled whenever
   the removal is not in flight. Guarded by a test that was confirmed to fail when the close is
   moved back before the await.
3. **The ownerless failures went to the message system.** The top-level controller `error` covered
   add-repository, create-repository, select-repository and the context-menu actions — the folder
   picker is a *native* dialog, so nothing of rdc's owned those. `app-shell.tsx`'s block is gone
   with the state behind it.
4. **`.application-error` is at zero**, from 17 when this plan was written. One subtlety: the class
   carried a `forced-colors` override, which would have been silently lost. `DialogFailure` keeps a
   layout-free `dialog-failure` class purely as the hook that rule needs, so high-contrast users
   keep the treatment.

The `--error-*` tokens stay. They are read by `DialogFailure` and, under those exact names, by the
sonner error toast.

## Slices

Each slice is independently gated and shippable, same discipline as `BRANCH_OPERATIONS_PLAN.md`'s
Slices 1–3.

### Slice 0 — The system itself

`UI_FOUNDATION_PLAN.md`'s Phase 0 (tooling + token migration) and Phase 1 (`sonner`), plus this
document's own `message-store.ts` and `format-error.ts`. Fully unit-tested in isolation (push/
dismiss/auto-dismiss-timing/severity-rendering). Zero consumers wired yet — no behavior change to
the running app. This is the slice to get the store API and the toast's visual design right before
repeating the store-migration pattern six more times in Slices 2–7.

### Slice 0.1 — Coalescing, before any consumer exists

An amendment to the landed Slice 0, and a prerequisite for every slice below. Add `count` to
`Message`, collapse on `(severity, text)` in `push`, render the count in the toast, and reset the
`info` auto-dismiss timer on collapse. Unit-tested in isolation, exactly as the rest of Slice 0 was:
identical pushes collapse and increment; different severities with identical text do not collapse;
dismissing a collapsed message removes it once; a collapsed `info` message's timer restarts.

Kept separate from Slice 1 for the reason Slice 0 was kept separate from its consumers — get the
store API right before six slices depend on it.

### Slice 1 — Top-level error, and the three known-broken dialogs

Picked first because it fixes real bugs, not just refactors, and proves the pattern before
repeating it:

- `use-app-controller.ts`'s top-level `error`/`setError` (write paths at lines 434, 467, 484, 541,
  547, 602) → `reportError`. Remove `error` from the controller's returned state and the
  `application-error` block in `app-shell.tsx:291-295`.
- **Rename-branch dialog** (`app-dialogs.tsx:282-328`) — today never reads
  `branchState.operationError`, so a rejected rename just sits there with no visible reason. Route
  the failure through `reportError` and add the missing "Renaming…" loading state
  (`branch-store.ts:335`'s `'renaming'` operation already exists to key off).
- **Delete-branch dialog** (`app-dialogs.tsx:330-391`) — identical gap. Same fix, keyed off the
  `'deleting'` operation (`branch-store.ts:399`).
- **Manage Remotes' remove action** (`app-dialogs.tsx:465-548`) — `confirmRemoveRemote`
  (`use-app-controller.ts:1095`) sets `manageRemoteError` but the outer list dialog never renders
  it (only the nested Add-remote sub-dialog does). Route through `reportError`; add a per-row
  "Removing…" indication so a failure is attributable to the remote that failed.

### Slices 2–7 — one per remaining store

| Slice | Store | Fields removed | Consumers to update |
|---|---|---|---|
| 2 | `working-tree-store.ts` | `error`, `commitError`, `diffError` → **landed**; `error`/`diffError` became `loadFailed`/`diffFailed` booleans and a narrow `discardError` remains, see below | `changes-workspace.tsx` — **landed**: all three `.application-error` blocks gone |
| 3 | `history-store.ts` | `error`, `detailsError`, `diffError` → **landed**; `error`/`diffError` became `loadFailed`/`diffFailed`, `detailsError` went outright | `history-workspace.tsx` — **landed** |
| 4 | `branch-store.ts` | `error` → `loadFailed`; `operationError` → `dialogError`, dialogs only — **landed** | `repository-sidebar.tsx` — **landed**; the rename/delete/merge dialogs keep their inline failure until Slice 1 |
| 5 | `remote-store.ts` | `error` → **landed**, but see below | `repository-toolbar.tsx` — **landed**: the error paragraph is gone entirely. The toolbar keeps action state and peer-window status only |
| 6 | `conflict-store.ts` | `error`, `operationError` → **landed**; `error` became a `loadFailed` boolean, see below | `merge-conflicts.tsx` — **landed**: both `.application-error` blocks gone |
| 7 | `clone-store.ts` + `preferences-store.ts` | **not removed** — both fields render only in dialogs, and the settled decision keeps a dialog-owned failure inline. They are the inline channel, not debt | `app-dialogs.tsx` clone dialog, preferences dialog |

#### Slice 5, as landed — and the one deviation

`load`, `fetch`, `push` and `pull` failures now go to the message store through
`reportErrorMessage(describeRemoteError(error))`, and the toolbar's error paragraph is deleted. That
slot could never have worked: it is `white-space: nowrap` with an ellipsis, which is why the Phase 8b
screenshot shows `failed to run git f…`. An error message does not belong in a strip sized for a
status word.

**The field is not fully gone: `error` became `managementError`, carrying Add/Remove Remote failures
only.** Removing it outright would have silently answered the open decision above — the Manage
Remotes dialog renders that text inline, and routing it to a toast *is* option two. The interim rule
says dialogs keep their failure inline until the decision is made, so the field was narrowed to
exactly that one consumer and renamed so the remaining scope is visible rather than implied. It
disappears with Slice 1, when the decision it belongs to is settled.

`reportErrorMessage` was added alongside `reportError` for this: `describeRemoteError` turns a
`GitErrorKind` into product-reviewed recovery prose that `describeError` cannot produce and the
controller has no business knowing, so classification stays in the store and only the reporting is
shared. The plan's "controller catches and calls `reportError`" shape still holds for the stores
whose methods carry no domain classification.

#### Slice 6, as landed — a signal is not the same as a message

Both `.application-error` blocks are gone from the banner, and all three sources now report to the
message store: the load failure, the staging failure, and the "Resolve all conflict markers before
staging *x*" precondition (kept at `error` severity, matching how it read before).

`error: string | null` did not simply disappear — it became `loadFailed: boolean`. Deleting it
outright would have made the banner *lie*: its visibility condition tested `state.error === null`,
and with no files and no signal a failed read renders "All conflict resolutions are staged." over a
repository it could not read. **Removing an error field is not the same as removing the fact that
something failed.** The message text moves out, where it coalesces; the flag stays, so the banner can
say "Conflict state is unavailable." without repeating the sentence the toast is already showing.
Expect the same distinction in the remaining slices wherever a component branches on an error rather
than merely displaying it.

The cross-store duplication check now exists as far as the migrated stores allow: one root cause
reaching both the conflict and remote stores produces a single message with `count: 2`. It completes
in Slice 2, when the working-tree store joins them and the screenshot's third panel goes.

#### Slice 2, as landed — the screenshot is closed

All three `.application-error` blocks are out of `changes-workspace.tsx`, and the count is down from
17 to 12. Load and diff failures report to the message store; so do the two commit preconditions
("Enter a commit message.", "Include at least one file.") and the commit failure itself.

Two fields survive as booleans for the reason Slice 6 established — the pane *branches* on them, so
deleting them outright would make a failed read claim "No local changes." or invite the user to
"Select a changed file" over a file it could not read. `loadFailed` and `diffFailed` carry the
signal; the message carries the text.

A third field survives with a name that says why: **`discardError`**. Discard failures render inline
in a `ConfirmDialog`, which is the open in-dialog-failure decision again — the same reason
`remote-store` kept `managementError`. Both go with Slice 1.

The cross-store duplication check is now complete: one failure reaching all three of the
screenshot's stores produces a single message with `count: 3`. In the running app the
repository-availability gate stops those loads before they start, so the test pins the behaviour for
every *other* failure the three can share.

**One thing to watch in the QA cycle.** Commit validation is now a toast, per this plan's target end
state. It is bottom-right while the user is looking at the commit box, which may read worse than the
inline text it replaces. It is a small, reversible change and the right place to judge it is with
eyes on the running app — a Phase 8b row, not a guess here.

**Recommended order: 5, 6, 2, then 3, 4, 7.** The numbering above is kept stable because
`REMAINING.md` and other documents reference it, but the *order to implement* should be led by the
screenshot: its three panels come from `remote-store` (5), `conflict-store` (6) and
`working-tree-store` (2). Until all three land, the duplication this plan exists to remove is still
on screen, and Slice 5 alone removes the `[object Object]`. Slices 3, 4 and 7 are the same pattern
applied to surfaces that do not co-fire, so they carry less risk and can follow.

Each slice: remove the field from the store's `State` type, change the store method to throw
instead of catching-and-setting, update the store's own unit tests (which today assert
`store.state.error === '...'` — change to asserting the thrown error / that `reportError` receives
the right value, whichever the test file's existing mocking style makes more natural), delete the
now-dead `.application-error` render site, and confirm nothing else in that component still
references the removed field.

### Slices 3, 4 and 7, as landed — and one correction to the plan

**Slice 3 (history)** is the clean case, and it produced a useful distinction. Three fields, but only
two needed a replacement signal: a failed *details* read already clears `changeset`, so the pane
falls through to an honest "Commit details are unavailable." on its own. `detailsError` was pure
duplication and went outright. The list and diff reads both needed flags, for the usual reason —
without them they claim "No commits yet." and invite you to select an already-selected file.

**Slice 4 (branch)** needed the surface split made explicit. `failOperation` is shared by six
operations, two of which start in the sidebar (create, checkout) and four in a dialog (rename,
delete, merge, rebase). It now takes a `surface` argument, because the destination is a real
distinction and not a formatting detail: the dialog ones must stay inline until Slice 1, the sidebar
ones have no inline home left. One knock-on: the branch form decided whether to close itself by
reading `operationError === null`, which stops meaning anything once failures leave the store, so
`refreshAfterBranchChange` now returns whether the operation succeeded.

**Slice 7 is not independent — it turns on the same decision as Slice 1, now settled.** The plan grouped it
with the low-risk tail, but `clone-store`'s and `preferences-store`'s `error` fields render *only* in
dialogs. Removing them is not "the same pattern on a quieter surface"; it is the in-dialog-failure
decision itself, made by accident. With the decision settled in favour of inline, those two fields
stay and become the inline channel's inputs; what Slice 7 owes is the shared element, not a removal.

What Slice 7 *could* deliver now, and did: the `[object Object]` bug in both of those dialogs, plus
`operation-store`'s terminal-error message. Five `String(error)` sites became `describeError`, which
is independent of where the message ends up rendering. **Every remaining `String(error)` in `src/`
is legitimate** — `format-error`'s own fallback, log formatting, and two `new Error(String(...))`
wrappers.

`.application-error` is down from 17 references to **7**: three CSS rules and four render sites, all
four inside dialogs, all four waiting on the same decision.

## Definition of done, per slice

Same gate set `BRANCH_OPERATIONS_PLAN.md` already established:

- `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm format:check`, `pnpm lint`
- `pnpm check:bundle-boundary`, `pnpm qualify:phase8a`, `pnpm test:e2e`
- `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --check`

Plus, per slice: confirm (by grep, not by memory) that no `.application-error` render site remains
for that slice's stores, and that the store's own test file no longer asserts on a removed `error`/
`operationError` field. There are **17 `.application-error` references today**: 14 in `tsx` across
eight components, plus 3 rules in `App.css`. The number must only go down, and the CSS rules go last
— they are dead the moment the fourteenth render site does.

**The duplication check, once slices 2, 5 and 6 have all landed.** Reproduce the motivating failure
and confirm it now produces exactly one message. It is automatable and should be automated rather
than left to the QA cycle: delete (or rename) a selected repository's directory out from under the
running app, trigger a refresh, and assert that `messageStore.state.messages` has length 1 with the
readable text — not three entries, and no `[object Object]` anywhere. A component-level test with
three stores rejecting the same `CommandError` is the cheap version; the E2E version belongs in the
Linux container with a real deleted fixture.

Also grep for `String(error)` — **15 non-test call sites today**. Each one is a latent
`[object Object]`, and the count must reach zero by Slice 7. `describeError` is the replacement in
every case.

## Read before implementing

`src/lib/ui/tooltip.tsx` for the portal + registry pattern this reuses; `src/lib/remote-error.ts`
for the formatting logic being generalized; `src/lib/stores/preferences-store.ts:136-180` for the
store-class convention to match exactly (no deviation — this is the one place in the codebase where
introducing a shared base class might look tempting and would be inconsistent with every other
store).

## Risks

- **Test churn.** Slices 2–7 touch every store's test file, not just its implementation — the
  bigger cost of "full migration now" versus the incremental alternative that was considered and
  declined. Budget for it; do not skip test updates to make a slice look smaller.
- **Losing the `describeRemoteError` special cases during the `format-error.ts` refactor.**
  Non-fast-forward / merge-conflict / local-changes-overwritten / auth-failure / PAC-proxy copy is
  product-reviewed wording; Slice 0's refactor must be a pure extraction (call the new
  `describeError` first, then apply the existing special-casing unchanged), not a rewrite.
- **A toast is a new kind of transient, auto-dismissing UI surface** — screen-reader and keyboard
  behavior for it has no precedent elsewhere in rdc to copy exactly (the existing `role="alert"`/
  `role="status"` sites are all persistent-until-cleared, not auto-dismissing). Unit tests are not
  sufficient proof for this specific concern, so write the assistive-technology rows into the Phase
  8b accessibility checklist as part of Slice 0.1 — including what a *collapsed* message should
  announce, which is the new question `count` introduces. Per “Where QA happens”, walking those rows
  is the cycle's job, not a gate on this plan; if the announcement design turns out to need an
  answer before Slices 2–7 can be written, raise it as an open decision with a named observation
  rather than waiting for a sign-off.
- **Coalescing can hide a real second failure.** Two genuinely different problems that happen to
  render identical text will collapse into one message with `count: 2`. That is the accepted
  trade-off — the alternative is the screenshot — but it is the reason the count is *shown* rather
  than silently swallowed, and the reason matching stays exact rather than fuzzy.
