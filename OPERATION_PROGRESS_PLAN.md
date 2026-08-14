# Repository-scoped Git operations, cancellation, timeouts and progress UI

**Status:** Slices 1–14 complete; Slice 15 next
**Recorded:** 2026-08-14  
**Primary milestone:** define truthful cancellation and timeout policies for the remaining
progress-producing operations before completing the unified progress presentation.

This document is the implementation plan for consolidating Git-operation progress while preserving
rdc's multi-window behavior. It is written as instructions for an implementation agent. Follow the
slices in order: later UI work depends on native cancellation and recovery being truthful.

The central rule is:

> The native process owns operation lifetime, the repository owns the lock, and each window owns
> only its presentation. An application-global registry must never become an application-global
> lock.

## Read before changing code

Read these sources before starting a slice:

- `AGENTS.md` — repository rules and the seven required pre-commit gates.
- `MIGRATION_PLAN.md` — current phase status and architectural constraints.
- `MIGRATION_MAP.md` — deliberate departures and deferred work.
- `COMPONENT_MIGRATION_PROCESS.md` § “Progress presentation” — current category-1/category-2
  decision. This plan deliberately amends its “no abort inside” rule once cancellation is real.
- `BRANCH_OPERATIONS_PLAN.md` — merge/rebase recovery boundaries.
- `HISTORY_OPERATIONS_PLAN.md` — cherry-pick/revert/reset scope.
- `src-tauri/crates/git-ops/src/exec.rs` — current process execution and `kill_on_drop` behavior.
- `src-tauri/src/platform/window.rs` — current per-window repository routing metadata.

Port fidelity remains the default. Desktop-plus has no general Git cancellation or Git-operation
timeout mechanism, so the cancellation and watchdog behavior in this plan is an intentional rdc
departure. Record it in `MIGRATION_MAP.md` §8 when the first production slice lands.

## Fixed decisions and safety invariants

These are settled. Do not silently reinterpret them during implementation.

1. **Operation lifetime is native-owned.** Closing, hiding, reloading or destroying the initiating
   window does not implicitly cancel Git.
2. **Locks are repository-scoped.** Operations in different local repositories must run
   concurrently and must not disable one another's UI.
3. **Presentation is window-local.** A progress dialog blocks only the window rendering it. It never
   creates an application-modal surface.
4. **Same-repository windows coordinate.** They observe one operation and block incompatible writes.
   They do not start competing mutations against the same repository.
5. **A frontend timeout never clears an operation.** The backend must terminate the process tree,
   inspect the repository and finish recovery before publishing a terminal timeout event.
6. **A Cancel button is capability-driven.** The UI receives cancellation capability from the
   operation record. It must not infer safety from an operation-name string.
7. **Cancellation is not always cancellation.** Push may finish remotely before the local process
   stops; its terminal outcome may be `unknown`. A cancellation race may also report `completed`.
8. **Recovery failure retains the repository write lock.** Do not return the UI to an apparently idle
   state while Git may remain mid-operation.
9. **Process-tree termination is required.** Killing only the direct `git` child can leave SSH, Git
   LFS, credential helpers, hooks or editors running.
10. **Background work stays non-modal.** User-initiated operations use the unified progress dialog.
    Scheduled/background fetch uses the same operation model and progress body in an embedded
    presentation.

## Target ownership model

```text
Application
└── Native OperationRegistry
    ├── Repository A (stable Git identity)
    │   └── Rebase — owner window repository-1
    ├── Repository B (different stable Git identity)
    │   └── Fetch — owner window repository-2
    └── Clone destination /work/new-repository
        └── Clone — owner window repository-3
```

The registry is application-owned so operations survive window loss. Every active write lock is
indexed by a repository or clone-destination scope, never by a singleton “application busy” flag.

## Target contracts

Exact names may change to fit Rust conventions, but preserve this information and state model.

```ts
type OperationState =
  | "running"
  | "takingLongerThanExpected"
  | "cancelling"
  | "recovering"
  | "completed"
  | "cancelled"
  | "timedOut"
  | "failed";

type OperationOutcome = "unchanged" | "recovered" | "completed" | "unknown";

type CancellationCapability =
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly label: string }
  | { readonly kind: "requested" };

type OperationRecord = {
  readonly id: string;
  readonly scope: OperationScope;
  readonly ownerWindow: string | null;
  readonly operation: GitOperationKind;
  readonly state: OperationState;
  readonly cancellation: CancellationCapability;
  readonly progress: IProgress | null;
  readonly lastActivityAt: number;
  readonly outcome: OperationOutcome | null;
  readonly error: OperationError | null;
};
```

The event stream must distinguish progress, lifecycle changes and terminal errors:

```ts
type OperationEvent =
  | { readonly kind: "progress"; readonly operationId: string; readonly progress: IProgress }
  | {
      readonly kind: "state";
      readonly operationId: string;
      readonly state: "takingLongerThanExpected" | "cancelling" | "recovering";
    }
  | {
      readonly kind: "finished";
      readonly operationId: string;
      readonly state: "completed" | "cancelled" | "timedOut" | "failed";
      readonly outcome: OperationOutcome;
      readonly error: OperationError | null;
    };
```

Do not overload `GitErrorKind` with timeout/cancellation categories: those are operation-lifecycle
failures, not Git's interpretation of stderr. Extend the command error contract or add an operation
error contract while preserving the existing Git classification.

## Locking model

Start conservatively with one exclusive write operation per Git common directory.

- Resolve repository roots, subdirectories and alternate spellings to a stable native identity.
- Use Git's common directory as the initial write-lock key so shared refs/history cannot be mutated
  concurrently through linked worktrees.
- Keep the worktree directory and worktree-specific Git directory in the scope for future refinement.
- Use a normalized destination-path scope for clone because no repository exists yet.
- Do not lock repositories together because they share a remote URL.
- Read-only commands remain allowed unless their result would be misleading during a history move.

Refine common-directory locking only after tests prove a safe benefit. Correct conservative locking
inside one repository is preferable to speculative concurrency; application-wide locking is never
acceptable.

## Required user-visible behavior

| Situation | Required behavior |
|---|---|
| Window A rebases Repository A; Window B shows Repository B | Window B remains fully usable |
| Window A fetches Repository A; Window B commits Repository B | Both operations may run concurrently |
| Two windows show Repository A | One operation is shared; incompatible writes are disabled in both |
| Initiating window closes | The native operation and watchdog continue |
| A new window opens Repository A mid-operation | It hydrates the latest operation snapshot |
| A peer window shows the same repository | It identifies “Started in another window” and mirrors progress |
| Timeout recovery succeeds | Matching windows receive a terminal timeout error and refresh |
| Timeout recovery fails | Matching windows remain write-locked and receive recovery guidance |
| No matching window remains | Native operation continues and terminal state remains queryable |

## Slice 1 — Record the amended architecture

**Goal:** update the source-of-truth documents before code gives the decision inertia.

1. Amend `COMPONENT_MIGRATION_PROCESS.md`:
   - category-1 progress may expose a cancellation action only when the operation record declares it;
   - user-initiated progress uses the unified dialog;
   - background fetch remains embedded;
   - modal scope is a single native window, not the app.
2. Add the deliberate departure to `MIGRATION_MAP.md` §8.
3. Link this plan from the active Phase 8b section of `MIGRATION_PLAN.md`.
4. Add a multi-window/cancellation section to the Phase 8b QA checklist.

**Exit:** the docs no longer state an unconditional “no abort inside” rule and explicitly prohibit
application-wide locking.

