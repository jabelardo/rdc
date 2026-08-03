# Application-menu MVP alignment checklist

Run this on every supported MVP platform after the foundation and visual checks, but before the
functional journeys. The automated recursive menu contract proves that every visible enabled leaf
has an executor; this human gate answers the different question: **is the menu surface itself the
right surface for the MVP?**

Use `src/lib/menu/default-menu.ts` and `src/lib/menu/repository-menu.ts` as the implemented tree,
`REMAINING.md` plus the Phase 7f section of `MIGRATION_PLAN.md` as the named post-MVP boundary, and
the inventory tables below as the concrete per-element expectation.

## Scope rules — how the baseline is defined

The menu baseline is **not invented from the MVP wish-list; it is the legacy upstream app's menu
minus everything that is not ready, plus everything rdc has already implemented.**

1. **Shape authority.** The Linux (and Windows) surface is defined by the legacy upstream app's
   non-Darwin template, `../desktop-plus/app/src/main-process/menu/build-default-menu.ts`
   (`__DARWIN__` false branch): top-level menu set, item order, labels with access keys, separators
   and accelerators. `src/lib/menu/default-menu.ts` is rdc's faithful port of that template and is
   the reference tree. Do not use the macOS template shape for Linux expectations.
2. **Membership rule.** An item is in the Linux MVP baseline iff it is upstream-present **and**
   either
   - (a) rdc has implemented and menu-dispatched its action (or, for a native OS role, the role
     functions in the focused window), **or**
   - (b) rdc has implemented the product function even if the application-menu entry is not yet
     wired (an implemented capability is MVP by definition and must be reachable from the menu this
     cycle), **or**
   - (c) it is a native OS role (undo, redo, cut, copy, paste, quit) that works in the webview.
   Every other upstream-present item is **removed from the Linux MVP baseline** and is listed in the
   "Removed" table with its reason and named owner. An item removed here must not appear enabled or
   execute a no-op.
3. **Identity rule.** rdc labels and destinations apply (RDC identity, rdc-owned URLs). Any
   departure from upstream copy is an accepted deviation recorded below, not an unstated change.
4. **Capability-parity rule.** *Shape* differs per platform — macOS uses the Darwin template with an
   app menu and a Window menu, Linux/Windows use the non-Darwin template with access keys. The set
   of **implemented capabilities reachable from the menu must not.** If an action is enabled on one
   MVP platform it must be enabled on the other, in the equivalent state; if it is absent on one it
   must be absent or honestly disabled on the other. Platform-gating an implemented action because
   it is *harder to verify* on one platform is not permitted — that is what produced a macOS Branch
   menu with no usable item while Linux offered `create-branch`. Where verification genuinely cannot
   be automated (native WKWebView dispatch has no `tauri-driver` backend), the automated proof is
   the per-platform executor contract in `repository-menu.test.ts` and the native proof is an
   explicit item in `macos-checklist.md` — not a disabled menu entry.

Per-item classification used below:

- **MVP** — must be present and enabled in the correct state. If its enablement depends on
  repository/remote/preferences state, the `buildRepositoryMenu` enablement map must include it.
- **MVP — wiring gap** — the product function exists but the application-menu entry is not wired
  yet. It is still MVP: wire it this cycle or record the decision with an owner.
- **Native OS role** — standard operating-system menu role. Must be present and function as the OS
  defines.
- **Dev-only** — visible only in debug/development builds, gated by `enableTestMenuItems()` or
  `__RELEASE_CHANNEL__ === 'development'`.
- **Removed for MVP** — upstream-present but not ready; absent from the Linux MVP surface (see the
  "Removed" table).

## Linux MVP baseline inventory

Accelerators are the Linux forms from `src-tauri/src/platform/keybindings.rs` (CmdOrCtrl → Ctrl).
The in-window menu bar and the keybinding tree must agree on this inventory, these labels and these
accelerators.

### File menu

| Item ID | Linux label (upstream) | Accelerator | Classification | Notes |
|---|---|---|---|---|
| `new-repository` | New &repository… | Ctrl+N | **MVP** | Phase 7a — always enabled |
| `new-window` | Open new window | Ctrl+Alt+N | **MVP** | Phase 7a — enabled when a repo is selected |
| `add-local-repository` | Add &local repository… | Ctrl+O | **MVP** | Phase 7a — always enabled |
| `clone-repository` | Clo&ne repository… | Ctrl+Shift+O | **MVP** | Phase 7d — always enabled |
| `preferences` | &Options… | Ctrl+, | **MVP** | Phase 7e — enabled when preferences store exists |
| `quit` | E&xit | Ctrl+Q | **Native OS role** | |

