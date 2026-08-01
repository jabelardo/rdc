# Phase 8b evidence record — macOS cycle 2

- Commit: `c8da366` (`Complete toolbar and tooltip QA refinement`)
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
- `pnpm test`: pass — 952/952 (underlying Vitest binary on Node 24)
- `pnpm exec tsc --noEmit`: pass
- `pnpm format:check`: underlying `oxfmt --check .` pass — 365 files; the pnpm wrapper stalls only
  in the managed agent shell and is not claimed as a product failure
- `pnpm lint`: pass — Oxlint clean
- `pnpm build`: pass — exercised by the Linux E2E container
- `pnpm check:bundle-boundary`: unchanged from the green Phase 8a input gate
- `pnpm test:e2e`: pass — 28/28 across 14 suites
- `cargo test --workspace`: pass — 1,179/1,179
- `cargo clippy --workspace --all-targets -- -D warnings`: pass
- `cargo fmt --check`: pass

## Foundation carried into this cycle

The shell/empty-state baseline and selected-repository Gates A–E were accepted on macOS in
`evidence-2026-07-31-macos-cycle-1.md`. This cycle then refined the toolbar, disclosure tooltips and
working-tree action icon through P8B-008, accepted in commit `c8da366`. Those accepted foundations
remain the entry condition for the rest of this visual cycle, while Linux still requires independent
acceptance.

## Human results

- Visual matrix — normal Light: awaiting human decision; `clean`, populated Changes and populated
  History captured
- Visual matrix — default Light: awaiting human decision; populated Changes and History captured
- Visual matrix — compact Light: awaiting human decision; populated Changes and History captured
- Visual matrix — Dark: awaiting human decision; populated Changes and History captured at all
  three approved widths
- Visual matrix — System: awaiting human decision; under the current Light macOS appearance,
  populated Changes and History captured at all three approved widths
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
| P8B-008 | MVP visual refinement; resolved on macOS | In populated Changes, inspect the command bar: repository creation entry points were available only in the empty state/File menu; Open in New Window occupied scarce toolbar space; Fetch reused a generic refresh glyph; native-title tooltips repeated repository/branch names and appeared at an implementation-defined delay. First tooltip iteration also rendered beneath the workspace and used a dark bubble in Light theme; the sidebar still used native WebKit titles. Second iteration exposed fixed-width bubbles that did not contain long paths/hashes and redundant repository/branch names. | Before: `/tmp/rdc-phase8b-cycle2-normal-light-populated.png`. Iteration 1: `/tmp/rdc-phase8b-cycle2-toolbar-actions-normal.png`, `/tmp/rdc-phase8b-cycle2-toolbar-actions-compact.png`. Human findings: `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 10.59.29.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.04.22.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.20.13.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.32.06.png`, `/Users/josegutierrez/Desktop/Screenshot 2026-08-01 at 11.45.28.png`. | Fixed in `c8da366`: add Font Awesome plus/folder-plus/clone actions before a separator and file-manager/editor/terminal actions; remove Open in New Window from the toolbar only; use `arrows-down-to-line` for Fetch; keep toolbar tooltip text context-independent. Replace every native `title` tooltip in `src` with a shared 250 ms hover/focus portal, including disabled actions, resizers, sidebar controls, list metadata and workspace actions. The body-level layer escapes pane clipping, theme tokens produce a raised light surface in Light and a raised dark surface in Dark, and content-sized bubbles contain full values up to the viewport. Repository rows disclose only the path; branch rows disclose action/state plus absolute last-modified time; clicking a short history SHA copies the complete hash. The selected-lines discard action uses the Font Awesome trash-can glyph while whole-file discard retains its restore-style glyph. The empty-state actions use the same icons while retaining visible labels. | 951 frontend tests, TypeScript, Oxlint, formatting and all 27 native E2E tests pass. E2E guards the 250 ms delay, body-level stacking, Light raised-surface token, toolbar/sidebar reuse, full-SHA containment and complete-hash copy; it also caught and now guards the intermediate 740 px toolbar overflow by condensing the Changes/History labels before the workspace breakpoint. Jose ended and accepted this macOS QA task on 2026-08-01. Linux repeats the affected visual checks independently; the complete Phase 8a rerun remains required before cycle closure. |
| P8B-009 | MVP branch-classification defect; implementation complete, human retest pending | Expand Branches for the generated `populated` scenario before any remote operation. Although local `main` tracks `origin/main` and the bare remote advertises `HEAD → main`, the sidebar shows no Default Branch group and classifies `main` under Other Branches. | Git oracle before the fix: bare `HEAD` is `main`, local `main` tracks `origin/main`, but `git symbolic-ref --short refs/remotes/origin/HEAD` fails because the fixture's push never records the local symref. Code audit found that rdc also ported `updateRemoteHEAD` but omitted upstream's non-fatal call after successful fetch/pull operations. | Uncommitted: the fixture now records `origin/HEAD` after publishing `main`; `RemoteStore` refreshes the remote HEAD after every successful fetch performed by Fetch, Push or Pull, logging but not failing the completed operation if that incidental refresh fails. | The fixture assertion failed before the change and now passes. Remote/branch store tests pass, including exact multi-remote calls and non-fatal update failure; full frontend result is 952/952 with TypeScript, Oxlint and formatting clean. All 28 native E2E tests pass, including the existing real Fetch assertion that waits for the Default Branch group. A real Fetch against the disposable cycle-2 repository created `origin/HEAD → origin/main`. Human confirmation that Default Branch now appears remains pending. |
| P8B-010 | MVP Dark-theme visual refinement; implementation complete, human retest pending | In populated Dark Changes, toolbar/sidebar icon controls, branch rows and the selected-lines trash action acquire raised rectangular backgrounds that the corresponding Light controls intentionally omit. New Branch still uses a generic plus glyph. Working-tree and History file-status icons lose their semantic green/amber/red identity and become muted gray. | Human finding: `/Users/josegutierrez/Desktop/dark-theme-fixes-001.png`. The broad late `:root[data-theme='dark'] button` rule overrode every component-level transparent background; the Dark muted-text rule also targeted the shared status icon's `<small>` element with equal specificity but later source order. | Uncommitted: general buttons now receive their theme surface through `--color-button`, while compact controls retain their component-level transparent treatment in both themes. The overly broad Dark button rule and status-icon muting selectors are removed. New Branch uses Font Awesome `arrows-split-up-and-left`; current branch and selected view retain their deliberate selection treatments. | Focused App tests pass 36/36 with the new glyph asserted; TypeScript, formatting and Oxlint are clean. Native E2E passes 28/28 and now reads computed Dark styles to guard transparent toolbar/collapse/New Branch/trash controls, the split-branch glyph, retained branch selection, and semantic success colours in both Changes and History. Human macOS visual confirmation remains pending. |