**Status:** complete. The migration process, deliberate-deviation map, Phase 8b status and QA
checklist now describe capability-driven cancellation, repository-scoped locking and window-local
presentation.

## Slice 2 — Define and pin the wire contracts

**Goal:** establish typed operation lifecycle data before implementing transport.

Likely files:

- `src/models/operation.ts` or a focused equivalent;
- `src-tauri/crates/git-ops/src/` only for transport-neutral types that truly belong there;
- `src-tauri/src/commands/` for Tauri-facing serialization;
- `src/lib/__generated__/wire-snapshot.json` and wire tests.

Tasks:

1. Define operation ID, kind, state, outcome, cancellation capability, scope and error.
2. Decide whether operation records are emitted from a command module or a dedicated native module.
3. Add serializer fixtures and TypeScript-checked fixtures.
4. Regenerate the wire snapshot; never edit it by hand.
5. Test unknown/optional fields according to the repository's existing wire compatibility policy.

**Exit:** Rust serialization and TypeScript fixtures agree, and no UI uses ad-hoc string states.

**Status:** complete. `src/models/operation.ts` defines the lifecycle vocabulary and
`src-tauri/src/operation.rs` pins the serialized record shape. The generated wire snapshot and
typed `git-ipc` fixture cover a repository-scoped Fetch record, including optional progress fields,
capability-driven cancellation and lifecycle outcome. Operation events use the same vocabulary and
are ready for the registry transport.

## Slice 3 — Resolve stable repository identity

**Goal:** ensure two paths to one repository share a lock and two repositories never do.

Implement a platform-neutral native resolver returning at least:

- top-level worktree path;
- worktree-specific Git directory;
- common Git directory;
- stable lock key.

Tests must cover:

- repository root versus subdirectory;
- lexical normalization (`.` and `..`);
- symlinked paths where supported;
- case behavior on the target platform;
- linked worktrees;
- separate clones of one remote producing distinct keys;
- missing clone destination normalization.

Do not use frontend path normalization as the source of truth. Do not let macOS `/var` versus
`/private/var` behavior regress; `rev_parse.rs` already documents why indiscriminate canonicalization
is wrong for displayed repository paths. A lock key may be canonicalized internally without changing
the user-facing path.

**Exit:** identity tests prove same-repository convergence and different-repository isolation.

**Status:** complete. `git_ops::operation_identity` now resolves the top-level worktree, worktree
Git directory, common Git directory and canonical internal lock key. It keeps displayed paths
lexical, canonicalizes only lock keys, handles linked worktrees through `commondir`, and provides
lexical lock keys for missing clone destinations. Tests cover subdirectories, linked worktrees,
symlinked paths, separate repositories and missing destinations.

## Slice 4 — Build the native `OperationRegistry`

**Goal:** own operation lifetime and repository locks independently of webviews.

Likely location: a new native state module managed from `src-tauri/src/lib.rs`, following the
existing `WindowRoutingState`/`HookRegistry` patterns.

The registry must support:

- reserve/start operation;
- reject a conflicting write with a structured error naming the existing operation;
- publish activity, progress and lifecycle state;
- request cancellation;
- enter recovery;
- finish with state/outcome/error;
- query active operation by repository scope;
- list/query operations for a newly opened window;
- retain the latest event and terminal result for bounded replay;
- transfer or clear owner-window metadata without cancelling the operation.

Never hold a synchronous mutex guard across `.await`. Registry state updates must be short and
separate from process/recovery futures.

Tests:

- same key rejects a second write;
- different keys accept concurrent writes;
- clone destinations lock independently;
- destroying the owner does not finish the operation;
- terminal state releases the lock only after successful recovery or a known-safe finish;
- failed recovery retains a blocked/recovery-required record.

**Exit:** repository-level concurrency is proven without running Git cancellation yet.

**Status:** complete. `OperationRegistry` is application-owned native state with repository and
clone-destination reservations, structured conflicts, progress/lifecycle updates, cancellation
requests, recovery state, bounded latest-event replay, owner-window clearing, and terminal records.
Successful finishes release their lock; recovery failures retain it. Registry tests prove same-scope
exclusion, different-scope concurrency, independent clone destinations, owner loss, and recovery
lock retention. Git process cancellation is deliberately not part of this slice.

## Slice 5 — Add cancellable process-tree execution

**Goal:** let the registry stop the native work rather than merely hiding its UI.

Refactor `src-tauri/crates/git-ops/src/exec.rs` around a transport-neutral execution control type.
Preserve existing `git`, `git_with_stderr`, `git_with_stdout` and LFS behavior through wrappers so the
change can migrate callers incrementally.

Required behavior:

1. Register the child against an operation cancellation token.
2. Start Git in a process group on Unix.
3. Add a Windows Job Object seam with the same platform-neutral API; do not leave an uncompiled arm.
4. On cancellation, signal the group, allow a bounded graceful period, then force termination.
5. Continue draining stdout/stderr and wait for the child after signalling it.
6. Emit activity for every stdout/stderr chunk, not only successfully parsed progress.
7. Keep Git LFS tailing termination-safe.
8. Distinguish user cancellation, timeout termination, signal death and ordinary Git failure.

Do not expose this as a public UI capability yet.

Tests need a helper process that spawns a child so they prove descendant termination, not only direct
Git termination. Cover stdout/stderr pipe pressure so cancellation cannot deadlock while draining.

**Exit:** a native test cancels an operation ID and proves the process tree and pipes terminate.

**Status:** complete. `git_streaming_controlled` and `ExecutionControl` provide a transport-neutral
cancellation seam; Unix starts Git in a dedicated process group and Windows assigns Git to a Job
Object. Both paths terminate descendants with bounded escalation while stdout/stderr remain drained.
Controlled LFS tailing, an operation-ID cancellation test, and large stdout/stderr pipe-pressure
coverage pass. The Windows arm is cross-target compiled for `x86_64-pc-windows-msvc`; runtime
Windows coverage remains part of the platform QA cycle.

## Slice 6 — Add native activity watchdogs

**Goal:** prevent an operation from remaining perpetually “running” without lying about legitimate
long work.

Activity resets include:

- stdout/stderr bytes;
- Git/LFS progress;
- hook started/finished/failed events;
- credential prompt opened/resolved events;
- explicit recovery progress.

Implement two policy thresholds:

1. **Soft inactivity:** emit `takingLongerThanExpected`; do not kill anything.
2. **Hard inactivity:** invoke the operation's termination/recovery policy and ultimately emit a typed
   timeout terminal event.

Thresholds must be operation policy, not one global duration. Start conservatively and document the
chosen values with tests using paused time. A credential or hook decision that is visibly waiting on
the user must not be mistaken for an unobserved deadlock; either suspend the hard watchdog or apply a
separate explicit user-wait policy.

**Exit:** paused-time tests cover activity reset, soft warning, hard timeout, cancellation races and
watchdog cleanup after completion.

**Progress:** complete. `WatchdogPolicy` and the native watchdog now reset their decision from
the operation record's activity timestamp, emit `takingLongerThanExpected`, and request timeout
termination without releasing the repository lock. `record_activity` provides the native heartbeat
for output chunks, hook transitions and credential events, and controlled Git/LFS execution now
touches its native control on every output/progress read. Explicit credential and hook waits suspend
timeout decisions until the user responds. Focused tests cover activity reset, paused-time soft
warning, hard timeout request, lock retention, wait suspension and watchdog cleanup after completion.
Hook support now exposes a backward-compatible wait-hook adapter that brackets the Abort/Ignore
decision with `HookDecision` begin/end events. The trampoline handlers also expose optional prompt
wait hooks around SSH/askpass and credential-provider awaits. The current app configuration
deliberately declines credentials, so no credential UI prompt is active yet; operation-specific
callback wiring remains pending when the credential provider/prompt surface lands.
Focused handler tests now verify that both askpass responses and credential lookups bracket their
awaits with the prompt wait hooks. The remaining Slice 6 work is wiring these hooks to a real
operation-owned credential/prompt surface when that surface is introduced.

