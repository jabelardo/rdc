# macOS development-build checklist

WKWebView has no supported `tauri-driver` backend. This checklist and its evidence are the macOS
native acceptance record; do not label it automated.

## 1. Foundation prerequisites

- Run `baseline-layout-checklist.md` in expanded and collapsed states at 800×600.
- With the generated `primary` fixture selected, pass Gates A, B, C, D and E in
  `selected-repository-baseline-checklist.md` before testing toolbar actions or repository workflows.
- Move, resize, maximize and restore the overlay-titlebar window. Double-click the persistent drag
  strip under each available `AppleActionOnDoubleClick` behavior; no rejected promise may appear.
- Complete the macOS visual-matrix cells in their specified order before functional workflows.

## 2. Read-only repository journey

- Launch with clean config/data, add `primary`, inspect status and text diff, switch to History and
  inspect commit metadata/files/diff, then quit and relaunch. Repository registration and selection
  persist; workspace geometry returns coherently to its defined defaults (individual pane widths are
  not currently a persistence promise). Back up and restore any existing rdc config rather than
  deleting it blindly to obtain the clean state.
- Exercise repository/sidebar selection, Changes/History navigation and refresh without a pointer.
- Cross-check the displayed file set, current branch and selected commit with `git status --short`,
  `git branch --show-current` and `git log -1 --format=%H` from the fixture.

## 3. Reversible local journey

- Include/exclude a file and individual diff lines, then restore the fixture's intended selection.
- Create and check out a branch, then return to the original branch.
- Confirm both branch transitions with `git branch --show-current`; UI success alone is not evidence.

## 4. Mutating local journey

- Discard a selected line and a whole file using separate freshly generated fixture targets. Verify
  the surviving bytes and `git status --short` after each; do not feed the discarded fixture into
  the commit journey.
- Commit the intended selection, exercise the hook prompt/terminal output, and complete the minimum
  supported merge-conflict resolution without leaving the repository stranded. Use fresh fixtures
  for commit and conflict work, then verify the resulting commit/tree and absence of merge state with
  Git CLI commands.

## 5. Remote journey

- Using the generated local bare remote, run Fetch before Pull, then unpublished-branch Push, and
  finally Clone into a fresh destination. Verify progress, disabled/running/error presentation does
  not disturb the accepted toolbar/workspace frame.
- Against a disposable tester-controlled remote, complete one HTTPS or SSH operation using credentials
  already available to system Git, its credential manager or the SSH agent. Record only transport and
  outcome—never a URL containing credentials, tokens, helper output or secret-bearing logs.
- In a separate disposable fixture, point `origin` at an unreachable endpoint and at an endpoint that
  rejects authentication. Fetch must fail with actionable network/authentication copy, leave refs and
  the working tree intact, and write no secret value to the log.

## 6. Failure and recovery presentation

- Exercise a clean repository, a missing external integration, a failing hook, an unreachable remote
  and an authentication rejection. Confirm each empty/loading/error/progress state names the failed
  operation, remains bounded at default and compact widths and offers only valid recovery actions.
- After each failure, perform a successful read-only refresh or operation without restarting. The app
  must not retain a stale busy/disabled state or show a hollow success.

## 7. Native integrations, accessibility and lifecycle

- Open every enabled MVP native-menu item. Confirm labels, accelerators, enablement, Preferences,
  About, dialogs and contextual menus target the focused repository window.
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
