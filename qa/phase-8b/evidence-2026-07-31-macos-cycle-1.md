# Phase 8b evidence record — macOS cycle 1

- Commit: `a2e32c9168f0e9e6e22aaf3eb8ae5a1193371e04`
- Tester: Jose Gutierrez, assisted by Codex
- Date/time: 2026-07-31T13:26:29+02:00
- Platform and version: macOS 26.5.2 (25F84), WebKit framework 21624
- Desktop/session and compositor: native macOS Aqua/WindowServer, WKWebView
- Architecture and display scale: arm64; 1512×982 logical points at 2× scale
- Development build command or package SHA-256: `pnpm tauri dev` under Node 24.16.0
- Fixture manifest path: `/tmp/rdc-phase8b-qa/fixture-manifest.json`
- Fixture primary repository: `/tmp/rdc-phase8b-qa/primary`
- Pre-cycle state backup: `/tmp/rdc-phase8b-state-before-cycle1-a2e32c9`

## Automated prerequisite

- `pnpm qualify:phase8a`: passed; three checks, `"errors": []`
- `pnpm test`: passed; 941 tests in 110 files
- `pnpm exec tsc --noEmit`: passed
- `pnpm format:check`: passed; 360 files
- `pnpm lint`: passed
- `pnpm build`: passed
- `pnpm check:bundle-boundary`: passed; 108 browser-reachable modules, no Node built-ins
- `pnpm test:e2e`: passed; 23 tests in 14 suites
- `cargo test --workspace`: passed; 1,180 tests
- `cargo clippy --workspace --all-targets -- -D warnings`: passed
- `cargo fmt --check`: passed
- isolated `git-ops` and `trampoline` checks: passed
- Windows `git-ops --all-targets` compile guard: passed

Expected non-failing output: Node's eight deferred `url.parse()` import warnings during Vitest;
Tailwind's debug CSS source-map warning; and Xvfb's non-accelerated EGL/dconf messages. Their scope is
recorded in `REMAINING.md` and the E2E harness documentation.

## Human results

- Baseline application-shell layout: accepted as the macOS baseline after three annotated refinement
  rounds — `baseline-layout-checklist.md`. Linux and Windows revalidation remain open in their own QA.
- Selected-repository context/toolbar/navigation foundation: accepted as the macOS baseline —
  `selected-repository-baseline-checklist.md` Gate A; started from commit `372787e`, accepted after
  two visual iterations on 2026-07-31
- Left-pane design foundation: accepted as the macOS baseline —
  `selected-repository-baseline-checklist.md` Gate B; accepted after four assisted visual iterations
  on 2026-07-31. Linux and Windows revalidation remain open in their own QA.
- Changes workspace foundation: pending — `selected-repository-baseline-checklist.md` Gate C
- History workspace foundation and cross-frame stability: pending —
  `selected-repository-baseline-checklist.md` Gate D
- Visual matrix: pending — macOS normal and compact rows in `visual-matrix.md`
- Platform checklist: pending — `macos-checklist.md`
- Final package smoke: not started; packaging is deliberately last

## Issues