That wiring is intentionally deferred with the credential UI and operation routing; the current
`Decline` provider opens no user prompt and therefore has no operation to associate with a wait.
Slice 6 is complete against the current architecture and its exit criteria.

## Slice 7 — Route and replay events across windows

**Goal:** make operation state observable independently of the initiating `invoke()` Channel.

**Progress:** complete. Native query commands now hydrate a window from the active operation for
its selected repository and replay the registry's latest retained event by operation ID. Repository
queries resolve the same stable identity used by locks, including subdirectories and linked
worktrees. Window event subscription, matching filters, owner-loss routing, and explicit observer
cancellation authority remain.
The registry now also broadcasts an envelope containing the event, operation snapshot, scope, and
owner window; a two-repository test proves observers can filter without an application-global busy
state.
The application now forwards that broadcast as the `operation-event` Tauri event to every window,
and the frontend has typed query, replay, and subscription helpers. Destroyed windows clear their
owner assignment without cancelling the native operation.
The frontend now exposes a pure scope filter keyed by the native `lockKey`, with tests proving a
window accepts its repository's events and ignores a different repository's events.
An `OperationEventRouter` now switches that filter with repository selection and drops events while
no repository is selected; tests cover selection changes and cleanup.
The app controller now resolves the native scope and active snapshot on selection, subscribes to the
shared event stream, routes matching records, and cleans up on deselection or unmount. Idle
repositories are safe because scope resolution is independent of active operations.
Owner, observer, and unowned presentation roles are now explicit. Native cancellation accepts the
owner directly and requires an explicit observer confirmation for a peer window; destroying the
owner only clears ownership and never cancels the operation.
Native unit tests now enforce owner cancellation, rejected unconfirmed observer cancellation,
confirmed observer adoption, and cancellation after owner loss.
The Slice 7 exit behavior is covered by native two-window/two-repository registry tests and the
frontend scope-router/controller tests. The full GUI multi-window matrix remains tracked in Slice
19, where it can exercise real window lifetimes and product operations together.

Do not rely solely on a Tauri Channel captured by the initiating command; it disappears with that
webview. The native registry must retain the latest snapshot and broadcast lifecycle events.

Tasks:

1. Capture the initiating `WebviewWindow` label at command entry.
2. Emit operation events with repository scope and operation ID.
3. Add a query command for current operation by selected repository.
4. Hydrate a newly opened or newly switched window from the registry snapshot.
5. Route only matching repository events into each renderer's operation state.
6. Handle owner-window destruction without cancelling the operation.
7. Define cancellation authority after owner loss. Preferred initial rule: a matching observer may
   adopt cancellation authority through an explicit confirmation.

Tests must use at least two distinct window labels and two repository keys.

**Exit:** a second window can join an existing operation, while a different-repository window sees no
busy state.

## Slice 8 — Add the frontend `OperationStore`

**Goal:** centralize lifecycle presentation without moving domain refresh logic out of domain stores.

Create one operation store per webview. It owns:

- selected-repository subscription;
- active operation snapshot;
- latest progress;
- owner versus observer status;
- timeout warning;
- cancellation request state;
- recovery state;
- terminal outcome/error.

`CloneStore`, `BranchStore`, `RemoteStore` and `WorkingTreeStore` continue to own validation and
post-operation data refresh. Migrate their duplicated progress/lifecycle state only after the shared
store can represent it; do not rewrite every store in this slice.

Reject stale events by operation ID. Query the registry whenever repository selection changes.

**Exit:** unit tests prove hydration, event filtering, stale-event rejection, owner loss and
different-repository isolation.

**Progress:** complete. `OperationStore` now hydrates the selected repository, subscribes through
the native-scope router, rejects stale operation IDs, tracks progress/timeout/recovery/terminal
state, exposes owner/observer/unowned presentation, and cleans up subscriptions on deselection or
dispose. Focused tests cover hydration, stale-event rejection, scope filtering, and cleanup. The
existing domain stores still own their operation-specific refresh behavior and have not been
migrated yet.
The focused store suite now also covers owner loss transitioning to `unowned` and isolation from a
different repository's live event stream.
It also covers native cancellation requests, soft-timeout warning state, recovery state, and
terminal error/outcome propagation.
The app controller now consumes this store directly, resolves the current window label for role
presentation, and owns the store lifecycle per webview instead of maintaining a parallel operation
router state.
The Slice 8 exit criteria are complete: hydration, event filtering, stale-event rejection, owner
loss, different-repository isolation, cancellation state, timeout warning, recovery, terminal
outcome/error propagation, and subscription cleanup are covered by focused tests.

## Slice 9 — Enforce repository-scoped operation locks

**Goal:** prevent same-repository corruption without affecting other repositories.

**Status:** complete. The commit command now acquires a stable repository-scoped operation lock
before running Git, records its initiating window, rejects same-repository conflicts, permits
different repositories to proceed, and releases the lock on both success and failure. The local
branch checkout command now uses the same lock lifecycle and records its initiating window;
remote-branch, detached commit, and path checkout commands now use it as well. User/background Fetch
now acquires the same repository lock and releases it after credential setup and Git success/failure;
Push, Pull, and remaining remote/history boundaries remain.
Push now acquires and releases the repository lock across session setup, hook setup, and Git success
or failure, while retaining its existing authentication error classification. Pull now uses the
same lifecycle, including hook setup and remote error classification.
The local `fast_forward_branches` ref update now also acquires the repository lock and records
terminal success/failure; remote branch deletion and single-ref fetch remain.
Single-ref Fetch now also participates in the repository lock, including trampoline bind failure and
remote error cleanup. Remote branch deletion now uses the Push lock category and the same session
and terminal cleanup rules. The initial remote-mutator lock set is complete; Slice 9's remaining
work is lock coverage review and multi-window conflict/concurrency verification.
The merge command is now the first history-changing boundary with the same repository lock and
terminal lifecycle, including hook setup and merge-result/error handling.
The initial Rebase command now acquires the repository lock, records its initiating window, and
releases it on clean or failed replay results. Conflict and outstanding-file results instead enter
recovery while retaining the lock; Rebase Continue uses that retained operation and releases it only
after a terminal result. Abort/recovery-failure handling remains separate.
Merge `Failed` results now enter recovery without releasing the lock. Merge and Rebase Abort release
retained locks only after a successful abort; an abort failure records `recoveryFailed` and retains
the lock for truthful recovery handling.
The repository toolbar now disables Fetch, Pull, and Push while the selected repository has an
active locked operation, including an operation observed from another window.
Merge recovery completion now consumes the retained operation: a successful recovery commit ends
it as recovered, while a recovery-commit failure records `recoveryFailed` and retains the lock.
The Revert command now acquires the repository lock before invoking Git and records terminal
success or failure, preventing concurrent history mutations in the same repository.
Cherry-pick now acquires the same lock, retains it across conflict and outstanding-file recovery,
and releases it only after completion or successful abort. Failed aborts retain the lock as
`recoveryFailed`.
Squash and reorder now use the Rebase lock category and retain the repository lock when their
replay reports conflicts or outstanding files requiring recovery.
Reset, path reset, and index-clearing commands now use the Checkout lock category and report
terminal success or failure, preventing concurrent worktree/index writes in the same repository.
Submodule path reset now uses the same Checkout lock and terminal lifecycle.
Stash create, drop, pop, rename, and move now also serialize repository ref/worktree mutations
through the Checkout lock without changing their return values.
Branch create, rename, local deletion, and generic ref deletion now use the same Checkout lock
and terminal lifecycle; read-only branch queries remain independent.
Resolved-conflict staging and selected-change discard now use the Checkout lock and terminal
lifecycle, covering additional index/worktree writes.
Tag creation and deletion now use the Checkout lock and terminal lifecycle as repository ref
mutations.
Remote add/remove/URL updates and repository description writes now use repository-scoped locks
with terminal lifecycle reporting.
Cleanup and `.gitignore` writes now use the Checkout lock and terminal lifecycle reporting.
Index-to-worktree checkout now uses the Checkout lock and terminal lifecycle reporting.
Repository-local LFS hook installation now uses the Checkout lock and terminal lifecycle reporting.
Remote HEAD refresh now uses the Fetch lock across credential setup and local metadata update,
including bind and remote-error cleanup.
The native lock matrix now has a focused two-window lifecycle test proving same-repository peer
rejection, different-repository concurrency, and reuse after terminal lock release. The real GUI
multi-window foundation is complete here and remains part of the broader Slice 19 resilience matrix.
Peer windows now show the active operation summary and `Started in another window` in the repository
toolbar while the matching repository is locked; unrelated repository windows remain unchanged.
The History toolbar action is disabled during active merge, rebase, cherry-pick, and revert
operations so peer or owner windows cannot present stale history while refs are moving.
The history suppression policy is now centralized and covered by focused tests for history-moving
versus non-history operations.
Each matching window now refreshes branch, remote, worktree, conflict, and loaded history stores
once when the scoped operation reaches a terminal state; unrelated repositories are not refreshed.
Terminal-state eligibility is centralized and covered by focused tests, keeping refreshes out of
running, waiting, and recovery phases.
The current repository-local mutator audit is complete: every command that writes an existing
repository's refs, config, index, worktree, hooks, ignore files, stash, or remote metadata now
crosses a repository lock boundary. Global configuration/install commands and initialization of
an as-yet-uncreated repository remain intentionally outside this lock.

