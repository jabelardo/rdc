# History operations — reset (hard / mixed / soft) and revert

**Status**: planned, not started. The backend for every mode and for revert is complete and
test-pinned in `git-ops` (Phase 3); the gap is one layer thick — store methods, the History
context menu, confirmation dialogs, wiring. Picked up from `MIGRATION_PLAN.md`'s "advanced
history/conflict operations remain Phase 7f"; this plan makes that unnamed backlog concrete, the
way `BRANCH_OPERATIONS_PLAN.md` did for the menu gap.
**Blocks**: nothing in the MVP — see the scope decision below.
**Lead platform**: Linux (primary target, `tauri-driver` proof); macOS shares the same surface and
menus by construction, as with branch operations.

---

## What exists today

The git-ops, Tauri-command and TypeScript-IPC layers are **done** (Phase 3):

| Operation | `git-ops` | IPC wrapper | Modes |
|---|---|---|---|
| `reset` to a ref | `crates/git-ops/src/reset.rs` | `git-ipc.ts::reset(path, mode, ref)` | `GitResetMode` — `Hard`=0, `Soft`=1, `Mixed`=2 |
| `reset` of paths | `reset.rs::reset_paths` | `git-ipc.ts::resetPaths` | mixed, against `HEAD` |
| unstage-all | `rm.rs` (`rm --cached`, *not* a reset) | `git-ipc.ts::unstageAllFiles` | — |
| revert a commit | `crates/git-ops/src/revert.rs` | `misc-ipc.ts::revertCommit(path, commit, parentCount)` | `-m 1` applied only for merge commits |

`GitResetMode` lives in `src/models/git-reset-mode.ts` (numeric; **`Hard` is `0`** — documented so
nothing ever defaults a missing mode to the destructive one).

**The only frontend consumer today** is `discard-changes.ts`, which uses
`resetPaths(GitResetMode.Mixed, "HEAD", paths)` as the index-restore half of whole-file discard.
**No code calls `GitResetMode.Hard` or `.Soft` against a ref**, and **nothing calls
`revertCommit`**. The History commit list (`history-workspace.tsx`) has no context menu at all, and
`default-menu.ts` has no revert/reset item (its only "reset" is *Reset Zoom*).

So the whole thing is one vertical slice: a History commit context menu (the surface), store
methods, controllers, confirmation dialogs, and wiring. `BRANCH_OPERATIONS_PLAN.md` treats the
same layer thickness as a few small slices; so does this plan.

## Scope decision

The MVP exit criteria do not name reset or revert ("advanced history operations remain Phase 7f"),
so this plan is **post-MVP / Phase 7f** work, sequenced like the branch-operations slices. It is
deliberate about how much each operation rewrites history:

| Operation | What it does to history | Safe on pushed commits? | Confirmation |
|---|---|---|---|
| **Revert commit** | creates a **new** commit undoing another (`git revert`) | **yes** — never rewrites | none (desktop-plus shows only progress) |
| **Cherry-pick commit** | creates a **new** commit copying another's diff forward | **yes** — never rewrites | none |
| **Checkout commit** | moves the working tree to an old commit (detached) | **yes** — no rewrite | none |
| **Undo commit** | soft-resets the last commit (`reset --soft HEAD^`): HEAD moves, changes stay staged | no | none (nothing is lost) |
| **Reset to commit** | **mixed** reset: HEAD + index move, working tree kept | no | pushed-commit + dirty-tree warnings |
| **Hard reset** | `reset --hard`: HEAD + index + working tree, discarding work | no | strongest: pushed + dirty + nondestructive copy |

The resets span a severity gradient — soft/unwind, mixed/settle, hard/destroy — and the
confirmation must scale with it. Revert and cherry-pick sit beside them because they never rewrite
history (they add commits), which is why the nondestructive pair exists alongside the resets rather
than being modes of them.

**Out of scope / boundaries** (say so explicitly so this cannot drift):
- **Amend commit** is a separate operation (desktop-plus keeps it distinct from reset); it owns its
  own "changes to last commit" flow and is backend-ready (`create_commit`'s `amend` option, with
  the `post-rewrite` hook handled) — scheduled below, not in this reset/revert surface.