### Edit menu

| Item ID | Linux label (upstream) | Accelerator | Classification | Notes |
|---|---|---|---|---|
| *(undo, redo, cut, copy, paste)* | &Undo, &Redo, Cu&t, &Copy, &Paste | Ctrl+Z, Ctrl+Y, Ctrl+X, Ctrl+C, Ctrl+V | **Native OS role** | Webview-native edit commands; hints shown in the menu |
| `select-all` | Select &all | Ctrl+A | **MVP** | `select-all` dispatched through the keybinding tree |

### View menu

| Item ID | Linux label (upstream) | Accelerator | Classification | Notes |
|---|---|---|---|---|
| `show-changes` | &Changes | Ctrl+1 | **MVP** | Phase 7b — enabled when a repo is selected |
| `show-history` | &History | Ctrl+2 | **MVP** | Phase 7c — enabled when a repo is selected |
| `show-repository-list` | Repository &list | Ctrl+T | **MVP** | Phase 7a — enabled when repos exist; focuses the active repository row (implemented) |
| `show-branches-list` | &Branches list | Ctrl+B | **MVP — wiring gap** | The branches sidebar is implemented; the menu entry must focus/reveal it |
| `go-to-commit-message` | Go to &Summary | Ctrl+G | **MVP — wiring gap** | Commit summary field is implemented; the menu entry must focus it |
| `increase-active-resizable-width` | Expand active resizable | Ctrl+9 | **MVP — wiring gap** | Sidebar drag-resize is implemented; the menu entry must step the stored width |
| `decrease-active-resizable-width` | Contract active resizable | Ctrl+8 | **MVP — wiring gap** | Same |
| `reset-zoom` / `zoom-in` / `zoom-out` | Reset zoom / Zoom in / Zoom out | Ctrl+0 / Ctrl+= / Ctrl+- | **MVP** | |
| `reload-window` | &Reload | Ctrl+Alt+R | **Dev-only** | `__RELEASE_CHANNEL__ === 'development'` |
| `show-devtools` | &Toggle developer tools | Ctrl+Shift+I | **Dev-only** | Wired through `toggle_devtools` (debug builds); hidden in production |

### Repository menu

| Item ID | Linux label (upstream) | Accelerator | Classification | Notes |
|---|---|---|---|---|
| `push` | P&ush | Ctrl+P | **MVP** | Phase 7d — remote and branch exist, not loading |
| `pull` | Pu&ll | Ctrl+Shift+P | **MVP** | Phase 7d — same as push plus upstream tracking branch |
| `fetch` | &Fetch | Ctrl+Shift+T | **MVP** | Phase 7d — remote exists, not loading |
| `remove-repository` | &Remove… | Ctrl+Backspace | **MVP** | Phase 7a — enabled when a repo is selected; confirmation follows the preference |
| `open-in-shell` | O&pen in &lt;shell&gt; | Ctrl+` | **MVP** | Phase 7e — enabled when shell is configured; label carries the shell name |
| `open-working-directory` | Show in your File Manager | Ctrl+Shift+F | **MVP** | Phase 7a — enabled when a repo is selected |
| `open-external-editor` | &Open in &lt;editor&gt; | Ctrl+Shift+A | **MVP** | Phase 7e — enabled when editor is configured; label carries the editor name |

### Branch menu

| Item ID | Linux label (upstream) | Accelerator | Classification | Notes |
|---|---|---|---|---|
| `create-branch` | New &branch… | Ctrl+Shift+N | **MVP** | Phase 7c — create from HEAD and checkout; enabled on every MVP platform (macOS label: New Branch…) |
| `discard-all-changes` | Discard all changes… | Ctrl+Shift+Backspace | **MVP** | Enabled when the working tree is dirty and no merge is in progress; whole-tree discard reuses `discardChanges(files[])` |
| `permanently-discard-all-changes` | Permanently discard all changes… | — | **MVP** | Same enablement as discard-all; skips the OS trash |

**QA blocker for MVP release, on both platforms:** the Branch menu is effectively single-item
because rename/delete/discard-all/update-from/merge-initiation are not implemented, but fundamental
branch management is required for an MVP. See `qa/phase-8b/evidence/menu-mvp-alignment-findings.md`
F-MENU-001 for the exact six items and their owning slices. The blocker is **scope, not platform** —
it was first recorded during the Linux cycle, but macOS is missing exactly the same operations, so
implementing them clears it for both and neither platform ships until it is cleared.

**Progress (BRANCH_OPERATIONS_PLAN.md):** Slice 1 (discard-all-changes and
permanently-discard-all-changes) landed — promoted here under membership rule (b). The remaining
blocker items are rename/delete (Slice 2), merge initiation (Slice 3), and **update-from-default,
now deferred to Phase 7f** — see the plan's scope decision.

The menu must not be padded with dead items in the meantime: development implements the operations
and the baseline promotes them automatically under membership rule (b).

### Help menu

| Item ID | Linux label (upstream) | Accelerator | Classification | Notes |
|---|---|---|---|---|
| `report-issue` | Report issue… | — | **MVP** | Opens `https://github.com/jabelardo/rdc/issues/new` |
| `view-rdc-on-github` | View RDC on &GitHub | — | **MVP** | Opens `https://github.com/jabelardo/rdc`; accepted deviation — replaces upstream's Show User Guides and Show keyboard shortcuts (rdc-owned destination) |
| `show-logs` | S&how logs in your File Manager | — | **MVP** | Opens the log directory in the file manager |
| `about` | &About RDC | — | **MVP** | Enables the about dialog |

