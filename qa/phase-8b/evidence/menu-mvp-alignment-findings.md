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
and check out). Everything else in the legacy upstream Branch menu is absent because the underlying
operations are not implemented.

**Required before MVP release** (upstream item → what is missing):

| Upstream item | Missing implementation |
|---|---|
| `rename-branch` (&Rename…) | Rename the current/local branch (branch-store + git rename, E2E) |
| `delete-branch` (&Delete…) | Delete a branch (safety: current-branch/unborn/detached guards, E2E) |
| `discard-all-changes` (Discard all changes…) | Whole-working-tree discard (recoverable trash + permanent with confirmation). Only file/line discard exists today |
| `permanently-discard-all-changes` (Permanently discard all changes…) | Same, permanent path with confirmation |
| `update-branch-with-contribution-target-branch` (&Update from \<default\>) | Bring the current branch up to date with its default branch (fetch + merge/rebase onto contribution target) |
| `merge-branch` (&Merge into current branch…) — *initiation* | Merge *initiation*; conflict *recovery* already exists and stays MVP |

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
