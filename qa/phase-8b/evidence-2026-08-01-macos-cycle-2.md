# Phase 8b evidence record — macOS cycle 2

- Commit: `ab0c4cd2018f5ec8b1f6deb7f5d0db1e23220cd7`
- Tester: Jose Gutierrez with Codex-assisted setup and evidence capture
- Date/time: 2026-08-01
- Platform and version: macOS 26.5.2 (25F84), Tauri 2.11.5
- Desktop/session and compositor: native macOS WKWebView
- Architecture and display scale: arm64; 1512×982 logical points at 2× scale
- Development build command: `nvm use && pnpm tauri dev`
- Fixture manifest path and purpose: `/tmp/rdc-phase8b-macos-cycle-2/fixture-manifest.json`;
  independent schema-2 states for macOS visual and functional QA
- Fixture schema version and scenarios consumed: schema 2; `clean` and `populated` registered for
  Light-theme visual review; neither mutated

## Automated prerequisite

- `pnpm qualify:phase8a`: pass — 3/3 Node contracts; input audit `errors: []`
- `pnpm test`: pass — 951/951 (underlying Vitest binary on Node 24)
- `pnpm exec tsc --noEmit`: pass
- `pnpm format:check`: underlying `oxfmt --check .` pass — 364 files; the pnpm wrapper stalls only
  in the managed agent shell and is not claimed as a product failure
- `pnpm lint`: pass — Oxlint clean
- `pnpm build`: pass — exercised by the Linux E2E container
- `pnpm check:bundle-boundary`: unchanged from the green Phase 8a input gate
- `pnpm test:e2e`: pass — 27/27 across 14 suites
- `cargo test --workspace`: pass — 1,179/1,179
- `cargo clippy --workspace --all-targets -- -D warnings`: pass
- `cargo fmt --check`: pass

## Foundation carried into this cycle

The shell/empty-state baseline and selected-repository Gates A–E were accepted on macOS in
`evidence-2026-07-31-macos-cycle-1.md`. Commit `ab0c4cd` changes only QA fixture/tooling and
documentation after the accepted Gate E product commit `de5758c`; no application layout code changed.
Those accepted foundations therefore remain the entry condition for this visual cycle, while Linux
still requires independent acceptance.

## Human results

- Visual matrix — normal Light: awaiting human decision; `clean`, populated Changes and populated
  History captured
- Visual matrix — default Light: awaiting human decision; populated Changes and History captured
- Visual matrix — compact Light: awaiting human decision; populated Changes and History captured
- Visual matrix — Dark/System: pending
- Visual accessibility variants: pending
- Application-menu MVP alignment: pending; use `menu-mvp-alignment-checklist.md`
- Read-only/reversible local journeys and Git CLI oracle: pending
- Destructive/commit/conflict journeys and Git CLI oracle: pending
- Local-bare and system-credential remote journeys: pending
- Failure/recovery presentation: pending
- Native integrations, multi-window, accessibility and lifecycle: pending
- Config/log locations and secret-free final log review: pending
- Final icon, identifier and Preview/Beta presentation decision: pending
- Final package smoke: pending; package-last rule applies

## Issues

| ID | Classification | Reproduction | Evidence | Owner/fix commit | Retest |
|---|---|---|---|---|---|
| P8B-008 | MVP visual refinement; resolved on macOS | In populated Changes, inspect the command bar: repository creation entry points were available only in the empty state/File menu; Open in New Window occupied scarce toolbar space; Fetch reused a generic refresh glyph; native-title tooltips repeated repository/branch names and appeared at an implementation-defined delay. First tooltip iteration also rendered beneath the workspace and used a dark bubble in Light theme; the sidebar still used native WebKit titles. Second iteration exposed fixed-width bubbles that did not contain long paths/hashes and redundant repository/branch names. | Before: `/tmp/rdc-phase8b-cycle2-normal-light-populated.png`. Iteration 1: `/tmp/rdc-phase8b-cycle2-toolbar-actions-normal.png`, `/tmp/rdc-phase8b-cycle2-toolbar-actions-compact.png`. Human findings: `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 10.59.29.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.04.22.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.20.13.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.32.06.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.45.28.png`. | Uncommitted: add Font Awesome plus/folder-plus/clone actions before a separator and file-manager/editor/terminal actions; remove Open in New Window from the toolbar only; use `arrows-down-to-line` for Fetch; keep toolbar tooltip text context-independent. Replace every native `title` tooltip in `src` with a shared 250 ms hover/focus portal, including disabled actions, resizers, sidebar controls, list metadata and workspace actions. The body-level layer escapes pane clipping, theme tokens produce a raised light surface in Light and a raised dark surface in Dark, and content-sized bubbles contain full values up to the viewport. Repository rows disclose only the path; branch rows disclose action/state plus absolute last-modified time; clicking a short history SHA copies the complete hash. The selected-lines discard action uses the Font Awesome trash-can glyph while whole-file discard retains its restore-style glyph. The empty-state actions use the same icons while retaining visible labels. | 951 frontend tests, TypeScript, Oxlint, formatting and all 27 native E2E tests pass. E2E guards the 250 ms delay, body-level stacking, Light raised-surface token, toolbar/sidebar reuse, full-SHA containment and complete-hash copy; it also caught and now guards the intermediate 740 px toolbar overflow by condensing the Changes/History labels before the workspace breakpoint. Jose ended and accepted this macOS QA task on 2026-08-01. Linux repeats the affected visual checks independently; the complete Phase 8a rerun remains required before cycle closure. |

## Cycle-2 visual captures

- Normal Light, clean Changes: `/tmp/rdc-phase8b-cycle2-normal-light-clean.png`
- Normal Light, populated Changes: `/tmp/rdc-phase8b-cycle2-normal-light-populated.png`
- Default Light, populated Changes: `/tmp/rdc-phase8b-cycle2-default-light-populated.png`
- Compact Light, populated Changes: `/tmp/rdc-phase8b-cycle2-compact-light-populated.png`
- Normal Light, populated History: `/tmp/rdc-phase8b-cycle2-normal-light-history.png`
- Default Light, populated History: `/tmp/rdc-phase8b-cycle2-default-light-history.png`
- Compact Light, populated History: `/tmp/rdc-phase8b-cycle2-compact-light-history.png`

Mechanical observation only, not acceptance: all three widths retained sidebar-left, navigation-left
and diff-right ownership; toolbar labels condensed at compact width; long repository and historical
file names truncated within their regions; no region stacked, escaped the window or hid the commit
dock. Typography, spacing, colour and overall visual quality still require Jose's judgment.

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|

## Decision

- [ ] No agreed MVP blocker remains.
- [ ] Every fix passed Phase 8a again.
- [ ] Every affected human check was repeated.
- [ ] Final packages passed the focused smoke pass.
