# Phase 8b evidence record — macOS cycle 1

- Starting commit: `a2e32c9168f0e9e6e22aaf3eb8ae5a1193371e04`
- Accepted foundation through: `de5758c` (`Complete the macOS resizing baseline`)
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
- Changes workspace foundation: accepted as the macOS baseline —
  `selected-repository-baseline-checklist.md` Gate C; accepted after three assisted visual
  iterations on 2026-07-31. Linux and Windows revalidation remain open in their own QA.
- History workspace foundation and cross-frame stability: accepted as the macOS baseline after five
  assisted visual iterations on 2026-07-31 —
  `selected-repository-baseline-checklist.md` Gate D. The 26-test native E2E suite verifies bounded
  side-by-side regions, independent list/file/diff scrolling and retained History selections after
  switching through Changes. Linux and Windows revalidation remain open in their own QA.
- Top-level resizing behavior: accepted on macOS on 2026-08-01 —
  `selected-repository-baseline-checklist.md` Gate E.
  The first live macOS development build completed continuous 1100→620→1100 resizing in Changes and
  History with both sidebar states, including repeated responsive-threshold crossings and a native
  Window → Zoom/restore cycle against long repository, branch, commit and file names. No renderer
  error, pane-axis change or blank repaint was observed. Captures:
  `/tmp/rdc-gate-e-changes-collapsed-680.png`,
  `/tmp/rdc-gate-e-changes-collapsed-672.png`,
  `/tmp/rdc-gate-e-changes-collapsed-620.png`,
  `/tmp/rdc-gate-e-history-expanded-620-full.png`, and
  `/tmp/rdc-gate-e-history-collapsed-restored-800-full.png`. Annotated review then replaced 620 with
  a useful native 715×356 floor and requested independently resizable sidebar and Changes panes.
  The restarted macOS build clamps an attempted 500×250 resize to exactly 715×356; at that floor the
  expanded layout preserves 125/190/300 px minima for sidebar, file/commit pane and diff, and the
  commit action omits redundant branch text. Capture:
  `/tmp/rdc-gate-e-changes-minimum-resizers.png`. The Linux/Tauri suite passes 27/27 and now pins the
  native floor, compact breakpoint, pane minima, resizer presence, both directions, selection
  retention and maximize/restore. The annotated History review retained the existing 715×356
  native floor and assigned its three horizontal regions 190/150/220 px minima, with independent
  separators between commit list/details and changed files/diff. Implementation and automated
  coverage are complete, and the restarted native build renders that structure at the floor in
  `/tmp/rdc-gate-e-history-minimum-resizers.png`; live macOS drag behavior and final human acceptance
  remain open. A follow-up recording exposed the shell using different workspace reservations for
  Changes and History, which visibly reclamped the sidebar during every view switch. Both selected-
  repository views now reserve the stricter 560 px workspace minimum, and E2E asserts the measured
  sidebar width is unchanged across Changes → History. The same recording also exposed History's
  load sequence painting empty, commit, details and diff states after it was already visible. View
  selection now keeps Changes visible while the already-mounted History tree receives that complete
  load off-screen, then reveals it in one React commit; returning to Changes cancels a pending reveal,
  and every new History transition still reloads so commits/fetches/pulls cannot leave stale data.
  Jose accepted the completed resizing and prepared-view behavior as the macOS baseline on
  2026-08-01.
- Visual matrix: pending — macOS normal, default and compact rows in `visual-matrix.md`
- Platform checklist: pending — `macos-checklist.md`
- Final package smoke: not started; packaging is deliberately last

## Issues

