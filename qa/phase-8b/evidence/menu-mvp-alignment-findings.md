# Application-menu MVP alignment — findings for development

**Phase**: 8b — Application-menu MVP alignment (Linux)
**Baseline**: `qa/phase-8b/menu-mvp-alignment-checklist.md` (defined at commit `68a2269`)
**Alignment commit**: `bb652ce` (in-window menu bar aligned to the baseline)
**Date**: 2026-08-02
**Status**: QA result to hand to development — contains one MVP blocker.

## F-MENU-001 — MVP blocker: the Branch menu cannot ship as a single-item menu

**Classification**: MVP blocker (scope, not implementation). The menu alignment itself is correct:
an item must not appear unless its function exists, so `menu-bar.tsx` shows only what is real. The
defect is in the **MVP scope**: an MVP of a git client without fundamental branch management is not
releasable.

**What a user sees today**: Branch menu contains exactly one item, *New branch…* (create from HEAD
and check out).

**Correction (2026-08-03).** This finding originally said the other items are absent "because the
underlying operations are not implemented". That is wrong, and it mis-scopes the work. Verified by
reading each layer: **the git operations, their Tauri commands, and their TypeScript IPC wrappers all
exist and are tested.** What is missing is only the top layer — a store method, a UI affordance and
the menu wiring. This is wiring work over a finished backend, not backend work.

| Upstream item | `git-ops` (Rust) | Tauri command | TS IPC wrapper | Store method | UI + menu |
|---|---|---|---|---|---|
| `rename-branch` | `rename_branch` | `rename_branch` | `branch-ipc.ts` | **missing** | **missing** |
| `delete-branch` | `delete_local_branch`, `delete_remote_branch` | `delete_local_branch`, `delete_ref` | `branch-ipc.ts`, `remote-ipc.ts` | **missing** | **missing** |
| `discard-all-changes` | trash + `clean`/`checkout` | `move_item_to_trash`, `clean_untracked_files` | `discardChanges(path, files[], …)` | **partial** — `discardFile` passes `[file]`; all-files is the same call with the full list | **missing** |
| `permanently-discard-all-changes` | same | same | same, `{ permanentlyDelete: true }` | **partial** — flag already plumbed | **missing** |
| `update-branch-with-contribution-target-branch` | `rebase.rs` (10 fns), fetch/merge | `rebase_branch`, `fetch`, `merge_branch` | `git-ipc.ts`, `remote-ipc.ts` | **missing** | **missing** |
| `merge-branch` — *initiation* | `merge.rs` | `merge_branch`, `determine_mergeability`, `abort_merge` | `git-ipc.ts`, `misc-ipc.ts` | **missing** | **missing** |

`branch-store.ts` currently exposes only `load`, `createAndCheckout`, `checkout` and `clear`;
`working-tree-store.ts` only `discardFile` and `discardSelectedLines`. Those two files are where the
gap lives.

The MVP-blocker classification stands — a git client without branch management is not releasable —
but the estimate should reflect that Phase 2/3 already delivered the hard part. The remaining work is
store methods with guards (current-branch/unborn/detached for delete, confirmation policy for
discard-all), the UI affordances, and fixture-scenario E2E journeys.

**Explicitly still post-MVP** (not part of this blocker): `stash-all-changes`, `compare-to-branch`,
`squash-and-merge-branch`, `rebase-branch`, GitHub branch/PR items.

**Expected disposition**: development implements the listed operations in their owning slices
(branch-store, working-tree-store, remote/merge paths), each with fixture-scenario E2E journeys
(`branch`, `wholeFileDiscard`, `remoteFetchPull` are the existing building blocks). As each lands,
the baseline promotes the item automatically (membership rule (b) — implemented means MVP) and the
menu entry is wired. Do not pad the Branch menu with disabled placeholders in the meantime.

**Owner**: development (MVP re-scoping of Phase 7c/7f for these six items).

## F-MENU-002 — resolved in the alignment commit (for the record)

The following gaps found by code reading at the start of the cycle are implemented in `bb652ce`
and now only need live-Wayland verification: Edit menu (roles + Ctrl+Z/Y/X/C/V hints), File →
Open new window, View Repository list/Branches list/Go to Summary/Expand-Contract, Repository
Remove… with confirmation, dynamic shell/editor labels, busy-state enablement for
Fetch/Pull/Push, Branch → New branch… routing, Help Report issue…/View RDC on GitHub, accelerator
hints, full keyboard pattern (arrows, Home/End, Escape with focus return, Alt mnemonics, Tab),
dev-only Reload + wired DevTools, and `menu-bar.test.tsx` regression coverage (22 tests).

The keybinding-tree accelerators for the wiring-gap items were additionally dead on Linux
(displayed but not dispatched): `d0cb09f` wires the shared executor and enablement map,
platform-gated so macOS keeps its honest-disable state (regression test pins it), and moves the
sidebar-width and branch-creation state into the controller so the visible menu bar and the
keybinding path share one implementation. Ctrl+B, Ctrl+G, Ctrl+9/8 and Ctrl+Shift+N now work.

## F-MENU-003 — resolved: macOS and Linux exposed different capability sets

**Found**: 2026-08-03, by dumping `buildRepositoryMenu` for `macos` and `linux` with a selected
repository and comparing the *enabled* sets rather than the item counts.

Five implemented actions were enabled on Linux and disabled on macOS:

| Item ID | macOS before | Linux |
|---|---|---|
| `create-branch` | disabled | enabled |
| `show-branches-list` | disabled | enabled |
| `go-to-commit-message` | disabled | enabled |
| `increase-active-resizable-width` | disabled | enabled |
| `decrease-active-resizable-width` | disabled | enabled |

The consequence was worse than the list suggests: since the other Branch items are unimplemented and
therefore disabled, **the macOS Branch menu contained no usable item whatsoever**, while Linux
offered New branch…. F-MENU-001 read as a Linux-scope finding; on macOS the same menu was not merely
thin, it was inert.

**Cause**, from the code comment that gated it: *"macOS keeps the keybinding-tree items for these
actions honestly disabled (this host cannot run macOS)"*, pinned by a test named *"keeps the
wiring-gap actions disabled on macOS (untested platform safety)"*. So the gate was about
verifiability, not capability — a defensible instinct that produced an indefensible surface, because
"we cannot automate this platform" is permanent for WKWebView and would have kept the items disabled
forever.

**Resolution**: the platform gate is removed; the five are enabled on every platform. The baseline
gained a **capability-parity rule** (scope rule 4) making this class of divergence a defect by
definition, and `repository-menu.test.ts` now asserts the implemented-capability set is identical
across `macos`, `windows` and `linux` — replacing the assertion that pinned the divergence in place.
The existing per-platform executor contract confirms macOS has an executor for each.

**Residual risk, honestly stated**: automation proves the wiring, not native WKWebView dispatch. The
macOS checklist §7 now carries an explicit item to exercise all five from the native menu. Until that
is recorded, macOS parity is *implemented and unit-verified, not natively verified*.

## Exit classification for this cycle

- [x] **blocker** — F-MENU-001 (Branch menu scope), with the exact items and expected disposition above.
- [ ] aligned with the MVP (pending live-Wayland verification of the implemented surface).