Wire lock acquisition into mutating command boundaries incrementally. At minimum classify:

- repository metadata/ref writes: Fetch, Push and related refresh/fast-forward stages;
- worktree/index writes: Checkout and Commit;
- history operations: Merge, Rebase, Cherry-pick, Revert, Squash and Reorder;
- destination writes: Clone.

Frontend behavior for a peer window showing the same repository:

- disable incompatible write actions;
- show operation summary and “Started in another window”;
- suppress stale History for a history-moving operation;
- refresh relevant stores after terminal events.

Frontend behavior for a different repository: no disabled controls, no operation dialog and no
operation error.

**Exit:** unit/native tests and a multi-window integration test prove same-repository exclusion and
different-repository concurrency.

Slice 9's exit evidence is complete. The Linux-container E2E matrix proves same-repository peer
controls, different-repository independence, matching-window terminal refresh, and owner-window
loss. It uses a deterministic sleeping pre-commit hook to prove a peer's Fetch action is disabled
while the owner commit is active, while another repository's Fetch action remains enabled.
Observer windows now subscribe before reading the active-operation snapshot and reconcile against
the native registry when focused and at a low frequency while visible, closing event gaps during
window creation or WebKit suspension. Focused multi-window E2E covers same-repository peer locking,
different-repository independence, and linked worktrees sharing a canonical repository lock while
retaining distinct selected paths. That coverage also found and fixed the operation-scope wire fields
being serialized as snake_case instead of the frontend's camelCase contract.
The container build passes TypeScript compilation, frontend bundling, and native linking with the
E2E harness's constrained-memory settings (`CARGO_BUILD_JOBS=1` and Rust debuginfo disabled). The
complete Linux-container suite passes all 33 tests after updating the migrated Preferences dialog's
stale existing title-ID selector.
The E2E foundation also verifies that the commit reaches `HEAD` after its owner window closes,
while the same-repository peer remains usable.
After completion, the peer now switches to History and verifies the new commit is visible, covering
terminal-event refresh in the matching window.

## Slice 10 — Prove the architecture with cancellable Fetch

**Goal:** ship the first safe end-to-end cancellation path before touching history.

**Progress:** the native Fetch cancellation path is implemented. Foreground and background Fetch now
reserve a cancellable repository-scoped operation, publish their existing progress into the shared
registry, and run under the inactivity watchdog. User cancellation and hard timeout terminate the
Git process tree through the shared execution control. Once Git has stopped, the command re-reads
remotes and status before reporting `cancelled/unchanged` or `timedOut/unchanged` and releasing the
repository lock; failed recovery reports `recoveryFailed/unknown` and deliberately retains the lock.
The controlled `git-ops` boundary and both recovery lock outcomes have focused native tests. A
local SSH transport fixture now emits Fetch activity and then waits at a file barrier, proving user
cancellation and timeout process-tree termination without a real network delay. Releasing that same
barrier proves successful completion, and the registry preserves that terminal result when a
cancellation request arrives too late. The same fixture now runs through a short-policy production
watchdog: activity reaches the registry, inactivity requests `TimedOut`, the SSH process tree exits,
repository recovery completes, and only then does the lock release as `timedOut/unchanged`.
The Linux-container E2E pilot now drives that same cancellation through the real command boundary.
It proves a peer sees the blocked Fetch and repository lock, a different repository completes its
own Fetch concurrently, destroying the owner leaves the first Fetch running and unowned, and the
surviving peer can request cancellation and observe `cancelled/unchanged` after recovery releases
the lock. Fetch execution, watchdog and recovery run in a detached native task because Tauri drops
the invoking command future with its webview; renderer loss can therefore no longer strand the
process or registry record.

Fetch policy:

- cancellation capability: `{ kind: "available", label: "Cancel fetch" }`;
- kill the process tree;
- wait for termination;
- refresh remotes/refs/status;
- tolerate unreachable downloaded objects;
- release the write lock only after refresh;
- report `cancelled/unchanged` or an accurate recovery error;
- hard timeout uses the same cancellation/recovery path but ends as `timedOut`.

Add a controllable Git/SSH fixture that blocks after reporting activity. Do not depend on a real
network timeout.

Required tests:

- user cancellation;
- hard timeout;
- cancellation racing successful completion;
- owner window closed during fetch;
- peer same-repository window observes cancellation;
- different-repository operation continues unaffected;
- repository lock is released only after refresh.

**Milestone gate:** stop and review architecture after this slice. Do not expand cancellation until
the process tree, timeout, recovery, replay and repository isolation are demonstrated together.

**Status:** complete. The architecture review gate is reached: process-tree termination, inactivity
timeout, post-termination recovery, terminal replay, owner-window loss, peer cancellation and
different-repository concurrency are covered by native and Linux-container tests.

## Slice 11 — Make Clone transactional and cancellable

**Goal:** avoid leaving an ambiguous partially cloned user destination.

**Progress:** the transactional installation foundation is implemented. Clone now reserves a
destination-scoped native operation, stages Git output in an app-owned sibling directory, atomically
renames that directory into the requested destination only after Git succeeds, rejects pre-existing
destinations, and removes only the staged directory on clone or installation failure. Cancellation,
timeout process control are now wired through the shared Git execution control; cancellation and
timeout remove the staging directory and finish as `cancelled/unchanged` or `timedOut/unchanged`.
The staged clone, watchdog, cleanup, and final install run in a detached native task so owner-window
loss cannot strand the staging directory or destination lock. A Linux-container E2E now blocks the
real SSH transport, cancels the destination-scoped operation, verifies the terminal cancellation
event and confirms that both the requested destination and `.rdc-clone-*` staging entries are absent.
The remaining Slice 11 evidence is a deterministic timeout journey and the explicit policy/test for
the pre-existing destination policy; the policy is to reject the path, including when it is empty.