### Test menu (dev-only)

All items under `buildTestMenu()` are **Dev-only** — gated by `enableTestMenuItems()`. They must not
appear in a production build. The `install-windows-cli`/`uninstall-windows-cli` submenu is
additionally Windows-only and not applicable to the MVP.

## Removed from the Linux MVP baseline (upstream-present)

Every item below exists in the legacy upstream Linux menu but is **not ready for the MVP** and must
not appear enabled, mislabeled or as a no-op. Absent is the honest state; if any of these later
becomes implemented, the membership rule (b) promotes it to MVP automatically.

| Item ID | Upstream Linux label | Reason it is not in the MVP | Owner |
|---|---|---|---|
| `repository-preferences` | Repository options… | No per-repository options dialog or handler | post-MVP (7f) |
| `find` | &Find | No find surface or `find-text` handler | post-MVP (7f) |
| `show-compare` | Compare | No compare view | post-MVP (7f) |
| `show-worktrees-list` | Wor&ktrees list | Worktrees post-MVP; upstream flag-gates it too | post-MVP (7f) |
| `toggle-stashed-changes` | Show/Hide stashed changes | No stash support | post-MVP (7f) |
| `toggle-changes-filter` | Toggle Chan&ges Filter | No changes-filter UI or store | post-MVP (7f) |
| `togglefullscreen` | Toggle &full screen | Native role with no Linux toggle wiring yet | gap — needs a `setFullScreen` window wrapper |
| `open-with-external-editor` | Open &with… | No chooser | post-MVP (7f) |
| `view-repository-on-github` | &View on GitHub | No GitHub account/networking | post-MVP (5b/7f) |
| `create-issue-in-repository-on-github` | Create &issue on GitHub | No GitHub account/networking | post-MVP (5b/7f) |
| `create-worktree` | New work&tree… | Worktrees post-MVP; upstream flag-gates it too | post-MVP (7f) |
| `show-repository-settings` | Repository &settings… | Advanced repository settings | post-MVP (7f) |
| `manage-remotes` | Manage remotes… | Advanced remote management | post-MVP (7f) |
| `rename-branch` / `delete-branch` | &Rename… / &Delete… | **MVP-required — blocked** | Fundamental branch lifecycle; see the QA finding | development (MVP blocker) |
| `stash-all-changes` | &Stash all changes… | No stash support | post-MVP (7f) |
| `update-branch-with-contribution-target-branch` | &Update from &lt;branch&gt; | **Deferred to Phase 7f** | A convenience over fetch + merge/rebase, both already MVP; needs a persisted `updateBranchStrategy` preference and a dynamic contribution-target label | post-MVP (7f) — see BRANCH_OPERATIONS_PLAN.md scope decision |
| `compare-to-branch` | &Compare to branch | Compare post-MVP | post-MVP (7f) |
| `merge-branch` / `squash-and-merge-branch` / `rebase-branch` | &Merge into current branch… / Squas&h and merge… / R&ebase current branch… | Merge *initiation* is **MVP-required — blocked** (conflict *recovery* is MVP and lives in the Changes surface); squash/rebase remain post-MVP | development (MVP blocker) |
| `compare-on-github` / `branch-on-github` | Compare on GitHub / View branch on GitHub | No GitHub networking | post-MVP (5b/7f) |
| `preview-pull-request` / `create-pull-request` | Preview pull request / Create &pull request | No GitHub networking | post-MVP (5b/7f) |

