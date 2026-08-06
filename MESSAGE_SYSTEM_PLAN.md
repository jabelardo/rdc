# Unified message system — errors, warnings and information

**Status**: Slice 0 landed (the system itself — store, formatting, and the sonner-backed toast
from `UI_FOUNDATION_PLAN.md` Phase 1). Zero consumers wired yet, as designed. Slices 1–7 not
started.
**Blocks**: Phase 8b QA cycle 2 — the accessibility/dispatch checks for whatever this produces
belong in that cycle, so this needs to land before it, not during it.

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

**Explicitly out of scope**: ongoing operation progress (fetch/push/pull/clone percentages,
"Pushing to origin…" text). That is live state for the duration of an operation, not a point-in-
time event — it stays exactly as it is today, rendered by its own store's `progress` field. This
system is for things that happened, not things that are happening.

**State** — `src/lib/stores/message-store.ts`, following the exact convention every other store
already uses (`preferences-store.ts:136-180`: a plain class, a `listeners: Set<(state) => void>`,
`onDidUpdate` returning an unsubscribe function, no shared base class — there isn't one anywhere
in this codebase, so this doesn't introduce one either):

```ts
export type MessageSeverity = 'error' | 'warning' | 'info'
export type Message = { readonly id: string; readonly severity: MessageSeverity; readonly text: string }
export type MessageState = { readonly messages: ReadonlyArray<Message> }

export class MessageStore {
  public push(severity: MessageSeverity, text: string): void
  public dismiss(id: string): void
  public onDidUpdate(listener: (state: MessageState) => void): () => void
}
```

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
| 5 | `remote-store.ts` | `error`, `operationError` | `repository-toolbar.tsx` (merge the error text out of the status paragraph, keep the progress text) |
| 6 | `conflict-store.ts` | `error`, `operationError` | `merge-conflicts.tsx` |
| 7 | `clone-store.ts` + `preferences-store.ts` | `error` (×2) | `app-dialogs.tsx` clone dialog, preferences dialog |

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
`operationError` field.

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
  `role="status"` sites are all persistent-until-cleared, not auto-dismissing). Get this right in
  Slice 0 with real assistive-technology testing before repeating the component six times; do not
  treat the unit tests alone as sufficient proof for this specific concern.