Preferred design:

1. Create an app-owned temporary sibling destination.
2. Clone into the temporary destination.
3. On success, atomically move/rename it to the requested path where supported.
4. On cancellation/timeout, remove only the app-owned temporary destination.
5. Never recursively delete a pre-existing user-selected directory.

An existing destination, including an empty directory, is rejected before the operation is registered.
This avoids recursively deleting user-owned data and is covered by the Clone E2E. Cross-device rename
and platform differences still need explicit handling; do not silently fall back to copying a partially
visible repository without preserving cancellation safety. Native timeout cleanup is covered by the
shared watchdog tests, and a real blocked-Clone timeout E2E verifies the production watchdog emits
`timedOut/unchanged`, reports the typed timeout error, and removes the destination and staging data.

**Exit:** complete. Cancellation and timeout leave neither a registered repository nor app-owned
partial data; the Linux-container Clone journey covers both terminal paths, and an existing empty
destination is rejected without modification.

## Slice 12 — Present hook cancellation

**Goal:** expose the cancellation capability the backend already has for a running hook.

- Route hook ID/status into the operation record.
- Offer `Stop hook`, not `Cancel commit/push/pull`.
- After stopping, preserve the existing hook-failure Abort/Ignore decision.
- Treat terminal hook output as activity.
- Handle a hook completing just before the stop request.

**Progress:** complete. The commit flow tracks the active hook in frontend state, exposes `Stop
<hook> hook` from the shared commit progress dialog, and preserves the existing Abort/Ignore prompt
after a stopped hook fails. Native operation snapshots carry hook ID/name/status for commit, merge,
push, and pull; hook transitions also refresh the operation watchdog activity clock. Focused native
tests cover the late-stop race, and the Linux-container E2E stops a real long-running pre-commit
hook before proving the Abort path; the existing working-tree E2E proves Ignore and Continue.

**Exit:** complete. Commit-hook tests prove stop, race and Abort/Ignore handoff; push and pull share
the same operation-scoped hook support.

## Slice 13 — Recover sequencer/history operations

**Goal:** support cancellation only when the process has stopped and Git state can be recovered.

Apply the pattern to Rebase, Cherry-pick, Revert, Squash and Reorder:

1. capture pre-operation `HEAD` and operation snapshot;
2. request process-tree termination;
3. wait for termination;
4. inspect rebase/sequencer state;
5. invoke the matching abort command when state exists;
6. refresh `HEAD`, index, worktree and operation state;
7. classify race outcomes as `completed`, `recovered`, `unchanged` or `unknown`.

Existing `abort_rebase` and `abort_cherry_pick` recover paused operations; they are not concurrent
process cancellation. Revert now has an explicit native `revert --abort` command, frontend IPC, and
an operation-owned controlled runner; all five operation families now expose the same termination
boundary to the command layer.

**Exit:** complete. Real-repository tests prove branch/worktree restoration and completion races
for each recovery policy. Squash and Reorder deliberately share the interactive-rebase recovery
policy and command path, with operation-specific controlled-cancellation tests guarding their
entry points.

**Progress:** Rebase now has an operation-owned controlled runner and a cancellable repository
operation. Cancellation or timeout is handled only after the Git process tree has terminated; the
command then invokes `rebase --abort` and reports `cancelled/recovered` or `timedOut/recovered`.
Cherry-pick now follows the same boundary and inspects both sequencer state and the pre-operation
`HEAD` before deciding whether to invoke `cherry-pick --abort`; a late stop after `HEAD` advanced is
reported as completed, while an unchanged repository is reported as unchanged. Rebase now applies
the same metadata/`HEAD` guard before `rebase --abort`. Revert now checks `REVERT_HEAD` and the
pre-operation `HEAD` before invoking `revert --abort`, so a completed revert cannot be undone by a
late stop request. Squash and Reorder now use controlled interactive-rebase execution and the same
recovery boundary. Real controlled-cancellation tests for Rebase, Revert, Squash, and Reorder prove
`HEAD` remains unchanged; Revert also has paused-abort restoration coverage. Real command-layer
abort tests assert branch, worktree, index, and registry lock restoration for Rebase, Cherry-pick,
and Revert. Squash and Reorder use that same tested interactive-rebase abort policy rather than a
second recovery implementation.
Cherry-pick recovery explicitly handles the marker-only state used by
a single conflicted pick, which has `CHERRY_PICK_HEAD` without a sequencer snapshot. Real command-
layer Rebase, Cherry-pick, and Revert completion-race tests now prove an advanced `HEAD` is
classified as completed and the lock is released without aborting. The shared command recovery
test covers the equivalent late-stop races for Squash and Reorder. Fixture investigation confirmed
that a normal Cherry-pick can advance `HEAD` before a late stop request is observed; the new guards
prevent that completed pick from being unconditionally aborted. Slice 13's native, frontend, and
Linux-container regression gates pass together.

## Slice 14 — Add Merge cancellation and recovery

**Goal:** stop an active merge without racing `merge --abort` against the original process.

**Progress:** complete. Merge now runs through controlled process execution, exposes a cancellable
`Cancel merge` operation, starts a watchdog, and distinguishes ordinary merge state from the
squash-merge pre-commit state. Termination recovery aborts the appropriate state, preserves an
advanced `HEAD` as completed, reports unchanged termination when no state was created, and retains
the repository lock when conflict-state inspection or recovery fails.

After termination:

- if `MERGE_HEAD` exists, run `merge --abort` and refresh;
- if `HEAD` advanced, classify as completed rather than resetting history automatically;
- if neither is true, verify the index/worktree before reporting unchanged;
- if a squash merge is between merge and commit stages, use a distinct recovery policy.

**Exit:** complete. Native merge tests cover clean merge and conflict reporting. Command-layer
tests cover conflicted-merge restoration, fast-forward completion races, squash pre-commit
recovery, cancellation/timeout classification, and recovery failure with lock retention. The
frontend cancellation affordance remains part of Slice 16's unified progress presentation; this
slice establishes the native cancellation and recovery contract it will consume.

## Slice 15 — Resolve risky operation policies

Do not expose cancellation for these operations until their individual policy is implemented and
tested.

**Progress:** complete. Push now has a controlled runner and a `Stop waiting` capability. After
termination, branch and requested tag pushes are reconciled with direct `ls-remote` queries: matching
remote SHAs are reported as completed, while a failed or inconclusive query reports
`outcome: unknown`. Pull, Checkout and Commit now have native stop and recovery policies. Commit’s
generic user-facing cancellation remains unavailable until Slice 16 supplies the capability-aware
unified presentation; hook cancellation remains independently available.

Push policy is complete for branch and tag refs, including local-remote reconciliation coverage.
Pull is now split internally into explicit phases, and the native Pull runner now:

- Fetch the remote with the existing controlled Fetch runner and remote progress model.
- Reconcile the fetched integration target using the configured `pull.rebase` and `pull.ff` policy.
- Delegate merge integration recovery to Merge and rebase integration recovery to Rebase.
- Keep hook interception active across the integration phase and preserve `noVerify` behavior.
- Report network cancellation separately from an integration conflict or recovery failure.

