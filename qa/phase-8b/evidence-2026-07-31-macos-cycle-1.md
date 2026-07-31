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
- Selected-repository context/toolbar/navigation foundation: pending —
  `selected-repository-baseline-checklist.md` Gate A; started from commit `372787e`
- Changes/History workspace foundation: pending — `selected-repository-baseline-checklist.md` Gate B
- Visual matrix: pending — macOS normal and compact rows in `visual-matrix.md`
- Platform checklist: pending — `macos-checklist.md`
- Final package smoke: not started; packaging is deliberately last

## Issues

| ID | Classification | Reproduction | Evidence | Owner/fix commit | Retest |
|---|---|---|---|---|---|
| P8B-001 | MVP-blocking preparation defect, resolved before human QA | Run the documented `pnpm fixture:phase8b -- /tmp/rdc-phase8b-qa`; pnpm 11 preserved `--`, which the script mistook for the target | Generator output pointed at the repository's `--/` directory | `a2e32c9` | Parser unit test, real documented command, complete Phase 8a gate |
| P8B-002 | MVP-blocking visual structure; resolved on macOS | Open the clean default 800×600 window: the initial responsive breakpoint expanded navigation into a full-width top panel; product identity and Add/Clone actions were duplicated; the collapse control became detached from a left rail; the collapsed state lacked persistent section controls/current-value descriptions; and the workspace empty state lacked the requested real Create action. Later reviews found a short title bar, a collapse control that jumped to the far edge, a content-height sidebar, an empty action group sitting too low, and collapsed controls styled as offset floating buttons with an oversized expand control. | Current and three annotated screenshot rounds plus collapsed-rail direction supplied during cycle-one review; decisions transcribed into `baseline-layout-checklist.md` | Baseline implementation: permanent left rail, live icon controls, RDC identity, compact three-action empty state and native repository initialization. Refinements: taller overlay bar, full-height sidebar, top-aligned empty actions, stable centered rail alignment, equal-sized borderless rail controls and contextual tooltips. | Codex verified the final equal-size macOS rail plus an exact dimension assertion in the green 23-test container E2E suite; Jose approved the macOS baseline on 2026-07-31. Linux and Windows remain separate platform gates. |
| P8B-003 | MVP-blocking selected-repository foundation; open | Select `primary` in Light theme and compare 1100×720, 800×600 and 620×720 with the sidebar expanded. The native title already says `RDC — primary — main`, while the dark toolbar duplicates repository name/path, gives four local and three remote actions nearly equal weight across height-changing rows, and leaves Changes/History as a separate generic button strip. At 620px the horizontally overflowing local-action row is clipped at its leading edge, making controls partly or wholly unreachable. | Before captures: `/tmp/rdc-gate-a-normal-light-before.png`, `/tmp/rdc-gate-a-800-light-before.png`, `/tmp/rdc-gate-a-620-light-before.png`; Gate A checklist; current CSS responds to viewport width rather than repository-workspace width | Pending Gate A design/fix: preserve title-bar repository/branch context; align one light, fixed-height command bar with the sidebar toggle; remove redundant identity/remote copy; use purpose-grouped Font Awesome icon controls with localized accessible names/tooltips so translations do not change visible geometry; attach Changes/History as workspace navigation; and keep progress/errors non-displacing | Repeat Gate A at all three widths with sidebar expanded/collapsed before visual or functional QA |

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|
| None recorded yet | — | — |

## Decision

- [ ] No agreed MVP blocker remains; selected-repository foundation and later QA are still pending.
- [x] Every preparation fix passed Phase 8a again.
- [x] Every affected baseline-layout human check was repeated on macOS.
- [ ] Final packages passed the focused smoke pass.