| ID | Classification | Reproduction | Evidence | Owner/fix commit | Retest |
|---|---|---|---|---|---|
| P8B-001 | MVP-blocking preparation defect, resolved before human QA | Run the documented `pnpm fixture:phase8b -- /tmp/rdc-phase8b-qa`; pnpm 11 preserved `--`, which the script mistook for the target | Generator output pointed at the repository's `--/` directory | `a2e32c9` | Parser unit test, real documented command, complete Phase 8a gate |
| P8B-002 | MVP-blocking visual structure; resolved on macOS | Open the clean default 800×600 window: the initial responsive breakpoint expanded navigation into a full-width top panel; product identity and Add/Clone actions were duplicated; the collapse control became detached from a left rail; the collapsed state lacked persistent section controls/current-value descriptions; and the workspace empty state lacked the requested real Create action. Later reviews found a short title bar, a collapse control that jumped to the far edge, a content-height sidebar, an empty action group sitting too low, and collapsed controls styled as offset floating buttons with an oversized expand control. | Current and three annotated screenshot rounds plus collapsed-rail direction supplied during cycle-one review; decisions transcribed into `baseline-layout-checklist.md` | Baseline implementation: permanent left rail, live icon controls, RDC identity, compact three-action empty state and native repository initialization. Refinements: taller overlay bar, full-height sidebar, top-aligned empty actions, stable centered rail alignment, equal-sized borderless rail controls and contextual tooltips. | Codex verified the final equal-size macOS rail plus an exact dimension assertion in the green 23-test container E2E suite; Jose approved the macOS baseline on 2026-07-31. Linux and Windows remain separate platform gates. |
| P8B-003 | MVP-blocking selected-repository foundation; resolved on macOS | Select `primary` in Light theme and compare 1100×720, 800×600 and 620×720 with the sidebar expanded. The native title already says `RDC — primary — main`, while the dark toolbar duplicates repository name/path, gives four local and three remote actions nearly equal weight across height-changing rows, and leaves Changes/History as a separate generic button strip. At 620px the horizontally overflowing local-action row is clipped at its leading edge, making controls partly or wholly unreachable. | Before captures: `/tmp/rdc-gate-a-normal-light-before.png`, `/tmp/rdc-gate-a-800-light-before.png`, `/tmp/rdc-gate-a-620-light-before.png`. Iteration 1: `/tmp/rdc-gate-a-toolbar-iteration-1-normal.png`, `/tmp/rdc-gate-a-toolbar-iteration-1-620.png`, `/tmp/rdc-gate-a-toolbar-iteration-1-620-collapsed.png`. Iteration 2: `/tmp/rdc-gate-a-toolbar-iteration-2-normal.png`. | Removed duplicated identity/remote copy; aligned a fixed-height subtle command bar with a right-aligned borderless sidebar control and a short visible seam; grouped four local and three remote Font Awesome controls with localized-name-compatible icon-only geometry and contextual tooltips; reserved a non-displacing status line; and rendered Changes/History as attached tabs. | Jose accepted the macOS toolbar baseline on 2026-07-31. Automated E2E locks equal bar/control/separator geometry and no compact overflow in both sidebar states. Linux and Windows repeat Gate A independently. |
| P8B-004 | MVP-blocking left-pane design foundation; resolved on macOS | Select `primary` in Light theme at 1100×720, 800×600 and 620×720. The pane remained at its 21 rem maximum at every width, consuming about 44% of the compact window; repository selection, its overflow action, branch selection and branch creation all used equally heavy bordered controls. | Before: `/tmp/rdc-gate-b-left-pane-before-1100.png`, `/tmp/rdc-gate-b-left-pane-before-800.png`, `/tmp/rdc-gate-b-left-pane-before-620.png`. Iteration 1: `/tmp/rdc-gate-b-left-pane-iteration-1-1100.png`, `/tmp/rdc-gate-b-left-pane-iteration-1-620.png`. Iteration 2 repository capture: `/tmp/rdc-gate-b-repositories-iteration-2-fullscreen.png`. | Iteration 1 uses a 15–21 rem responsive pane tied to viewport width and reduces the original heavy form treatment. Iteration 2 adopts the useful upstream repository-selector patterns and establishes the exclusive accordion. Iteration 3 gives Branches filter, aligned icon-only New branch action with a transient create row, local navigation rows and current-row emphasis; remote refs remain fetch state rather than inert UI. Iteration 4 restores upstream's clearer Default/Recent/Other visual language with real data: the recorded remote `HEAD` identifies Default Branch, the existing native reflog command supplies Recent Branches, and remaining local refs form Other Branches. Unknown or empty groups are omitted rather than guessed. Relative activity, Pull Requests, merge selection and branch context actions remain deferred. | Jose accepted the macOS left-pane baseline on 2026-07-31 after verifying the repository and branch expansion flows, filters, aligned branch action, local-only branch surface and final grouping. The green 24-test native E2E suite locks exclusive expansion, fixed sibling headers, large-list bounds, checkout/create/fetch behavior and remote-ref exclusion. Linux and Windows repeat Gate B independently. |

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|
| None recorded yet | — | — |

## Decision

- [ ] No agreed MVP blocker remains; selected-repository foundation and later QA are still pending.
- [x] Every preparation fix passed Phase 8a again.
- [x] Every affected baseline-layout human check was repeated on macOS.
- [ ] Final packages passed the focused smoke pass.
