# macOS development-build checklist

WKWebView has no supported `tauri-driver` backend. This checklist and its evidence are the macOS
native acceptance record; do not label it automated.

## 1. Foundation prerequisites

- Run `baseline-layout-checklist.md` in expanded and collapsed states at 800×600.
- With the generated `populated` scenario selected, pass Gates A, B, C, D and E in
  `selected-repository-baseline-checklist.md` before testing toolbar actions or repository workflows.
- Move, resize, maximize and restore the overlay-titlebar window. Double-click the persistent drag
  strip under each available `AppleActionOnDoubleClick` behavior; no rejected promise may appear.
- Complete the macOS visual-matrix cells in their specified order before functional workflows.

## 2. Read-only repository journey

- Complete `menu-mvp-alignment-checklist.md` for macOS before beginning the functional journeys.
- Launch with clean config/data, add `populated`, inspect status and text diff, switch to History and
  inspect commit metadata/files/diff, then quit and relaunch. Repository registration and selection
  persist; workspace geometry returns coherently to its defined defaults (individual pane widths are
  not currently a persistence promise). Back up and restore any existing rdc config rather than
  deleting it blindly to obtain the clean state.
- Exercise repository/sidebar selection, Changes/History navigation and refresh without a pointer.
- Cross-check the displayed file set, current branch and selected commit with `git status --short`,
  `git branch --show-current` and `git log -1 --format=%H` from the fixture.

## 3. Reversible local journey

- In `populated`, include/exclude a file and individual diff lines, then restore the intended
  selection without changing repository bytes.
- In `branch`, create and check out `branchToCreate`, then return to `initialBranch`.
- Confirm both branch transitions with `git branch --show-current`; UI success alone is not evidence.

## 4. Mutating local journey

- Use `lineDiscard` and `wholeFileDiscard` for their single named operations. Compare the surviving
  bytes with each scenario's `expectedContent` and run `git status --short`; never feed either into
  the commit journey.
- In `commitHook`, exercise the failing hook prompt/terminal output and **Bypass hooks** path. Resolve
  the already-prepared `mergeConflict` state without leaving the repository stranded. Verify the
  resulting commit/tree and absence of unmerged paths and `MERGE_HEAD` with Git CLI commands.

## 5. Remote journey

- Use `remoteFetchPull`, `remotePush` and `remoteClone` for their named operations. Use `delayedPush`
  to inspect progress/busy presentation without racing it; confirm that presentation does not disturb
  the accepted toolbar/workspace frame.
- Against a disposable tester-controlled remote, complete one HTTPS or SSH operation using credentials
  already available to system Git, its credential manager or the SSH agent. Record only transport and
  outcome—never a URL containing credentials, tokens, helper output or secret-bearing logs.
- Use `unreachableRemote` for the deterministic network failure. Use a separate tester-controlled
  endpoint for authentication rejection. Fetch must fail with actionable network/authentication copy,
  leave refs and the working tree intact, and write no secret value to the log.

## 6. Failure and recovery presentation

- Exercise `clean`, a missing external integration, `commitHook`, `unreachableRemote`
  and an authentication rejection. Confirm each empty/loading/error/progress state names the failed
  operation, remains bounded at default and compact widths and offers only valid recovery actions.
- After each failure, perform a successful read-only refresh or operation without restarting. The app
  must not retain a stale busy/disabled state or show a hollow success.

## 7. Native integrations, accessibility and lifecycle

- Repeat any focused-window menu checks identified by `menu-mvp-alignment-checklist.md`; Preferences,
  About, dialogs and contextual menus must still target the focused repository window.
- **Verify the five capability-parity actions actually dispatch from the native menu**, with a
  repository selected: Branch → New Branch… (Cmd+Shift+N), View → Show Branches List (Cmd+B), View →
  Go to Summary (Cmd+G), and View → Expand/Contract Active Resizable (Cmd+9 / Cmd+8). Each must
  perform its action in the focused window, not merely appear enabled.

  This item exists because these five were previously disabled on macOS purely because the
  development host could not verify them — which left the macOS Branch menu with no usable item at
  all. They are now enabled on every platform under the capability-parity rule. Unit tests prove
  each has an executor on `macos`; **nothing automated can prove native WKWebView dispatch**, because
  there is no `tauri-driver` backend for it, so this manual check is the only evidence that exists.
  If any of them does nothing, that is a defect in the native menu path, not a reason to re-disable
  the item.
- Open a second repository window, give each window a different selected repository/view, and repeat
  menu, context-menu and close actions while alternating focus. State and commands must remain scoped
  to the focused window; closing one must not destroy or retarget the other.
- Launch the selected editor, terminal and Finder action. Missing integrations fail visibly without
  presenting a hollow success.
- Complete Preferences, dialogs and repository/change/history navigation without a pointer. Verify
  modal focus entry, both Tab boundaries, Escape policy and focus restoration.
- With VoiceOver enabled, traverse the toolbar, sidebar, file/commit lists, diff controls and dialogs.
  Icon-only controls announce contextual names, selection/busy/error state is exposed, and list
  navigation does not strand the virtual cursor. Repeat keyboard focus checks with Reduce Motion and
  Increase Contrast enabled.
- Request close with ordinary state and during protected work; confirm hide/quit policy,
  last-window behavior and clean relaunch.
- Record config/log locations and inspect the log after each group for renderer rejections or native
  errors or secret values, then perform one final log review.
