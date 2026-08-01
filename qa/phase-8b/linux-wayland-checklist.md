# Ubuntu 26.04 native-Wayland checklist

## 1. Environment and foundation

- Repeat `baseline-layout-checklist.md` in expanded and collapsed states at the default 800×600
  window. The macOS result is a design reference, not Linux acceptance evidence; record any necessary
  WebKitGTK/native-decoration variation explicitly.
- Select the generated `primary` fixture and independently repeat all five gates in
  `selected-repository-baseline-checklist.md` before the Linux visual matrix or workflows.
- Confirm the session is native Wayland (`XDG_SESSION_TYPE=wayland`) and record compositor, WebKitGTK,
  Tauri, system Git, architecture and display scale. Use a new Linux-specific fixture; never reuse
  one mutated by macOS or an earlier destructive group.
- Launch the development build with `WEBKIT_DISABLE_COMPOSITING_MODE=1` supplied by rdc startup code,
  not an interactive-shell workaround.

## 2. Rendering and visual matrix

- Resize repeatedly between normal and compact widths; move, maximize, restore and refocus the window.
  Look specifically for startup crashes, blur, stale frames, missing repaint, view-switch tearing and
  misplaced popup/context menus. Repeat after display-scale or monitor changes available to the host.
- Complete every Linux row in `visual-matrix.md`, including explicit empty/loading/error/progress
  states, before functional workflows.

## 3. Local repository journeys

- On the generated fixture, inspect status/diff and History, then exercise file/line inclusion and
  branch checkout/return. Cross-check with `git status --short`, `git branch --show-current` and
  `git log -1 --format=%H`.
- Use separate fresh fixture targets for selected-line discard, whole-file discard, commit/hook and
  minimum merge-conflict recovery. Verify bytes, commit/tree state and absence of stranded merge state
  with Git CLI commands after each journey.
- Quit the entire process and relaunch. Repository registration and selection persist and both
  repository views repaint coherently.

## 4. Remote and failure journeys

- With a fresh generated fixture, run Fetch before Pull, unpublished-branch Push, then Clone into a
  fresh destination. Verify refs and checked-out content against the local bare remote with Git CLI.
- Against a disposable tester-controlled remote, complete one HTTPS or SSH operation using credentials
  already available to system Git, its credential manager or the SSH agent. Record no credentials,
  tokens or secret-bearing URLs.
- Separately exercise unreachable and authentication-rejecting remotes. Failures must be actionable,
  preserve refs/working-tree state, clear busy UI and leak no secret value to logs.

## 5. Native integrations, accessibility and lifecycle

- Exercise native open/save dialogs, file manager, editor and terminal launch on the installed desktop;
  test one deliberately missing integration and require visible failure rather than hollow success.
- Open two repository windows with different repositories/views. Alternate focus while invoking native
  menus, contextual menus and close; commands remain window-scoped and closing one leaves the other
  functional.
- Complete all navigation and dialogs without a pointer. Verify focus entry/trap/restore, Escape
  policy, icon-only accessible names and selection/busy/error exposure with Orca or the session's
  supported accessibility inspector. Repeat focus checks with reduced motion/high contrast where the
  desktop exposes them.
- Confirm ordinary/protected close, last-window policy, complete quit and clean relaunch.

## 6. Storage and logs

- Confirm config and logs live below the identifier-scoped XDG directories and inspect the log for
  renderer/native errors or secret values after every group and once at the end.

The Xvfb WebDriver suite is prerequisite automation, not a substitute for this rendering check.