The phase-specific command routing is now implemented: Fetch termination uses Fetch recovery,
merge integration termination uses Merge recovery, and rebase integration termination uses Rebase
recovery. A real blocked-network test proves Pull identifies the Fetch phase, terminates it, keeps
the repository lock during recovery, and releases the lock only after Fetch recovery succeeds.
Existing Pull integration and Fetch recovery tests pass. A deterministic blocked pre-merge-hook
test now proves Pull identifies `pullMerge`, invokes Merge recovery, and preserves the lock until
the recovery boundary; depending on the exact hook boundary, recovery reports unchanged or
recovered rather than guessing that the merge completed.
A matching blocked `pre-rebase` test proves the `pullRebase` route and Rebase recovery boundary.
Merge recovery also treats an already-advanced `HEAD` as completed even if Git has not yet removed
its transient marker. A hook-level test for that exact late-stop ordering remains blocked because
Git does not invoke the required hook during this pull path; the deterministic command-level merge
race test covers the advanced-`HEAD` classification.

Implementation order:

1. Push reconciliation and typed unknown-outcome tests.
2. Pull phase separation, delegating integration cancellation to Merge/Rebase recovery.
3. Checkout snapshot, restoration and late-stop tests for `HEAD`, index, worktree and untracked
   paths. **Complete at the native command layer.**
4. Commit index snapshot and completion-race tests, while preserving the independent hook stop
   flow from Slice 12.

### Push

- UI label: `Stop waiting`, not `Cancel push`.
- The remote may already have accepted the update.
- After local termination, fetch the remote to determine the result when possible.
- Permit terminal `outcome: "unknown"` when reconciliation fails.

### Pull

- Split/report phases: network fetch versus merge/rebase integration.
- Network-phase cancellation may use Fetch policy.
- Integration-phase cancellation delegates to Merge/Rebase recovery.
- Do not infer phase from percentage alone.

### Checkout

- No `checkout --abort` exists.
- The tracked-state snapshot is implemented and tested: it records symbolic or detached `HEAD`,
  preserves the raw index bytes so partially staged entries and extensions are not reconstructed
  incorrectly, and stores a `--binary --full-index` worktree patch relative to the original commit.
  Tracked restoration now atomically reinstates the index after restoring symbolic or detached
  `HEAD`, then reapplies the binary worktree patch; a real-repository test proves partially staged
  and unstaged content survive a simulated checkout. The snapshot also inventories ordinary and
  ignored untracked paths using Git's NUL-delimited output, preserving arbitrary path bytes on Unix
  and failing closed on invalid Windows path encoding. Ordinary and ignored file contents now carry
  platform metadata, symlinks have a distinct target representation, and capture is bounded to
  10,000 entries and 64 MiB so an ignored build tree cannot consume unbounded memory. Untracked
  restoration now recreates file contents, Unix modes or Windows readonly state, and symlinks after
  safely replacing changed or missing paths. Recovery refuses to proceed when a new untracked path
  appears after the snapshot, preserving an unknown outcome instead of deleting user data.
  A controlled branch-checkout runner now terminates at a blocked `post-checkout` hook and reports
  the native cancellation reason. Local, remote-branch and detached-commit Checkout commands now
  own a snapshot, watchdog and recovery path; the command test restores `HEAD`, tracked state and an
  untracked file that the target branch overwrote, and releases the lock only after recovery. The
  snapshot is acquired under the repository lock, an advanced `HEAD` is classified as completed,
  and submodule updates use the same controlled Git process. Checkout cancellation policy is now
  complete at the native command layer.
- The pre-operation snapshot must capture the symbolic `HEAD` target (or detached SHA), the complete
  index including staged modes/content, the tracked worktree patch including binary files and modes,
  and the inventory/content of untracked paths that checkout could overwrite. A `HEAD` SHA alone is
  not a safe restore point.
- Restore in this order: stop the Git process, verify whether `HEAD` advanced, restore the ref state,
  restore the index, then restore tracked and untracked worktree content. If any part is ambiguous or
  cannot be restored exactly, finish with `outcome: unknown` and retain the repository lock for the
  recovery path rather than claiming cancellation succeeded.
- Add fixture-backed tests for clean state, staged changes, unstaged tracked changes, untracked files,
  detached `HEAD`, and a late stop after checkout has advanced the ref.
- Keep the final unified UI presentation aligned with this native capability; no generic cancellation
  affordance should be added to operations whose policy remains unavailable.

### Commit

- Current implementation unstages and stages the real index before `git commit`.
- `git_ops::commit` now captures an unborn-safe `HEAD` plus exact raw index bytes and can restore that
  index atomically. A completion-race classifier and tests prove that an advanced `HEAD` is completed
  while an unchanged `HEAD` is safe to restore. The command now has an internal controlled runner and
  recovery boundary. Command-level tests now prove timeout recovery restores the unchanged index and
  releases the repository lock, while a late HEAD advance returns the committed SHA without rollback.
  A native controlled-runner test also proves termination is surfaced before commit completion without
  advancing `HEAD`.
  Recovery now fails closed when Git state cannot be inspected, retaining the repository lock; this
  boundary is covered by a command-level test.
  The native Commit policy is complete: blocked-process, late-completion, unchanged-index,
  watchdog/termination and recovery-failure boundaries are covered. The user-facing capability stays
  unavailable until the unified progress presentation can render its explicit policy safely.
- After termination, inspect whether `HEAD` advanced before deciding to restore.
- Keep the generic user-facing cancellation affordance unavailable until Slice 16 wires the explicit
  Commit capability into the unified progress presentation.
- Hook cancellation remains independently available through Slice 12.

**Exit:** every progress-producing operation has an explicit supported, unavailable or
outcome-unknown policy; none silently inherits a generic Cancel button.

## Slice 16 — Build the final unified progress presentation

**Goal:** render one lifecycle model consistently after the backend can uphold it.

**Progress:** complete. `OperationProgressViewModel` now derives operation labels, lifecycle copy,
owner/observer cancellation capability and recovery/error status from the native `OperationRecord`.
`OperationProgressDialog` accepts that model and renders cancellation, recovery, terminal error and
close affordances while preserving the compatibility prop adapter for dialogs that have not yet
migrated.
Commit, Merge and Rebase progress surfaces are now wired to the selected window's native operation
record while retaining their operation-specific initiation and current-commit details. Native
operation-specific cancellation labels flow through the shared model, and only the owner window gets
the action; observers remain read-only. Clone retains its destination-scoped initiation boundary.
`OperationProgressBody` now owns the reusable progress/live-status/error content independently from
the modal shell, so embedded toolbar/sidebar surfaces can consume the same lifecycle rendering.
Terminal errors are not announced twice. Focused presentation, dialog and operation-store tests cover
owner cancellation, recovery, terminal errors and non-modal body rendering.
Cancellation requests now override stale Git progress immediately, the slow-operation warning cannot
be hidden by an old progress description, and observer/unowned windows identify their ownership
context without inheriting the owner's controls.
The modal renders no empty action row when a callback is unavailable, and focus moves to Close when
an in-flight cancellation reaches a terminal state.
Terminal state takes precedence over a stale cancellation request: completion races render
`Completed before cancellation`, failed unknown outcomes render `Outcome unknown` alongside their
error, and the completed/cancelled/timed-out/failed matrix has focused coverage.
An unowned operation now exposes an explicit `Take control and cancel` action only after the owner
window disappears; observers with a live owner remain read-only. Recovery failures identify that
repository recovery is required before continuing.
Retry is now an explicit opt-in capability in the view model; recoverable errors do not imply retry
is safe, and the shared dialog renders Retry only when both the capability and callback are present.
Debug/test clone states that predate native-operation hydration remain supported when the optional
record is absent.
CloneStore now hydrates the native clone-destination operation after invocation starts and follows
only that operation ID through the global event stream. Native lifecycle tracking is presentation
enrichment rather than a prerequisite for cloning, and stale/reset clone callbacks remain rejected.
The Clone dialog now consumes that native view model and routes its operation-specific Cancel action
through the hydrated native operation ID; the form's ordinary Cancel remains separate and available
only before cloning starts.

