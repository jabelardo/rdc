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
- `pnpm test:e2e`: passed; 22 tests in 14 suites
- `cargo test --workspace`: passed; 1,180 tests
- `cargo clippy --workspace --all-targets -- -D warnings`: passed
- `cargo fmt --check`: passed
- isolated `git-ops` and `trampoline` checks: passed
- Windows `git-ops --all-targets` compile guard: passed

Expected non-failing output: Node's eight deferred `url.parse()` import warnings during Vitest;
Tailwind's debug CSS source-map warning; and Xvfb's non-accelerated EGL/dconf messages. Their scope is
recorded in `REMAINING.md` and the E2E harness documentation.

## Human results

- Baseline application-shell layout: implementation complete; Jose's affected-check retest pending —
  `baseline-layout-checklist.md`
- Visual matrix: pending — macOS normal and compact rows in `visual-matrix.md`
- Platform checklist: pending — `macos-checklist.md`
- Final package smoke: not started; packaging is deliberately last

## Issues

| ID | Classification | Reproduction | Evidence | Owner/fix commit | Retest |
|---|---|---|---|---|---|
| P8B-001 | MVP-blocking preparation defect, resolved before human QA | Run the documented `pnpm fixture:phase8b -- /tmp/rdc-phase8b-qa`; pnpm 11 preserved `--`, which the script mistook for the target | Generator output pointed at the repository's `--/` directory | `a2e32c9` | Parser unit test, real documented command, complete Phase 8a gate |
| P8B-002 | MVP-blocking visual structure; implementation complete, human closure pending | Open the clean default 800×600 window: the responsive breakpoint expands navigation into a full-width top panel; product identity and Add/Clone actions are duplicated; the collapse control becomes detached from a left rail; the collapsed state lacks persistent section controls/current-value descriptions; and the workspace empty state lacks the requested real Create action | Current and annotated screenshots plus collapsed-rail direction supplied during cycle-one review; decisions transcribed into `baseline-layout-checklist.md` | Baseline-layout implementation (this commit): permanent left rail, live icon controls, RDC identity, compact three-action empty state and native repository initialization | Codex verified the clean 800×600 macOS launch and complete automated suite; Jose must repeat the affected checklist before this issue closes |

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|
| None recorded yet | — | — |

## Decision

- [ ] No agreed MVP blocker remains.
- [x] Every preparation fix passed Phase 8a again.
- [ ] Every affected human check was repeated.
- [ ] Final packages passed the focused smoke pass.