## Cycle-2 visual captures

- Normal Light, clean Changes: `/tmp/rdc-phase8b-cycle2-normal-light-clean.png`
- Normal Light, populated Changes: `/tmp/rdc-phase8b-cycle2-normal-light-populated.png`
- Default Light, populated Changes: `/tmp/rdc-phase8b-cycle2-default-light-populated.png`
- Compact Light, populated Changes: `/tmp/rdc-phase8b-cycle2-compact-light-populated.png`
- Normal Light, populated History: `/tmp/rdc-phase8b-cycle2-normal-light-history.png`
- Default Light, populated History: `/tmp/rdc-phase8b-cycle2-default-light-history.png`
- Compact Light, populated History: `/tmp/rdc-phase8b-cycle2-compact-light-history.png`
- Normal Dark, populated Changes: `/tmp/rdc-phase8b-cycle2-dark-normal-populated.png`
- Default Dark, populated Changes: `/tmp/rdc-phase8b-cycle2-dark-default-populated.png`
- Compact Dark, populated Changes: `/tmp/rdc-phase8b-cycle2-dark-compact-populated.png`
- Normal Dark, populated History: `/tmp/rdc-phase8b-cycle2-dark-normal-history.png`
- Default Dark, populated History: `/tmp/rdc-phase8b-cycle2-dark-default-history.png`
- Compact Dark, populated History: `/tmp/rdc-phase8b-cycle2-dark-compact-history.png`
- Normal System (Light OS), populated Changes: `/tmp/rdc-phase8b-cycle2-system-normal-populated.png`
- Default System (Light OS), populated Changes: `/tmp/rdc-phase8b-cycle2-system-default-populated.png`
- Compact System (Light OS), populated Changes: `/tmp/rdc-phase8b-cycle2-system-compact-populated.png`
- Normal System (Light OS), populated History: `/tmp/rdc-phase8b-cycle2-system-normal-history.png`
- Default System (Light OS), populated History: `/tmp/rdc-phase8b-cycle2-system-default-history.png`
- Compact System (Light OS), populated History: `/tmp/rdc-phase8b-cycle2-system-compact-history.png`

Mechanical observation only, not acceptance: all three widths retained sidebar-left, navigation-left
and diff-right ownership; toolbar labels condensed at compact width; long repository and historical
file names truncated within their regions; no region stacked, escaped the window or hid the commit
dock. The same structural observations hold in the Dark captures, and the semantic added-line colour,
selection, borders and raised controls remain distinguishable there. Typography, spacing, colour and
overall visual quality still require Jose's judgment.

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|

## Decision

- [ ] No agreed MVP blocker remains.
- [ ] Every fix passed Phase 8a again.
- [ ] Every affected human check was repeated.
- [ ] Final packages passed the focused smoke pass.