- **Interactive rebase — squash and reorder** are backend-ready (`squash.rs` / `reorder.rs`, the
  `multi-commit-operation` model ported) but are a bigger feature than this menu; they get their
  own plan tied to interactive rebase, not a row here.
- **A conflicting revert** writes `CHERRY_PICK_HEAD` (revert is built on the cherry-pick
  sequencer). The same is true of a conflicting **cherry-pick**. `isCherryPickHeadFound` exists in
  `misc-ipc`, but rdc's conflict surface tracks only `mergeInProgress` — so both need a boundary
  decision, exactly like the rebase one in `BRANCH_OPERATIONS_PLAN.md` (§ "Amended scope"). This
  plan flags it; it does not silently claim recovery.
- **Per-path reset** is covered by `discard-changes.ts` and is not re-exposed here.
- **Interactive / choose-which-commits** reset is not in scope.

---

## Shared: the History commit context menu (Slice 1 — foundation)

The surface both reset and revert need. `history-workspace.tsx`'s commit rows already have
selection and arrow navigation; they gain a right-click context menu mirroring desktop-plus's
`commit-list.tsx` items, plus the shared enablement that gates every operation below.

Menu items (order from desktop-plus, corrected to rdc's honest-product rule):

```
Undo commit…            ← Soft, HEAD only
Reset to commit…        ← Mixed, non-HEAD only
─────────────────────
Revert commit…          ← all commits (incl. merges, via -m 1)
Cherry-pick commit…     ← remote/uncommitted commits
─────────────────────
Checkout commit…        ← non-HEAD only
```

**Enablement matrix** (shared, on each commit row):
- Repository selected **and** current branch exists (unborn/detached → disabled).
- **No operation in progress** — a reset or revert while a merge/rebase/cherry-pick is active would
  fight the in-flight state; disable `branchState.operation === null`.
- **Undo** only when the commit is `HEAD`.
- **Reset** only when the commit is not `HEAD`.
- **Revert** always for a commit with a selected diff, and covers merge commits via `parentCount`.
- **Cherry-pick** for the commit you want on the current branch (it is the encounter of reverts
  and resets: neither, it copies a commit's diff forward).
- **Checkout commit** only when the commit is not `HEAD`.

**Tests** — the context menu renders with the right items per commit, each item's enabled state
follows the matrix, and selecting one calls the routed controller action (not the operation).

---

## Slice 2 — Revert commit

The safest operation (no history rewrite), so it is the right first vertical slice to prove the
surface end to end.

**Store** (`branch-store.ts`, which owns the current-branch/HEAD facts and the `finishOperation`
reload) — `revertCommit(sha, parentCount)` mirroring `initiateMerge`'s shape: guard
`workingTreeDirty` (git refuses to revert over uncommitted changes), set an `operation: "reverting"`
state, call `misc-ipc.revertCommit(path, sha, parentCount)`, `finishOperation`, then
`refreshAfterBranchChange` so the new revert commit appears in History. `parentCount` comes from the
selected commit's `parentSHAs` (0 → no `-m`; ≥2 → `-m 1`).

**Controller** — `requestRevert(commit)` from the context-menu item: no confirmation dialog
(desktop-plus doesn't stop you; it shows toolbar progress), call the store, on success select the
new commit. On **conflict** (`isCherryPickHeadFound` after the attempt), do **not** close the dialog
or pretend the conflict surface handles it — show the revert-progress/conflict boundary copy, and
leave recovery (continue/abort) as a stated gap tied to the rebase-conflict work.

**Tests** — store: calls `revertCommit` with the right `parentCount`, refuses a dirty tree, maps a
failure; the `-m 1` only-for-merge rule is already pinned at `git-ops`; controller: wires the menu
item, refuses while an operation runs.

## Slice 3 — Cherry-pick commit

The sibling of revert that fetches a commit *forward* instead of undoing it — useful when the
commits you want live on a branch you do not want to merge wholesale. Backend is complete
(`cherry_pick` + `continue_cherry_pick` + `get_cherry_pick_snapshot` + `abort_cherry_pick` in
`stash-ipc.ts`, with the `multi-commit-operation` model already ported); only the UI and a store
method are missing.

**Store** — `cherryPick(sha)` on `branch-store.ts`: guard `workingTreeDirty` (git refuses to
cherry-pick over uncommitted changes), set an `operation: "cherry-picking"` state, call
`cherryPick(path, sha, progress)`, `finishOperation`, `refreshAfterBranchChange`. On conflict
(`isCherryPickHeadFound` after the attempt) share the same honest boundary as revert — do not hand
off to the merge-conflict surface that cannot see a cherry-pick state.

**Controller / UI** — "Cherry-pick commit…" from the shared context menu; progress through the same
Channel path revert uses; no confirmation (the operation is a new commit, nothing is lost).

**Tests** — store: dirty-tree refusal, correct argument, result mapping; controller: menu wiring;
and the shared enablement matrix's no-in-flight-operation rule.

> **Checkout commit** (backend `checkout_commit` + `checkout_paths` done, no UI yet) is folded into
> this surface: a "Checkout commit…" item from the same menu, disabled on `HEAD`, that calls
> `checkoutCommit` and then refresh. It is a one-liner layer where cherry-pick establishes the
> store pattern, so it rides the same slice rather than earning one of its own.

---

## Slice 4 — Undo commit (soft)

Non-destructive and self-explanatory, so it needs **no confirmation** — the second-cheapest slice
and a good follow-on.

**Store** — `undoCommit(sha)`: guard that `sha === current HEAD` (the menu already gates it, but the
store re-checks), `reset(path, GitResetMode.Soft, "HEAD^")`, `finishOperation`, switch the view to
Changes so the now-staged changes are visible (desktop-plus's `_resetToCommit` changes section to
Changes; rdc moves the selected commit to the parent).

Note for the port: desktop-plus sends *both* und-and-reset through `_resetToCommit` with `Mixed`;
this plan **deliberately** uses `Soft` for Undo because undoing a commit must leave the work *staged*
to edit, whereas settling on it is not the point. Record this as a deliberate deviation
(`MIGRATION_MAP.md` §8) if kept.

**Tests** — store: soft reset to `HEAD^`, guard on non-HEAD, no state lost; controller: routes the
"Undo commit…" item only on the HEAD row.

---

## Slice 5 — Reset to commit (mixed)

The desktop-plus default: mixed reset — HEAD and index move, the working tree is kept, so nothing
is destroyed, but a dirty tree becomes confusingly unstaged.

**Store** — `resetToCommit(sha)`: `reset(path, GitResetMode.Mixed, sha)`, `finishOperation`,
`refreshAfterBranchChange`, switch the view to Changes.

**Confirmations** (two stages, replicating desktop-plus's `WarningBeforeReset` and
`WarnResetToPushedCommit`, presented with `ConfirmDialog`):
1. **Dirty working tree** → warn that uncommitted changes will be left as unstaged working
   changes (or, for the hard slice, discarded).
2. **Pushed commit** → warn that this rewrite will diverge from the remote and need a force-push.
   "Pushed" is decided where the data already exists: `remoteStore` + `getBranchAheadBehind`
   against the remote-tracking ref, or a rev-list in the range of the remote tip — this plan does
   not add a new pushed-commit command, it reuses what Phase 7d already loaded.

**Tests** — the two-stage confirmation (clean tree skips the warning; unpushed skips the pushed
warning; both present when both apply), refusal while an operation runs, index restores to `sha`.

---

## Slice 6 — Hard reset to commit (destructive)

`GitResetMode.Hard` discards working-tree changes with no file-content reflog, the one mode that
is dangerous enough to gate as its own, latest slice.

**Store** — `resetToCommit(sha, { hard: true })` → `reset(path, GitResetMode.Hard, sha)`.

**Guard matrix (strongest):**
- **Refuse** while any operation runs and while the working tree is dirty *unless* the user passed
  the explicit irreversible warning.
- **Refuse or strongly gate** when the target is a pushed commit (can't be undone on the remote).
- Confirm copy must state the file changes that will be lost, following the destructive-action
  conventions already used by delete-branch and permanent-discard (`deleteUnmerged` warning block,
  `--warning-*` tokens, Convention "an action that cannot be undone takes the warning tokens").
- Because a hard reset discards tracked changes that the OS trash can't recover (they're not files
  on disk in the normal sense), the plan must decide — and record in `MIGRATION_MAP.md` §8 — whether
  to snapshot changed paths into the trash first (recoverable) or to warn and proceed (matching git
  semantics). Default proposal: **warn and proceed**, because a hard reset's whole point is to
  discard dirt, and desktop-plus's `WarningBeforeReset` only warns.

---

## Backend-complete and still unplanned (the rest of the inventory)

The backend has more finished operations than this plan lays out. Nothing below is a *gap in
implementation* — every command exists, is tested at `git-ops`, and has a TypeScript wrapper — they
are gaps in *scheduling*. Grouped by the surface that will consume them, so none is silently
forgotten:

| Backend (all done) | Frontend today | Where it should land |
|---|---|---|
| `cherry_pick`, `continue_cherry_pick`, `get_cherry_pick_snapshot`, `abort_cherry_pick` | only the ported `multi-commit-operation` model | **this plan, Slice 3** |
| `checkout_commit`, `checkout_paths` | none | **this plan, Slice 3** (folds into the context menu) |
| `reset`, `reset_paths` (hard/soft/mixed), `revert_commit` | `resetPaths(Mixed, HEAD)` in `discard-changes.ts` only | **this plan, slices 2/4/5/6** |
| `create_commit`'s `amend` option (with `post-rewrite` hook) | none | **Amend — its own HEAD surface** (compare against the last commit), not this menu |
| `squash`, `reorder` + `multi-commit-operation` machinery | none (merge dialog's *squash strategy* is a different, merge-based path) | **interactive rebase plan** — desktop-plus's "Reorder commit" / "Squash commits" |
| `get_commit_range_changed_files`, `get_commit_range_diff`, `get_branch_merge_base_*` | none | **Compare** (desktop-plus's branch/history range tab) — a workspace surface, not a context-menu action |
| `get_branches_differing_from_upstream`, `fast_forward_branches` | none | **update-from-default-branch** convenience (`BRANCH_OPERATIONS_PLAN.md` § Deferred) |
| `create_tag`, `delete_tag`, `get_all_tags` | none | **Tags** — Phase 7f section, plus a "Create tag…" history-menu item |
| `create_stash_entry`, `drop/pop/rename/move`, `get_last_*`, `get_stashed_files` | stash entry model ported, no store | **Stashes** — Phase 7f sidebar section |
| six `*_worktree*` commands | none | **Worktrees** — Phase 7f sidebar section |
| `install_global_lfs_filters`, `install_lfs_hooks`, `is_using_lfs` | none | **LFS** — Phase 7f, alongside hooks preferences |

Several are *surfaces* (Tags, Stashes, Worktrees, Compare) rather than history-menu actions, which
is why they are listed with the phase that builds their panel — see `MIGRATION_PLAN.md` Phase 7f
and the sidebar-section registry in `src/lib/ui/sidebar-sections.ts`. This table exists so the
question "is the backend ahead of the UI?" has a one-look answer: **yes, by every row above.**

---

## Definition of done, per slice

Every slice closes with the full gate set `.github/workflows/ci.yml` runs (`pnpm test`, `tsc`,
`format:check`, `lint`, `check:bundle-boundary`, `qualify:phase8a`, `cargo test --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, the per-crate
isolation checks and the Windows `git-ops` portability guard), plus targeted unit/React coverage per
slice and a QA checklist entry in `qa/phase-8b/` for the History context menu and each confirmation.

The slice adds an item to `MIGRATION_MAP.md` §8 only when it records a deliberate deviation (Undo
uses Soft not Mixed; hard reset warn-and-proceed; conflicting-revert boundary).

**Nothing upstream is being invented here**: every backend call already exists and is pinned; every
confirmation and guard rule is desktop-plus's, translated to rdc's existing `ConfirmDialog` /
`NoticeDialog` / `DialogMessage` layer. The plan is deliberately decisions-first (which mode maps to
which action, and how destructive the confirmation must be) so the implementation does not re-litigate
severity while it works.
