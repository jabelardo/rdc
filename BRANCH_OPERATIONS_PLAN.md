# Branch operations — closing the MVP menu gap

**Status**: Slices 1–3 (discard-all ×2, rename + delete, merge initiation) are landed and promoted
in the menu baseline — code-complete and gated-green. **Slice 4 (abort merge) landed 2026-08-15** — a real gap found checking the MVP exit criteria against the actual code, not a scope
change to what Slices 1–3 already closed. `update-from-default remains deferred to Phase 7f` by
the scope decision. Supersedes the "expected disposition" paragraph of F-MENU-001 in
`qa/phase-8b/evidence/menu-mvp-alignment-findings.md`. Native-menu-dispatch verification for every
landed item (Slices 1–4 once it lands) is QA-cycle-2 work, tracked in `REMAINING.md`, not this
plan — see "Why Linux leads" below for why Linux lost its automated proof too, partway through
Slices 1–3.

**Follow-up findings (also landed):** the Fetch/Push/Pull enablement rule is consolidated into a
single `remoteEnablement` predicate (menu, menu bar, toolbar all derive from it, with a parity test
closing the toolbar's missing repository-path guard), and remote management is added so a locally
created repository with no remote is no longer a dead end — Repository → Manage remotes… (and the
sidebar repository context menu) lists/adds/removes remotes via the existing `add_remote` /
`remove_remote` commands.
**Blocks**: Phase 8b exit, on both MVP platforms.
**Lead platform**: Linux. See "Why Linux leads" below.

---

## What is actually missing

Verified layer by layer on 2026-08-03. **The git operations, their Tauri commands and their
TypeScript IPC wrappers already exist and are tested.** Phase 2/3 delivered the hard part. The gap is
one layer thick — store methods, UI affordances, menu wiring:

| Menu item | `git-ops` | Tauri command | TS IPC wrapper | Store | UI + menu |
|---|---|---|---|---|---|
| `rename-branch` | `rename_branch` | ✅ | `branch-ipc.ts` | ❌ | ❌ |
| `delete-branch` | `delete_local_branch`, `delete_remote_branch` | ✅ | `branch-ipc.ts`, `remote-ipc.ts` | ❌ | ❌ |
| `discard-all-changes` | trash + clean/checkout | `move_item_to_trash`, `clean_untracked_files` | `discardChanges(path, files[], …)` | partial | ❌ |
| `permanently-discard-all-changes` | same | same | same, `{ permanentlyDelete: true }` | partial | ❌ |
| `merge-branch` (initiation) | `merge.rs` | `merge_branch`, `determine_mergeability`, `abort_merge` | `git-ipc.ts`, `misc-ipc.ts` | ❌ | ❌ |
| `update-branch-with-contribution-target-branch` | `rebase.rs` | `rebase_branch`, `fetch`, `merge_branch` | `git-ipc.ts`, `remote-ipc.ts` | ❌ | ❌ |

`branch-store.ts` exposes only `load`, `createAndCheckout`, `checkout`, `clear`.
`working-tree-store.ts` only `discardFile`, `discardSelectedLines`. Those two files are the work.

The menu *items* already exist in `src/lib/menu/default-menu.ts` (faithful upstream port) and are
disabled by `withHonestStartupEnablement` because they have no executor. Wiring an executor plus an
enablement entry promotes them automatically — **do not add items to `default-menu.ts`.**

## Scope decision

`MIGRATION_PLAN.md` §"macOS/Linux MVP exit criteria" currently requires only *stage, unstage,
discard, commit*, *create and check out a branch*, and *recover* from a merge conflict. It names none
of the six items, while F-MENU-001 calls all six MVP-blocking. That contradiction is settled here:

- **In scope for MVP**: rename, delete, discard-all, permanently-discard-all, merge initiation.
  Criterion 3 is amended to name branch rename/delete and merge initiation; criterion 2 to name
  whole-tree discard. Do that edit as part of Slice 1 so the gate and the blocker agree.
- **Merge initiation is not optional**, for a reason worth recording: criterion 3 already requires
  recovering from a merge conflict, and today there is **no in-app way to enter one** —
  `e2e/merge-conflicts.test.mjs` creates the conflict with CLI `git merge`. Without initiation the
  existing criterion is only satisfiable from a terminal.
- **Deferred to Phase 7f**: `update-branch-with-contribution-target-branch`. It is a convenience over
  fetch + merge, both already MVP, and it is the only item needing a product decision (merge vs
  rebase strategy, a new persisted preference, a dynamic contribution-target label). Deferring it
  removes the largest slice and loses no capability. Record it in the checklist's "Removed" table
  with this reason. **Reverse this only deliberately** — it is the one judgement call in this plan.

## Why Linux leads

Written when this plan was drafted, and true for accelerator dispatch throughout Slices 1–3; the
menu *surface* premise of point 2 was overtaken mid-plan by `6eef6b6`/`17df5bf`, which replaced the
in-window bar with Tauri's native menu on every platform. Kept for the record, corrected below.

1. Linux is the primary target, and was, at the time, the only platform with automated product proof
   — the `tauri-driver` container suite. macOS has no WebDriver backend for WKWebView, so its
   evidence is a human checklist either way.
2. ~~The Linux surface is the in-window menu bar (`src/lib/ui/app/menu-bar.tsx`)~~ — **no longer
   true**. Linux and macOS now share the same native Tauri menu; there is no in-window bar on
   either platform. Accelerator dispatch still routes through `repository-menu.ts`'s enablement
   map either way, which is what actually mattered for building store → controller → menu →
   accelerator in one pass — that part of the reasoning holds, just not through the surface named
   here.
3. **macOS then comes along for free, by construction.** Both platforms share the enablement map and
   the executor, and `repository-menu.test.ts` asserts the implemented-capability set is identical
   across `macos`/`windows`/`linux` (capability-parity rule, scope rule 4 of the menu checklist). A
   slice cannot land Linux-only without failing that test.

**What Linux-leading no longer gives, now that both platforms are native:** proof that *either*
platform's native menu dispatches — not just macOS. Native GTK menus have no WebDriver backend
either, so the six E2E specs each slice's own "Tests" section below describes were written and
then deleted in `17df5bf`, for exactly that reason. Automated coverage for these six items is now:
unit tests (landed, per slice) plus `repository-menu.test.ts`'s capability-parity assertion. Human
coverage is `qa/phase-8b/macos-checklist.md` §7 **and** `qa/phase-8b/linux-wayland-checklist.md`'s
equivalent section (added in this reorganization pass). Until both run, the honest status of each
item is "implemented and unit-verified; native dispatch unverified on either platform".

---

## Slice 1 — Discard all changes (×2)

First **because it is the smallest slice that touches every layer**, so it establishes the wiring
pattern — store → confirmation → menu item → accelerator → parity test → E2E → macOS checklist — at
minimum risk, before the harder guards in Slice 2.

**Store** (`src/lib/stores/working-tree-store.ts`)

- `discardAllChanges(permanentlyDelete = false)`, passing the whole `workingDirectory.files` list to
  the existing `discardChanges(path, files, { permanentlyDelete })`. Reuse `discardFile`'s
  `TrashDiscardError` handling and its `trash-failed` → permanent fallback.
- **Ignores inclusion state.** This is "discard all", not "discard included" — `setFileIncluded` must
  not affect it.
- **Refuses while a merge is in progress.** Discarding everything mid-merge is ill-defined and
  destructive, and "the working tree is dirty" is trivially true during a conflict. Return a distinct
  result the UI can explain. **Where the guard reads merge state:** `mergeInProgress` *lives in
  `conflict-store`* (conflict-store.ts:21), derived there from `status.mergeHeadFound`
  (conflict-store.ts:192). The working-tree store has no access to it, so pick one of:
  - read `mergeHeadFound` in the working-tree store's own `getStatus` (`IStatusResult`) call and track
    it on `WorkingTreeState`, or
  - let the controller (which holds both stores, and already routes the menu action) refuse before
    calling `discardAllChanges`.
  Do the former only if another slice needs merge state in the working-tree store; otherwise the
  controller-side guard keeps the dependency graph flat. The unit test must cover the guard either
  way.

**Controller / UI** (`use-app-controller.ts`, `app-dialogs.tsx`, `menu-bar.tsx`)

- `requestDiscardAll(permanent)` honouring `confirmDiscardChanges` /
  `confirmDiscardChangesPermanently`.
- Confirmation copy must distinguish recoverable from not: untracked files go to the OS trash and can
  be retrieved, **modifications to tracked files are unrecoverable even on the non-permanent path.**
  State the file count.
- Menu items `discard-all-changes` / `permanently-discard-all-changes`, enabled when the working tree
  is dirty **and** no merge is in progress.

**Tests**

- Unit (`working-tree-store.test.ts`): the guard matrix — clean tree, dirty tree, merge in progress,
  mixed tracked/untracked, trash failure falling back to permanent, inclusion state ignored.
- E2E: new `discard-all.test.mjs`. Build the fixture in `harness.mjs` (mixed tracked modification +
  untracked file), invoke from the menu, assert `git status --porcelain` empty and the untracked file
  gone. Permanent variant asserts the same with no trash round-trip.
- QA fixture: `wholeFileDiscard` is a single tracked file, so it cannot exercise the tracked/untracked
  asymmetry. Add a `discardAll` scenario to `scripts/create-phase8b-fixture.mjs` and
  `qa/phase-8b/fixture-scenarios.md`.

## Slice 2 — Rename + Delete

**Store** (`src/lib/stores/branch-store.ts`)

- `renameBranch(from, to)` and `deleteBranch(branch, { includeRemote })`. Reuse the existing
  `finishOperation` reload pattern so `branchState` refreshes.
- **Validate the new name with `src/lib/sanitize-ref-name.ts`** (already ported, implements git's
  `check-ref-format` rules) and reject collisions with an existing branch, so the failure is a product
  message rather than a raw git error.
- Delete guards, in priority order:
  1. **Unmerged commits** — warn before deleting. `get_merged_branches` is already wrapped at
     `branch-ipc.ts:184`. This is the only genuinely destructive case here; it outranks the others.
  2. Current branch — refuse.
  3. Unborn HEAD / detached HEAD — refuse.
  4. Default branch — refuse or warn (decide and state).

**Keep the three remote concerns separate.** This is the easiest thing to get wrong:

| Intent | Call | Risk |
|---|---|---|
| Delete the local branch | `delete_local_branch` | local |
| Prune a stale tracking ref | `delete_ref` | local |
| Delete the branch **on the remote** | `delete_remote_branch` | network, destructive, needs credentials |

Deleting a local branch must **not** touch `refs/remotes/<remote>/<branch>` — that ref is the record
that the remote branch exists.

**Stated decision for Slice 2:** remote-branch deletion (`delete_remote_branch`) is **deferred to
7f**, not shipped. It is network + credentials + destructive with no undo, and the MVP regression is
the inability to manage *local* branches. What Slice 2 ships is:
- local delete (`delete_local_branch`), and
- an **opt-in** (default off) prune of the *stale tracking ref* via `delete_ref` when the local branch
  has an upstream and the remote branch is gone — local only, no network.
The remote branch is untouched by both. If remote deletion is later pulled into the MVP, that is a
recorded decision, not a convenience — and it needs actionable failure copy for the credentials path.

Rename with an upstream: the remote branch keeps its old name and the upstream config needs deliberate
handling. Decide, state it in the dialog, and cover it in a unit test.

**UI** — Branch menu items via `repository-menu.ts` (enablement + executor) and `menu-bar.tsx`; plus a
context menu on each `BranchListRow` in `repository-sidebar.tsx`, mirroring the existing
repository-row context menu. Dialogs in `app-dialogs.tsx`: rename prefilled with the current name,
delete with the unmerged warning and the remote checkbox.

**Tests** — Unit: the full refusal matrix and name validation (cheap and exhaustive here, expensive
and flaky in E2E). E2E: extend the `branch` pattern — rename and assert via `git branch --list`;
create and delete a throwaway branch and assert it is gone. Remember
`expandSidebarSection(driver, 'branches')` before touching branch rows: the sidebar is an accordion
and starts collapsed.

## Slice 3 — Merge initiation

**Store** — merge entry point on `branch-store` (or a dedicated seam if it needs conflict-store
coordination): `determineMergeability` pre-check, then `mergeBranch`.

- Handle **all three** mergeability outcomes, not just conflict: already-up-to-date, clean merge,
  conflicts expected.
- **Guard on a dirty working tree** — git refuses to merge with uncommitted changes.
- On conflict, hand off to the existing MVP conflict-recovery path; `conflictState.mergeInProgress`
  already drives that UI.
- Decide explicitly whether the picker offers remote branches (`origin/x`) or local only.

**UI** — branch picker dialog (excluding the current branch), menu item `merge-branch`, enabled when a
current branch exists, the tree is clean and no operation is running.

**Tests** — Unit: the three outcomes and the dirty-tree refusal. E2E: a clean fast-forward merge on a
fresh fixture asserting `HEAD` and history. **Then rewrite `e2e/merge-conflicts.test.mjs` to reach the
conflict through the product instead of CLI `git merge`** — that is the point of this slice, and it
retires the last place where an MVP criterion is only reachable from a terminal.

## Slice 4 — Abort merge

Added later than Slices 1–3, from a gap found checking rdc's actual code against the 7 MVP exit
criteria rather than against this plan's own claims: criterion 3 requires recovering from a merge
conflict "without being stranded," but there is no way to back out of one in-app today — only to
complete it. `abort_merge` exists and is tested at the git-ops/Tauri-command layer
(`src-tauri/src/commands/git.rs:364` → `git_ops::merge::abort_merge`, wrapped at
`src/lib/git-ipc.ts:371`, unit-tested in `git-ipc-commands.test.ts:305`) but nothing above that
layer consumes it: `conflict-store.ts` has no method for it, `merge-conflicts.tsx` has no button,
and — unlike Slices 1–3's items, which existed disabled — there is no `abort-merge` menu id
anywhere in `default-menu.ts` at all. This is a genuine addition to the menu inventory, not a
wiring gap.

**Store** (`src/lib/stores/conflict-store.ts`) — `abortMerge()`, calling the existing IPC path.
Refresh `workingTreeState`/`branchState` after, same `finishOperation`-reload pattern the other
branch operations already use.

**UI** — an "Abort merge" action in `merge-conflicts.tsx`, alongside the existing per-file "Stage
resolution" action. Needs its own confirmation: aborting discards whatever conflict-resolution
progress is uncommitted, which is destructive.

**Menu** — add the id, a new `MenuEvent` variant, an executor case in `repository-menu.ts`,
enablement gated on `mergeInProgress`, and an accelerator: `CmdOrCtrl+Shift+K` is free (checked
against every combo in `COMMON_DEFAULTS`, `src-tauri/src/platform/keybindings.rs:10-56`).

**Tests** — unit coverage for the store method and the confirmation flow. This is another
native-menu-only action, so — per the pattern already established for Slices 1–3 — no new E2E is
possible; native-dispatch verification joins the same `qa/phase-8b/macos-checklist.md` §7 /
`linux-wayland-checklist.md` line as the other five, tracked in `REMAINING.md`'s QA-cycle-2 item.

**Landed 2026-08-15.** Some of it had arrived early and by another route:
`OPERATION_PROGRESS_PLAN.md` Slice 18's restart recovery added the `Abort merge` button to
`merge-conflicts.tsx` and a controller handler that called the IPC directly. What this slice added
was the rest — and the confirmation the plan asked for, which that early arrival did not have.

- **Store.** `conflictStore.abortMerge()` returns the failure text rather than reporting it, because
  the confirmation dialog owns the action (Convention 17). It refreshes from the resulting status,
  and the controller reloads the working tree and branches too: aborting moves `HEAD` and the index,
  not just conflict state.
- **Confirmation.** Destructive, so it asks first and says what is lost. It stays open until the
  abort settles, renders a failure inline, and keeps Cancel enabled whenever the abort is not in
  flight.
- **Menu.** New id, event, item, executor, and enablement gated on `mergeInProgress` — the only
  Branch item gated on repository state rather than merely on a selected repository.
  `CmdOrCtrl+Shift+K`, which was free among the defaults.

Two things the existing tests caught, both worth keeping in mind for the next menu addition:

- The Windows/Linux label `A&bort merge…` collided on access key `b` with `New &branch…`. The
  duplicate-access-key test found it immediately; the label is `&Abort merge…`.
- Two keybinding tests used `Shift+K` as an arbitrary custom binding, so the conflict detector
  correctly refused the new default. They now use `Shift+J`, with a note saying why. The
  binding-count assertions moved 50 → 51: rdc now has one binding upstream has no equivalent for,
  which is the point of this slice.

Native dispatch is unautomatable as ever, so the row joins the other five in
`qa/phase-8b/macos-checklist.md` §7 and the Linux equivalent — including that the item must be
*disabled* with no merge in progress.

## Deferred — Update from default branch

Phase 7f. Needs a persisted `updateBranchStrategy` preference (`models/update-branch-strategy.ts` is
already ported), the merge-vs-rebase decision, the dynamic `contributionTargetDefaultBranch` label,
and a remote-present enablement rule. Record in the checklist's "Removed" table.

**Partly unblocked, 2026-08-07.** Two of those four are now settled by the decisions below: the
merge-vs-rebase question is answered (both, chosen by the user), and a persisted default-strategy
preference is being added. What remains specific to this item is the dynamic contribution-target
label and the remote-present enablement rule. Re-evaluate whether it is still worth deferring once
the strategy work lands.

---

## Amended scope, 2026-08-07 — rebase enters the MVP

Jose's decision, recorded because this plan says of the Phase 7f deferral: *"Reverse this only
deliberately — it is the one judgement call in this plan."* **This is that deliberate reversal**, and
it is narrower than the deferral it touches: it adds rebase as a branch operation, not the
update-from-default-branch convenience.

### 1. Three strategies, and squash is nearly free

| Strategy | Backend | Gap |
|---|---|---|
| Merge commit | complete and wired | none — shipped |
| Squash and merge | **complete**: `MergeOptions { squash }`, and `merge()` then runs `git commit --no-edit` under the correct second hook set (`prepare-commit-msg`, `commit-msg`, `post-commit`) | `branch-store.ts` calls `mergeBranch(path, target)` with no options |
| Rebase | `rebase_branch`, `continue_rebase`, `abort_rebase`, `get_rebase_snapshot`, `operation_state.rs` all exist; `rebaseBranch` has a TS wrapper | no store, no UI. `src/lib/rebase.ts` is in the unreachable set measured in `CODE_ORGANIZATION_PLAN.md` |

### 2. Rebase gets its own dialog

**Because rebase inverts the direction.** Merge and squash ask "bring what in?" — the picked branch
is the *source*. Rebase asks "put mine on top of what?" — the picked branch is the *base*. The fixed
side is the current branch in all three, since git cannot rebase a branch you are not on, so only the
picked branch's role changes.

desktop-plus reaches the same conclusion structurally: its strategy dropdown's `onOperationChange`
dispatches a *different operation* and replaces the dialog rather than toggling a flag.

The alternative — one dialog that re-labels itself — was rejected: a single control silently changing
what the list beneath it means is the failure mode Atlassian still has an open issue about for
SourceTree's "Rebase current changes onto \<branch\>"
([SRCTREE-1578](https://jira.atlassian.com/browse/SRCTREE-1578)), where users read the direction
backwards. Two dialogs, each saying one thing, avoids relying on the user inferring direction.

**So: the merge dialog covers merge and squash. Rebase is a separate dialog.**

### 3. The default strategy is a user preference

Merge-commit versus squash-and-merge is a team convention, not a per-invocation choice, so it belongs
in Preferences rather than being re-decided every time. Needs a new persisted preference plus a
Preferences row. This is the same preference Phase 7f was blocked on.

### 4. Boundaries — what this does *not* include

- **Interactive rebase** (reorder, reword, edit, drag-to-squash) is a different feature, even though
  `git-ops` already has `squash.rs` and `reorder.rs`. SourceTree exposes it from a *commit*, not a
  branch. Out of scope; say so explicitly so "rebase in MVP" does not quietly expand.
- **Rebase conflict recovery is not optional.** `conflict-store.ts` tracks only `mergeInProgress`
  from `status.mergeHeadFound`; a rebase conflict writes `.git/rebase-merge/` and would be invisible
  to it, stranding the user mid-rebase with no in-app way out. That is the same gap Slice 4 exists to
  close for merge, so the two belong together.
- **Force-push is already covered** at the backend — `push.rs` and `remote-ipc.ts` implement
  `--force-with-lease` and deliberately never bare `--force`. Only the UI affordance is missing, and
  a rebased branch that was already pushed needs it.

---

## Definition of done, per slice

Every slice closes with all of the following. Not "seven gates" — the current set is whatever
`.github/workflows/ci.yml` runs:

- `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm format:check`, `pnpm lint`
- `pnpm check:bundle-boundary`, `pnpm qualify:phase8a`
- `pnpm test:e2e` (Linux container — the automated product proof)
- `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --check`, the per-crate isolation checks and the Windows `git-ops` portability guard

Plus, per slice — **correction, mid-plan**: `17df5bf` deleted `menu-bar.tsx`/`menu-bar.test.tsx`
and the six menu-driven E2E specs these bullets and the "Tests" section above were written
against, moving Linux onto the same unautomatable native menu as macOS. The bullets below reflect
what actually landed, not the original per-slice "Tests" prose:

- **Accelerators** — **already registered** in `src-tauri/src/platform/keybindings.rs` in the Linux
  forms (rename-branch:47, delete-branch:48, discard-all-changes:49, merge-branch:56), so no
  registration work. The actual gap is **dispatch**: routing each through the enablement map +
  executor (the Linux accelerator path). Verify each fires on the live build.
- **`node scripts/measure-store-surface.mjs`** — AGENTS.md requires it when closing a slice, and these
  slices convert previously-unconsumed commands into consumed ones, which is exactly what it measures.
- **`repository-menu.test.ts`** capability-parity coverage across `macos`/`windows`/`linux` — the
  automated evidence for these six items now that there is no in-window bar or `menu-bar.test.tsx`
  to extend.
- **Both `qa/phase-8b/macos-checklist.md` §7 and `qa/phase-8b/linux-wayland-checklist.md`'s
  equivalent section** gain a native-dispatch line per new menu item — Linux needs this now too.
- **Menu baseline updated**: promote the item in `menu-mvp-alignment-checklist.md` (membership rule
  (b)) and remove it from the "Removed" table.
- Wire snapshot: only if a shape crosses IPC. None of the six items introduces a new IPC shape — they
  all reuse existing command payloads (`discardChanges` already takes `files[]`, merge/rename/delete
  wrappers exist) — so `UPDATE_WIRE_SNAPSHOT` is **expected to be unnecessary**. Still run
  `cargo test -p git-ops --test wire_contract` to confirm, per the not-assumed rule above.

## Read before implementing

`MIGRATION_PLAN.md` Phase 7c (history/branches/conflict recovery, where these operations belong) and
Phase 7f (the post-MVP boundary), plus `MIGRATION_MAP.md` §8 for any recorded deviation on branch
operations. This plan was written from the code, not from those sections.

## Risks

- **Destructive operations with no undo.** Delete-branch with unmerged commits, and discard-all on
  tracked files, both destroy work permanently. Guards and copy are the deliverable here, not an
  afterthought — treat a missing guard as a failing slice.
- **macOS parity is structural but unproven.** The parity test guarantees the capability is enabled;
  only the human checklist proves the native menu dispatches. Do not report an item as done on macOS
  before that pass.
- **Scope creep through the remote.** Remote-branch deletion, remote-branch merging and
  update-from-default all sit one small step past the MVP line. Each is explicitly in or out above;
  moving one in is a decision to record, not a convenience.