## macOS-only inventory

macOS renders the full `default-menu.ts` tree in the native menu bar, so its inventory is the full
upstream macOS template with honest enablement (`withHonestStartupEnablement` plus the
`buildRepositoryMenu` map). The membership rule still applies: implemented items are MVP, the
"Removed" boundary applies on macOS too, and the deviations below are macOS-specific.

**The two platforms therefore present the same capabilities through different shapes, and that is
the only difference permitted.** Note the consequence of macOS rendering the *whole* ported tree
while Linux's in-window bar renders only its baseline: on macOS a "Removed for MVP" item is present
but disabled, whereas on Linux it is absent. Both satisfy the membership rule — an item that is
neither enabled nor executable is honest either way — but it means the platforms are compared by
*enabled set*, never by item count. Per-item enablement is verified by
`repository-menu.test.ts`, which asserts the implemented-capability set is identical across
`macos`, `windows` and `linux`, and separately that every enabled leaf has an executor on each.

### macOS app menu (RDC menu)

| Item ID | Label | Classification | Notes |
|---|---|---|---|
| `about` | About RDC | **MVP** | |
| `preferences` | Settings… | **MVP** | Phase 7e |
| `repository-preferences` | Repository Options… | **Removed for MVP** | No per-repository options dialog (same boundary as Linux) |
| `install-cli` | Install Command Line Tool… | **Accepted deviation** | macOS-only; deferred to Phase 9 CLI engineering |
| `services`, `hide`, `hideOthers`, `unhide` | Standard roles | **Native OS role** | |
| `quit` | Quit | **Native OS role** | |

### Window menu (macOS only)

| Item ID | Label | Classification | Notes |
|---|---|---|---|
| `minimize`, `zoom`, `close`, `front` | Standard roles | **Native OS role** | |

## Accepted deviations

Recorded here rather than in the per-item tables when they span multiple items or platforms:

1. **Install CLI (macOS)** — `install-cli` is deferred to Phase 9 CLI engineering. The item is
   visible but disabled on macOS MVP builds.
2. **Help menu replacements** — upstream's Show User Guides and Show keyboard shortcuts link to
   GitHub Desktop documentation, which is not rdc's. rdc replaces both with a single
   `view-rdc-on-github` entry pointing at the rdc repository. No enabled Help item points at
   Desktop Plus or GitHub Desktop.
3. **Merge conflict recovery** — the *initiation* of a merge from the Branch menu (`merge-branch`)
   is post-MVP; the *recovery* from a merge-conflict state (reached via `pull` or external merge)
   is MVP. The conflict-store and working-tree-store handle resolution and staging.
4. **`togglefullscreen` absent on Linux** — the native role has no Linux toggle wiring yet. Removed
   until a `setFullScreen` window wrapper lands (trivial wiring); re-promote per membership rule
   (b) when done.

## Current Linux implementation gaps to resolve this cycle

The visible Linux surface is the in-window menu bar (`src/lib/ui/app/menu-bar.tsx`); the full tree
is simultaneously installed as the keybinding dispatcher's state. These two surfaces must agree
with the baseline above and with each other. The divergences below were found by code reading at
the start of the cycle and **implemented in the alignment commit**; the remaining work is to verify
each on the live Wayland build and fix anything the code reading missed.

1. ~~File → Open new window missing~~ — implemented: File → “Open new window”, Ctrl+Alt+N,
   enabled with selection. The old “Open in New Window” entry under Repository was removed.
2. ~~The Edit menu is entirely missing~~ — implemented: Undo, Redo, Cut, Copy, Paste, Select All.
   The roles dispatch `document.execCommand` on the focused element; Select All routes through
   `selectAllWindowContents`.
3. ~~View menu lacks Repository &list, &Branches list, Go to &Summary, Expand/Contract~~ —
   implemented: Repository list focuses the active repository row; Branches list expands and
   focuses the Branches section; Go to Summary switches to Changes and focuses the summary field;
   Expand/Contract step the stored sidebar width (±16 px, clamped).
4. ~~Repository menu lacks &Remove… and uses static labels~~ — implemented: &Remove… routes through
   the same confirmation policy as the sidebar context menu; shell/editor labels are dynamic
   (`O&pen in <shell>`, `&Open in <editor>`).