The final presentation audit is complete. The shared model and dialog cover the documented running,
slow, cancelling, recovering, cancelled, timed-out, failed, completed-before-cancellation,
unknown-outcome, recovery-required, owner, observer and adopted-control states. The frontend suite
passes with 130 test files and 1,183 tests.

Refactor `src/lib/ui/dialogs/operation-progress-dialog.tsx` to consume an operation view model rather
than loose operation-specific props. Extract a shared progress body so background operations can use
the same content without mounting a dialog.

The presentation must support:

- `Running`;
- `Taking longer than expected`;
- `Cancelling…`;
- `Recovering repository…`;
- `Cancelled`;
- `Timed out`;
- `Failed`;
- `Completed before cancellation`;
- `Outcome unknown`;
- recovery-required state that does not dismiss or unlock the repository.

Controls:

- no Cancel control for `unavailable`;
- operation-specific label for `available`;
- disabled progress action after cancellation is requested;
- `Retry` only when the operation policy marks retry safe;
- `Close` only after a terminal/recovered state;
- recovery guidance/actions when automatic recovery fails.

Window behavior:

- initiating window gets full controls;
- same-repository peer windows mirror progress and identify the owner;
- peer windows normally omit cancellation while the owner exists;
- after owner loss, a peer may explicitly adopt cancellation authority;
- different-repository windows render nothing for the operation.

Accessibility:

- keep `role="alertdialog"` for blocking user-initiated operations;
- retain live progress status without repeatedly re-announcing the entire dialog;
- announce lifecycle transitions and timeout errors;
- move focus predictably when Cancel changes to a terminal action;
- Escape/backdrop remain blocked while the repository is running/cancelling/recovering;
- errors and recovery instructions remain keyboard reachable.

**Exit:** focused component tests cover every state/capability/owner combination and focus behavior.

## Slice 17 — Migrate all progress producers

Migrate incrementally to the operation record and shared presentation:

1. Fetch pilot. **Complete:** the toolbar renders the native Fetch record through the shared
   non-modal `OperationProgressBody`; store-owned remote state remains the refresh/error
   compatibility path, and the toolbar no longer renders callback progress or derives lifecycle
   busy state directly from the store.
2. Clone. **Complete.**
3. Rebase. **Complete.**
4. Commit and hook handoff. **Complete.**
5. Merge/squash merge. **Complete.**
6. Push/Pull. **Complete:** the toolbar uses the same native shared body for Push and Pull and
   prefers the native operation record for action labels/icons; store-owned remote state remains
   the orchestration, refresh and error compatibility path. Application menus now also subscribe
   to the native repository lock before deriving remote-action enablement.
7. Checkout. **Complete:** the branch sidebar renders native Checkout progress through the shared
   body; branch-store state remains the refresh/error compatibility path.
8. Cherry-pick/Revert. **Functional migration complete; Slice 20 owns QA closure:** the History commit context menu now starts the native
   Cherry-pick and Revert commands, and their operation records mount the unified progress dialog.
   The conflict surface now identifies Cherry-pick/Revert recovery, stages resolutions, offers
   Cherry-pick continuation and explicit abort for both operations. Interactive Squash/Reorder
   now have initial selection/execution controls: selected commits can be squashed into the oldest
   selected commit or moved to the end of history, with native progress shown through the shared
   model. Squash validates contiguous ranges, and Reorder supports an explicit target or end of
   history. The History workspace now has focused interaction coverage for selection, Squash and
   explicit Reorder targets; real-shell E2E now verifies contiguous selection and executes both
   Reorder and Squash against a disposable repository. Recovery coverage verifies Cherry-pick
   continuation is gated on staged resolutions and Revert remains abort-only; the recovery banner
   now reflects that distinction by hiding unsupported Revert staging controls. Shared presentation tests now cover
   native Cherry-pick/Revert labels, progress, owner cancellation controls, and terminal recovery
   presentation, including terminal focus restoration and close behavior. The independent native
   command journeys now cover both recovery paths rather than using browser-side IPC shortcuts. A
   debug-only QA-driver seam now selects the repository and invokes the production IPC wrappers,
   preserving their real progress channels; its ordering contract is covered by frontend tests.
   A real `history-recovery.test.mjs` journey now prepares a disposable conflicting repository,
   starts Cherry-pick through that seam, verifies native recovery and the disabled continuation
   control, then aborts through the production UI. Independent Linux-container journeys now pass
   both Cherry-pick and Revert recovery; Revert conflicts are classified as native recovery when
   Git leaves `REVERT_HEAD`, rather than being reported as terminal command failures. The first
   container attempt found and fixed the Vite debug-build gate: `tauri build
   --debug` sets `__DEV__` false, so the E2E-only `VITE_RDC_QA_DRIVER=1` flag now enables the
   listener while the Rust QA driver remains debug-only. The rebuilt full Linux-container suite
   now passes all 41 tests, including the keyboard-only rerender regression check.

Remote-store compatibility is now closed. `RemoteStore` continues to own remote selection,
post-operation refresh sequencing, boolean action results and remote-management error
classification, while native operation records own repository-operation lifecycle, progress,
refresh requirements and transport errors. The store retains only operation identity for stale
request gating and a management-operation guard; it no longer exposes duplicate lifecycle,
progress or operation-error fields.

The final remote refresh/error consumers now use native operation events. Preserve stale callback
rejection by operation ID and keep domain-store post-operation refresh behavior intact.

The native remote-workflow coordinator boundary is now implemented: multi-remote Fetch
and Push/Pull transport phases run under one operation-owned workflow, publish terminal refresh
requirements, and preserve remote-specific error classification. The progress-weighting portion is
isolated in `remote-operation-progress.ts` with focused coverage.

The native producer `fetch_workflow` owns the repository lock,
watchdog, cancellation, multi-remote transport loop, weighted native progress, and terminal
transport outcome. `RemoteStore` now consumes it for the real IPC dependency and retains the
store-owned remote-head/facts refresh follow-up after consuming that terminal requirement. Test
doubles that replace the single-remote transport continue to use the compatibility loop explicitly.
The native record carries an optional `refresh` requirement so peer windows
receive the same post-transport contract as the initiating controller, and the store consumes the
returned record when choosing remote-head refreshes.

Pull no longer starts a second Fetch from `RemoteStore`: native `pull_phased_controlled` already
owns the Fetch/integration sequence, leaving the store responsible only for its post-operation
remote-head and repository-facts refresh.

Native Push now owns its follow-up Fetch under the same Push operation and publishes Fetch progress
through the operation registry. `RemoteStore` skips its compatibility Fetch only for the real IPC
Push implementation; injected transports continue to exercise the older two-call path.

Native Push and Pull now also publish `OperationRefresh` metadata on successful completion, so
peer windows receive the same remote-head and repository-facts refresh requirement as Fetch.
The operation store exposes that metadata and the terminal refresh coordinator honors its
`repositoryFacts` flag, retaining the broad refresh fallback for operations without metadata.
The operation registry also verifies that the refresh requirement survives terminal completion and
remains available to observers.
The toolbar no longer renders a remote operation error from store state; management failures such
as Add/Remove Remote continue to use the public store `error` field.

