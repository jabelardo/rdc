# Unified message system — errors, warnings and information

**Status**: Slice 0 landed (the system itself — store, formatting, and the sonner-backed toast
from `UI_FOUNDATION_PLAN.md` Phase 1). Zero consumers wired yet, as designed. Slices 1–7 not
started.
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

An open question this plan does not pre-answer: whether a repository-scoped root cause — the
directory is gone, the repository is no longer a repository — deserves recognition as *one*
condition rather than N identical messages. Exact-text coalescing already collapses it in the
observed case. If a later scenario produces differently-worded messages from one root cause, that is
the point to add a `MessageKey` for the cause rather than the text; do not build that machinery
speculatively.

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

## OPEN DECISION — where an in-dialog failure appears (blocks Slice 1)

**Status: deferred, deliberately, 2026-08-06. Not yet decided. Do not implement Slice 1's dialog
routing until it is.**

Every slice below is written as though a failure raised *while a modal dialog is open* becomes a
toast via `reportError`. **That is an assumption this plan made, not a decision anyone ratified.**
It was surfaced during the dialog migration (`COMPONENT_MIGRATION_PROCESS.md`, destructive
confirmation family) and consciously deferred to here, where the message system is actually built
and the trade-off can be judged against a working toast rather than in the abstract.

The three candidates, and what each costs:

| Option | Gains | Costs |
|---|---|---|
| **Inline in the dialog, dialog stays open** | The failed action keeps its context and stays retryable without redoing the selection | A second error channel exists forever; `.application-error`'s replacement has to be a real styled element, not just a token swap |
| **Toast, dialog closes** | One error channel app-wide, which is this plan's whole premise | Context is gone — retrying a discard means re-selecting the files |
| **Toast, dialog stays open** | One channel *and* retryable | A toast fired from behind a modal can be overlapped by it, or read as unrelated to the dialog in front of you. Needs verification against the real `sonner` z-index and the Radix overlay, not reasoning |

This is the worked example `COMPONENT_MIGRATION_PROCESS.md` cites for the difference between an open
decision and QA: it needs a person to look at the running app exactly once, it names the observation
that settles it, and it blocks a specific slice's design. It is not a sign-off, and it does not wait
for the Phase 8b cycle.

Note that the third option's risk is **empirically checkable** and should be checked before deciding:
mount a toast while an `AlertDialog` is open and look at it. Radix renders its overlay in a portal
on `document.body`, and `MessageToasts` portals `<Toaster>` to `document.body` too, so which one
wins is a DOM-order and z-index question with a definite answer.

**Interim rule, in force until this is settled:** dialogs being migrated keep their failure text
inline and switch it from `.application-error` to the `--error-*` tokens. No dialog migration may
resolve this by quietly picking an option, and no *new* `.application-error` usages may be added —
there are 17 in `tsx` today and that number must only go down.

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
| 2 | `working-tree-store.ts` | `error`, `commitError`, `diffError` | `changes-workspace.tsx` (3 render sites) |
| 3 | `history-store.ts` | `error`, `detailsError`, `diffError` | `history-workspace.tsx` (3 render sites) |
| 4 | `branch-store.ts` | `error`, `operationError` (including the inline name-validation paths) | `repository-sidebar.tsx`, rename/delete/merge dialogs already touched in Slice 1 keep working, this slice removes the field they were reading around |
| 5 | `remote-store.ts` | `error` → **landed**, but see below | `repository-toolbar.tsx` — **landed**: the error paragraph is gone entirely. The toolbar keeps action state and peer-window status only |
| 6 | `conflict-store.ts` | `error`, `operationError` → **landed**; `error` became a `loadFailed` boolean, see below | `merge-conflicts.tsx` — **landed**: both `.application-error` blocks gone |
| 7 | `clone-store.ts` + `preferences-store.ts` | `error` (×2) | `app-dialogs.tsx` clone dialog, preferences dialog |

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