5. ~~No busy-state enablement~~ — implemented: `canFetch`/`canPush`/`canPull` require
   `!loading && operation === null` and a matching repository, agreeing with the tree's map.
6. ~~The Branch menu is missing~~ — implemented: Branch → New &branch…, routed to the same
   create-and-checkout flow as the sidebar (expands Branches, opens the form, focuses the name).
7. ~~Help lacks Report issue… and View RDC on GitHub~~ — implemented with rdc-owned destinations.
8. ~~No accelerator hints~~ — implemented: right-aligned hints for every baseline accelerator.
9. ~~No keyboard access / Escape dismissal~~ — implemented: roving-tabindex menubar, arrow-key
   item navigation, Home/End, Arrow Left/Right menu switching, Escape close with focus return,
   Alt+mnemonic open, in-menu mnemonic activation, Tab close. Verify on the live build.
10. ~~No automated coverage of the in-window menu bar~~ — implemented: `menu-bar.test.tsx` (22
    tests) pins inventory, labels/access keys, accelerators, enablement, actions, zoom wiring and
    keyboard navigation.
11. ~~Labels diverge from upstream shape~~ — implemented: labels carry upstream access keys with
    underlined mnemonics and upstream wording (e.g. “Show in your File Manager”).

## State matrix

Inspect the complete application menu in each state below. Use fresh fixture scenarios where an
operation would mutate repository data.

1. No repository registered or selected.
2. A clean local repository selected, first without configured editor/shell integrations and then
   with valid integrations selected.
3. `populated` in Changes, first with no file/line selection and then with a meaningful selection.
4. History with a selected commit and changed file.
5. A repository with a configured remote/upstream, including idle and one deterministic busy state.
6. Any protected/in-progress state exposed by the MVP, including merge conflict or an active Git
   operation.
7. Two repository windows with different repositories and views, alternating native focus.

## Inventory and behavior

- Every top-level menu and visible item belongs to the Linux MVP baseline above, an
  operating-system-required native role, or a specifically recorded accepted deviation. No
  placeholder, empty submenu or test-only item is visible in a production build. No item from the
  "Removed" table is visible.
- Every enabled item performs its advertised action in the focused window. It must not open a hollow
  dialog, silently do nothing, or target the repository selected in another window.
- Every implemented MVP action that users reasonably need to discover through the application menu
  is present (membership rule (b) items included). Toolbar/context-menu duplication is allowed only
  when both entries route to the same behavior and state policy — including the New Branch flow and
  the per-file/line discard flow.
- Enablement follows state: selection-dependent actions, editor/shell actions, remote operations,
  conflict/protected-state actions and view navigation change at the correct time and recover after
  success or failure. Closing or refocusing a window must not leave stale enablement. The visible
  in-window surface and the keybinding tree must not disagree on busy-state or selection policy.
- Labels use RDC identity and current platform terminology. Dynamic editor/shell labels and any
  repository-sensitive copy are current, bounded and not duplicated with stale repository/branch
  values.
- Help/About destinations identify rdc and land only on rdc-owned/current destinations. No enabled
  item points to Desktop Plus or GitHub Desktop.
- Accelerators shown in the menu match the action they invoke, work from the relevant application
  state, and do not trigger a disabled or different item. Native operating-system roles retain their
  expected localized labels and conventions.
- Contextual menus expose only actions valid for their target row/selection and use the same
  confirmation, enablement and focused-window policy as the corresponding application-menu action.

## Platform rendering

- On macOS, inspect the real native menu bar before and after the webview finishes loading. The
  bootstrap menu must be replaced by the complete current tree without a visible stale or duplicate
  menu, and reopening a menu after state changes must show current labels and enablement.
- On Linux, inspect the platform-rendered application menu on a native Wayland session and verify
  keyboard access, dismissal, focus return and popup placement. Xvfb E2E is prerequisite evidence,
  not visual acceptance.
- Windows repeats this checklist in Phase 10 when it enters the supported surface; do not infer its
  acceptance from macOS/Linux results.

## Exit record

Record the platform, commit, states exercised and one of these outcomes in the cycle evidence:

- aligned with the MVP;
- blocker, with the exact item/state and expected disposition;
- accepted deviation, with reason and named later owner.

Any menu implementation fix invalidates the green Phase 8a prerequisite and requires this affected
state matrix to be repeated. The final packaged application gets the focused repeat named in
`final-package-smoke.md` because development-mode and packaged native menus can differ.