The public `RemoteState` contract now removes `operation`, `progress`, and `operationError`. Native
operation records own those lifecycle concerns; the store retains refresh sequencing and maps
management failures into the public `error` field.

The private lifecycle bookkeeping is now removed as well: `RemoteStore` retains only operation
identity for stale-request gating and a management-operation guard. Compatibility transport
callbacks no longer publish progress or operation-error state.

Latest verification after this removal: the complete frontend suite passes (136 files, 1,212
tests); focused remote and operation tests remain green; and the Linux-container E2E suite passes
39 tests across 17 suites, including the History interactive-controls journey; the focused History
E2E passes 3 tests including Git-verified Reorder and Squash mutations; focused recovery tests pass
3 tests.

Coordinator acceptance boundary:

- one repository-scoped native operation spans every selected Fetch transport and the Push/Pull
  transport, follow-up Fetch, and repository-refresh phases;
- cancellation and watchdog timeout stop the active transport and finish the same operation with the
  existing cancelled/timed-out recovery classification;
- progress events identify the active remote and phase while preserving the shared 0–1 weighting;
- completion publishes whether remote-head and repository facts must be refreshed, so the controller
  can perform that work without recreating a second lifecycle;
- authentication, network, cancellation, timeout, and recovery failures retain their existing
  user-facing classification and terminal operation state;
- tests cover multiple remotes, a transport failure before refresh, a refresh failure after a
  successful transport, stale observer windows, cancellation, and watchdog timeout.

User-initiated operations mount the unified dialog. Scheduled/background Fetch mounts the shared
progress body in its non-modal control and never opens a surprise dialog.

**Exit:** every migrated production progress producer uses the native operation record for lifecycle
and shared presentation; the remaining RemoteStore callback fields have documented refresh/error
consumers and are removed only when their native equivalents are complete.

## Slice 18 — Restart and abandoned-operation recovery

**Goal:** avoid hiding Git state after app crash or forced termination.

On repository load, inspect at least:

- merge state (`MERGE_HEAD`);
- rebase state;
- cherry-pick/revert sequencer state;
- operation recovery markers owned by rdc;
- stale app-owned clone temporary destinations.

First increment: native repository status now reports the optional `isRevertingHeadFound` fact
when Git leaves `REVERT_HEAD`; the field is omitted for clean repositories so existing wire
consumers remain compatible. Rust status and wire-contract tests cover the new marker fact.
The conflict store now hydrates Cherry-pick/Revert recovery from those marker facts when no live
operation record survives the restart, and the recovery banner's abort/continue actions use that
hydrated operation kind. Focused restart E2E passes after this hydration path is loaded.
It also retains interrupted rebase state from `rebaseInternalState` and presents explicit recovery
guidance after reload. The recovery surface now exposes native Continue rebase and Abort rebase
actions, with continuation gated until conflicted files are staged; focused restart E2E passes
after the handlers are wired through AppShell. Interrupted merge state now has an explicit Abort
merge action and explains that the staged resolutions can be completed by committing the merge;
the abort handler refreshes the native conflict state after Git cleans up. Clone startup now
removes only app-owned stale staging siblings for the requested destination after a restart;
the cleanup is covered by a native test that preserves unrelated destinations.
The operation registry remains process-local by design: the supported restart states are all
reconstructed from Git markers or deterministic clone staging paths, so startup never rehydrates a
stale `Running` record and falsely presents an operation as active. A persistent rdc journal is
therefore not required for the current operation set; add one only when a future recovery state
cannot be reconstructed from Git, and reconcile it against Git before exposing it.

Do not claim the original process is still running after an app restart. Present the detected
repository state as recovery-required and offer the operation-specific continue/abort path.

If recovery failure needs to survive a full app restart, persist a small operation journal outside the
repository and reconcile it against actual Git state on startup. Actual Git state wins over stale
journal data.

**Exit:** restart tests recover or honestly explain each supported interrupted state.

## Slice 19 — Required multi-window and resilience coverage

First increment: the native-window coverage now exercises same-repository and linked-worktree
scope sharing, independent repository concurrency, peer write disabling, operation hydration in a
second window, terminal history refresh, and owner-window loss without terminating the operation.
The Fetch cancellation journey additionally proves that an unowned operation can be explicitly
adopted and cancelled from a peer while an independent repository continues fetching. These are
the baseline scenarios for the remaining timeout, recovery-failure, completion-race, and terminal
refresh matrix below.

The deterministic resilience coverage already proves the next boundaries: Clone timeout publishes
the typed `timedOut` error and removes only its staging directory; the native watchdog retains the
scope lock until termination finishes; recovery failures publish `recoveryFailed`/unknown and keep
the write lock; and late-stop tests for Commit, Merge, Rebase, Cherry-pick, Revert, Squash and
Reorder classify an already-completed mutation as completed. Slice 19 still needs the matching
multi-window E2E assertions for those terminal outcomes and Push's explicitly unknown stop result.

Add automated coverage for this matrix:

- operations in two different repositories run concurrently;
- Repository A never disables Repository B;
- two windows on Repository A cannot start conflicting writes;
- a second Repository A window receives live progress;
- opening a new Repository A window hydrates current progress;
- closing the owner window does not terminate Git;
- cancellation authority transfer is explicit;
- Fetch cancellation clears its lock after refresh;
- Clone cancellation removes only app-owned temporary data;
- timeout emits a typed error and runs recovery;
- recovery failure retains the write lock;
- cancellation racing completion reports completed;
- Push stop may report outcome unknown;
- background Fetch remains non-modal;
- terminal events refresh every matching window and no unrelated window.

E2E remains Linux-container-only. Keep one product slice per spec file and no cross-file ordering.
Use deterministic blocking helper processes or local repositories; never depend on real network
latency to create a cancellation race.

## Slice 20 — Documentation, QA and closure

Before closing the work:

1. Update `MIGRATION_PLAN.md` with landed slices and measured behavior.
2. Update `MIGRATION_MAP.md` paths, deliberate departures and remaining unsupported cancellation.
3. Update `COMPONENT_MIGRATION_PROCESS.md` with the final dialog/embedded presentation contract.
4. Own all remaining QA for migrated dialogs and progress surfaces, including Slice 17's
   Light/Dark, compact viewport, owner/observer, timeout and recovery rows. Slice 17 supplies the
   functional evidence; Slice 20 records human visual sign-off and platform evidence.
5. Record platform evidence for process-tree termination on Linux and macOS; Windows remains governed
   by the Phase 10 target but its seam must compile when introduced.
6. Run the store-surface measurement when command additions/removals settle; copy numbers from the
   script output, never by hand.

Run the complete repository gate set before every commit:

```sh
nvm use
pnpm test
pnpm exec tsc --noEmit
pnpm format:check
pnpm lint
pnpm test:e2e

cd src-tauri
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

Run every command above even though some are grouped under one frontend or Rust gate in repository
documentation. E2E always runs through the Linux container.

## Agent stop conditions

Stop the current slice and report the blocker rather than guessing when:

- repository identity cannot distinguish same versus different repositories;
- cancellation can kill only direct Git but not descendants;
- recovery would require silently resetting user history or working-tree content;
- a timeout would clear UI state while native work may still run;
- same-repository coordination would require blocking unrelated repositories;
- Push/Pull final state cannot be classified honestly;
- a platform arm has no compiled/tested signature;
- completing the slice requires changing a wire contract without regenerating its snapshot.

Never ship a Cancel button as a frontend-only state reset. Never release a repository write lock
until the native process has terminated and the operation has either completed safely, recovered, or
entered an explicit recovery-required state.