| ID | Classification | Reproduction | Evidence | Owner/fix commit | Retest |
|---|---|---|---|---|---|
| P8B-001 | MVP-blocking preparation defect, resolved before human QA | Run the documented `pnpm fixture:phase8b -- /tmp/rdc-phase8b-qa`; pnpm 11 preserved `--`, which the script mistook for the target | Generator output pointed at the repository's `--/` directory | `a2e32c9` | Parser unit test, real documented command, complete Phase 8a gate |
| P8B-002 | MVP-blocking visual structure; resolved on macOS | Open the clean default 800×600 window: the initial responsive breakpoint expanded navigation into a full-width top panel; product identity and Add/Clone actions were duplicated; the collapse control became detached from a left rail; the collapsed state lacked persistent section controls/current-value descriptions; and the workspace empty state lacked the requested real Create action. Later reviews found a short title bar, a collapse control that jumped to the far edge, a content-height sidebar, an empty action group sitting too low, and collapsed controls styled as offset floating buttons with an oversized expand control. | Current and three annotated screenshot rounds plus collapsed-rail direction supplied during cycle-one review; decisions transcribed into `baseline-layout-checklist.md` | Baseline implementation: permanent left rail, live icon controls, RDC identity, compact three-action empty state and native repository initialization. Refinements: taller overlay bar, full-height sidebar, top-aligned empty actions, stable centered rail alignment, equal-sized borderless rail controls and contextual tooltips. | Codex verified the final equal-size macOS rail plus an exact dimension assertion in the green 23-test container E2E suite; Jose approved the macOS baseline on 2026-07-31. Linux and Windows remain separate platform gates. |
| P8B-003 | MVP-blocking selected-repository foundation; resolved on macOS | Select `primary` in Light theme and compare 1100×720, 800×600 and 620×720 with the sidebar expanded. The native title already says `RDC — primary — main`, while the dark toolbar duplicates repository name/path, gives four local and three remote actions nearly equal weight across height-changing rows, and leaves Changes/History as a separate generic button strip. At 620px the horizontally overflowing local-action row is clipped at its leading edge, making controls partly or wholly unreachable. | Before captures: `/tmp/rdc-gate-a-normal-light-before.png`, `/tmp/rdc-gate-a-800-light-before.png`, `/tmp/rdc-gate-a-620-light-before.png`. Iteration 1: `/tmp/rdc-gate-a-toolbar-iteration-1-normal.png`, `/tmp/rdc-gate-a-toolbar-iteration-1-620.png`, `/tmp/rdc-gate-a-toolbar-iteration-1-620-collapsed.png`. Iteration 2: `/tmp/rdc-gate-a-toolbar-iteration-2-normal.png`; Gate C iteration 3 records the final view-navigation placement. | Removed duplicated identity/remote copy; aligned a fixed-height subtle command bar with a right-aligned borderless sidebar control and a short visible seam; grouped four local and three remote Font Awesome controls with localized-name-compatible icon-only geometry and contextual tooltips; reserved a non-displacing status line; and placed Changes/History in their own separated toolbar group with explicit selected state and compact icon condensation. | Jose accepted the macOS toolbar baseline on 2026-07-31. Automated E2E locks equal bar/control/separator geometry, selected view treatment and no compact overflow in both sidebar states. Linux and Windows repeat Gate A independently. |
| P8B-004 | MVP-blocking left-pane design foundation; resolved on macOS | Select `primary` in Light theme at 1100×720, 800×600 and 620×720. The pane remained at its 21 rem maximum at every width, consuming about 44% of the compact window; repository selection, its overflow action, branch selection and branch creation all used equally heavy bordered controls. | Before: `/tmp/rdc-gate-b-left-pane-before-1100.png`, `/tmp/rdc-gate-b-left-pane-before-800.png`, `/tmp/rdc-gate-b-left-pane-before-620.png`. Iteration 1: `/tmp/rdc-gate-b-left-pane-iteration-1-1100.png`, `/tmp/rdc-gate-b-left-pane-iteration-1-620.png`. Iteration 2 repository capture: `/tmp/rdc-gate-b-repositories-iteration-2-fullscreen.png`. | Iteration 1 uses a 15–21 rem responsive pane tied to viewport width and reduces the original heavy form treatment. Iteration 2 adopts the useful upstream repository-selector patterns and establishes the exclusive accordion. Iteration 3 gives Branches filter, aligned icon-only New branch action with a transient create row, local navigation rows and current-row emphasis; remote refs remain fetch state rather than inert UI. Iteration 4 restores upstream's clearer Default/Recent/Other visual language with real data: the recorded remote `HEAD` identifies Default Branch, the existing native reflog command supplies Recent Branches, and remaining local refs form Other Branches. Unknown or empty groups are omitted rather than guessed. Relative activity, Pull Requests, merge selection and branch context actions remain deferred. | Jose accepted the macOS left-pane baseline on 2026-07-31 after verifying the repository and branch expansion flows, filters, aligned branch action, local-only branch surface and final grouping. The green 24-test native E2E suite locks exclusive expansion, fixed sibling headers, large-list bounds, checkout/create/fetch behavior and remote-ref exclusion. Linux and Windows repeat Gate B independently. |
| P8B-005 | MVP-blocking Changes workspace foundation; resolved on macOS | Select `primary` in Light theme at 1100×720, 800×600 and 620×720. The original wide layout had viable file/diff/commit placement but generic full-label actions and no selected-file heading. Below 52 rem it changed to an unbounded page with 12 rem files, an 18 rem minimum diff and an automatic commit row; at 800×600 the commit action fell below the window, while the workspace parent clipped the overflow. | Before: `/tmp/rdc-gate-c-changes-before-1100.png`, `/tmp/rdc-gate-c-changes-before-800.png`, `/tmp/rdc-gate-c-changes-before-620.png`. Iteration 1: `/tmp/rdc-gate-c-changes-iteration-1b-1100.png`, `/tmp/rdc-gate-c-changes-iteration-1b-620-expanded.png`. Iteration 2: `/tmp/rdc-gate-c-changes-iteration-2-1100.png`, `/tmp/rdc-gate-c-changes-iteration-2-options-1100.png`, `/tmp/rdc-gate-c-changes-iteration-2-620.png`, `/tmp/rdc-gate-c-changes-iteration-2-620-collapsed.png`. Iteration 3: `/tmp/rdc-gate-c-changes-iteration-3-1100.png`, `/tmp/rdc-gate-c-changes-iteration-3-620-expanded.png`. | Preserve the familiar wide reading order while giving files, diff and commit explicit ownership. The file list and diff body now scroll independently below fixed contextual headers; compact filtering, include-all/count and accessible status glyphs replace generic rows; the diff names the selected file and runs edge-to-edge; and the bounded commit dock separates Summary/Description with a branch-aware action. Iteration 3 aligns the quiet gear and commit action in one footer row, moves Changes/History into a separated toolbar group with an explicit selected state, and preserves file-left/diff-right geometry at every width; toolbar view labels condense to accessible icons at compact width. Hooks are intercepted by default; **Bypass hooks** maps to `--no-verify` rather than changing hook environment. | Jose accepted the macOS Changes baseline on 2026-07-31 after three assisted iterations. TypeScript and all 944 frontend tests are green; the 25-test container E2E suite locks toolbar selection, compact condensation, permanent left/right pane ownership, bounded regions and the default hook-failure decision flow. Linux and Windows repeat Gate C independently. |
| P8B-006 | MVP-blocking History workspace foundation; resolved on macOS after iteration 5 | Select `primary`, activate History and compare 1100×720 with 620×720. Before iteration, commits and changed files read as generic cards, a redundant History heading consumed workspace space, the complete details pane shared one undifferentiated scroll, and compact width moved details below the commit list. Iteration 2 still stacked changed files above the diff, unlike the useful upstream file-left/diff-right reading order. Iteration 3 retained SHA in both commit navigation and details, split related commit metadata across regions, and rendered file status as words rather than sharing Changes' status language. Iteration 4's constructed square plus inner glyphs were not optically symmetrical. | Before: `/tmp/rdc-gate-d-history-before-1100.png`, `/tmp/rdc-gate-d-history-before-620-expanded.png`. Iteration 1: `/tmp/rdc-gate-d-history-iteration-1-1100.png`, `/tmp/rdc-gate-d-history-iteration-1-620-expanded.png`. Iteration 2 compact metadata correction: `/tmp/rdc-gate-d-history-iteration-2-620-expanded.png`. Iteration 3 nested split: `/tmp/rdc-gate-d-history-iteration-3-1100.png`, `/tmp/rdc-gate-d-history-iteration-3b-620-expanded.png`. Iteration 4 metadata/status refinement: `/tmp/rdc-gate-d-history-iteration-4-1100.png`, `/tmp/rdc-gate-d-history-iteration-4b-620-expanded.png`. Iteration 5 complete square glyphs against a representative real repository: `/tmp/rdc-gate-d-history-iteration-5-620-expanded.png`. | Adopt the useful upstream density without importing post-MVP Compare/search/history-mode features: edge-to-edge commit/file rows with explicit selection; commit navigation contains summary plus author/relative time, while details alone own short SHA and line totals; fixed metadata and bounded message; then changed files on the left and the selected historical diff on the right as sibling regions. Changes and History share one accessible status-icon component, now using Font Awesome `square-plus`, `square-minus` and `square-caret-up` as complete glyphs rather than composing an outer border with a baseline-sensitive inner character. Preserve both nested left/right relationships at compact width, omit the Changes-only diff-selection gutter, and truncate long metadata inside its region. | Jose accepted Gate D as the macOS baseline on 2026-07-31. TypeScript and focused App/relative-time tests pass; the real Linux/Tauri E2E suite passes 26/26 and locks both nested left/right relationships, bounded regions, independent commit/file/diff scrolling, semantic status names and retained commit/file selection across Changes → History → Changes → History. Linux and Windows repeat Gate D independently. |
| P8B-007 | MVP-blocking top-level resize refinement; resolved and accepted on macOS | Annotated minimum-size review showed that the former 620 px QA endpoint made every pane arbitrarily narrow, neither vertical seam was adjustable, and the Commit action repeated the already-visible branch. The follow-up History review required equivalent control without changing the established global floor. A final recording exposed sidebar movement and multi-paint History transitions while switching views. | `/Users/josegutierrez/Desktop/fixxes-003.png`; `/Users/josegutierrez/Desktop/fixxes-004.png`; `/Users/josegutierrez/Desktop/Screen Recording 2026-08-01 at 09.00.18.mov`; minimum-size captures `/tmp/rdc-gate-e-changes-minimum-resizers.png` and `/tmp/rdc-gate-e-history-minimum-resizers.png` | Keep the native floor at 715×356. Constrain the expanded sidebar, Changes pane and diff to 125/190/300 px; constrain History's commit list, changed-file list and diff to 190/150/220 px. Add shared pointer- and keyboard-operable separators for every seam; move compact condensation to the reachable 46 rem threshold; retain the included-file count while removing only the branch suffix from the Commit action. Keep the sidebar width stable across views and prepare History's complete fresh state while its mounted tree remains hidden before revealing it. The sidebar separator has a two-stage gesture in both directions: it first stops at the 125 px expanded minimum, then collapses after 350 ms of continued leftward pressure; the collapsed rail retains the seam and expands after the same rightward dwell. Release or reversal cancels either transition. | Jose accepted Gate E as the macOS baseline on 2026-08-01. Frontend tests pass 950/950; TypeScript, lint and formatting are clean; Linux/Tauri E2E passes 27/27 and pins both History minima/resizers, the native floor, Changes constraints, sidebar stability, selection retention and maximize/restore. Linux and Windows repeat Gate E independently. |

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|
| None recorded yet | — | — |

## Decision

- [ ] No agreed MVP blocker remains; foundation is accepted, but visual/functional/Linux/package QA
      remains pending.
- [x] Every preparation fix passed Phase 8a again.
- [x] Every affected shell and selected-repository foundation check was repeated on macOS.
- [ ] Final packages passed the focused smoke pass.
