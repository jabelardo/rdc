# Remaining work

**What this file is for.** `MIGRATION_PLAN.md` (~3,350 lines) and `MIGRATION_MAP.md` (~1,530 lines)
are the *historical record*: why each decision was made, what was measured, which upstream
assumptions turned out wrong. That content is worth keeping and worth reading — but roughly 250 of
those 4,900 lines describe work that is still open, and Phase 8b's QA cycle should not begin with
archaeology. This file is the open list only, and it links back rather than duplicating.

Keep it short. When something closes, delete the entry rather than annotating it — the plan and the
commit history already record what happened.

---

## Where the MVP stands

Phases 0–4, 5a, 6a, 7a–7e and 8a are closed. Phase 8a first closed on 2026-07-30 and closed again
after its 2026-07-31 pre-QA follow-up added mechanical Node/bundle/format/lint/Windows-portability
guards, independent E2E suites, Tailwind and a component-owned application shell. **Phase 8b is now
the next MVP phase and the only human-blocked phase.**

Since cycle one's Linux findings landed, Phase 8b's own scope moved: `17df5bf` put the native menu
on every platform (see "QA cycle 2" below), and a real MVP-blocking freeze found in that same cycle
— opening a context menu on real Wayland, then switching focus away, wedged the app until the OS
killed it — is now fixed by bypassing muda's blocking popup on Linux entirely. Full account in
`MIGRATION_PLAN.md`'s Phase 8b log, "Linux context-menu freeze, found and fixed."

**Cycle one's own findings — a UI foundation gap and one functionality gap — are now being closed
before cycle two starts**, deliberately: see "Engineering, this pass" below.

| Gate | State (2026-08-15) |
|---|---|
| `pnpm test` (Vitest) | 1,234 passing / 138 files |
| `pnpm exec tsc --noEmit` | clean |
| `pnpm format:check` / `pnpm lint` | clean |
| `pnpm build` / `pnpm check:bundle-boundary` | clean; 157 browser-reachable modules, no Node built-ins |
| `cargo test --workspace` | 1,274 passing |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| Windows `git-ops --all-targets` compile guard | clean |
| `pnpm test:e2e` (Linux container) | 42 tests / 19 suites passing |
| `pnpm qualify:phase8a` | green, `"errors": []` |

---

## Next: Phase 8b — human-assisted QA and refinement

An **iterative QA/fix cycle**, not an approval ceremony. Full description at
`MIGRATION_PLAN.md` §"Phase 8b"; prepared fixtures and checklists in `qa/phase-8b/`.

The loop: run the prepared checks against current macOS and real-Wayland Linux development builds →
fix every agreed MVP-blocking defect, adding automated regression coverage wherever the behaviour
can be pinned without human judgement → rerun the **complete** Phase 8a gate and repeat every
affected human check. Package **last**, only once no agreed blocker remains.

Cycle one now has two explicit foundation levels. The shell/empty-state gate in
`qa/phase-8b/baseline-layout-checklist.md` was accepted on macOS on 2026-07-31 after three annotated
refinement rounds. Gates A and B established the macOS repository toolbar and left-pane baselines on
2026-07-31. Gates C and D are accepted. **Gate E was accepted on macOS on 2026-08-01:** it established
the native 715×356 floor, resizable sidebar/Changes/History panes, stable sidebar geometry across
views, and a prepared History transition without intermediate repainting. All five selected-
repository foundation gates now pass, so macOS proceeds to the visual matrix and functional
checklist. Linux repeats all foundation gates in real-Wayland QA; the macOS result is a reference,
not transferable evidence. Windows repeats them in Phase 10.

Before either platform begins functional journeys, it now runs the shared
`qa/phase-8b/menu-mvp-alignment-checklist.md`. Existing automation proves enabled menu leaves have
executors; this human gate verifies that the inventory, state-dependent enablement, labels,
accelerators, destinations and hidden/deferred commands are themselves aligned with the MVP.

Human judgement is required for: visual refinement (hierarchy, density, alignment, empty/loading/
error states, diff readability) at normal and compact sizes in Light/Dark/System; the final icon,
bundle identifier and preview presentation (`org.rdc` and the current icon are explicitly
provisional); the native macOS pass, since WKWebView has no `tauri-driver` backend so the recorded
checklist *is* the evidence; and a real Wayland session (recorded so far on Fedora 44/Bluefin,
`linux-wayland-checklist.md`'s originally-planned Ubuntu 26.04 also satisfies it) to qualify
rendering and the `WEBKIT_DISABLE_COMPOSITING_MODE=1` mitigation outside the Xvfb harness.

**MVP exit criteria** are enumerated at `MIGRATION_PLAN.md` §"macOS/Linux MVP exit criteria" — seven
items, unchanged; do not restate them here, satisfy them there.

---

## Open engineering items

### Engineering, this pass — before QA cycle 2

Deliberately sequenced ahead of the QA-cycle-2 item below: rdc is greenfield and not racing an MVP
date, so the priority right now is architectural foundation (easy for a future open-source
collaborator to pick up post-MVP), not minimizing the current diff. In dependency order:

1. **[`UI_FOUNDATION_PLAN.md`](./UI_FOUNDATION_PLAN.md) — complete.** shadcn/Radix is rdc's UI
   foundation: tooling, the full token migration, the sonner-backed toast, every dialog on Radix
   with the hand-rolled `Modal` deleted, and the Tooltip rebuilt on Radix's primitive. Phase 3's
   boundary clearance is a computed `sideOffset` rather than `collisionBoundary` — the two are
   opposite operations, measured in the sub-slice 3.0 spike and recorded there. Delete this entry
   once nothing else references it.

2. **[`MESSAGE_SYSTEM_PLAN.md`](./MESSAGE_SYSTEM_PLAN.md)** — the unified error/warning/info toast
   system. **In progress.**

   Phase 8b cycle 2 photographed why it matters: one `getStatus` failure on a deleted repository
   directory rendered three times at once, in three visual styles, one of them `[object Object]`.

   Landed: Slice 0.1 (message coalescing with a repeat count), Slice 5 (`remote-store` — the
   toolbar's error paragraph is gone entirely; that slot was `nowrap` with an ellipsis and could
   never hold a sentence), Slice 6 (`conflict-store` — both banner blocks gone), the toast severity
   colours, and the repository-availability gate that stops five stores each discovering a deleted
   directory in their own words.

   Remaining: **Slice 2** (`working-tree-store` — the screenshot's third panel, and the one that
   completes the cross-store duplication check), then 3, 4, 7. **Slice 1 stays blocked** on the open
   in-dialog-failure decision; `remote-store`'s `managementError` and `conflict-store`'s
   `loadFailed` are the deliberate remnants that go with it.

   Measured now: **15** `.application-error` references (down from 17) and **15** live
   `String(error)` sites, each a latent `[object Object]`.

3. **[`BRANCH_OPERATIONS_PLAN.md`](./BRANCH_OPERATIONS_PLAN.md) Slice 4 — abort merge.** Recorded as
   the one functionality gap against the 7 MVP exit criteria — a user could complete a conflict but
   never back out of one in-app. **Most of it has since closed from an unexpected direction:**
   `OPERATION_PROGRESS_PLAN.md` Slice 18's restart recovery added the `Abort merge` button
   (`merge-conflicts.tsx:160-163`) wired through `abortMergeRecovery` in `use-app-controller.ts`, so
   the exit-criteria gap itself is closed.
   What remains is the **menu id and its dispatch** — there is still no menu route to the action —
   and, if wanted, a `conflict-store.ts` method: the controller calls the `abortMerge` IPC directly
   rather than going through the store like its neighbours. **Stage 4; independent, any time.**

4. **[`OPERATION_PROGRESS_PLAN.md`](./OPERATION_PROGRESS_PLAN.md) Slice 20 — documentation and
   closure.** Slices 1–19 have landed and were re-verified against the code on 2026-08-15:
   repository-scoped native operation registry, process-tree cancellation, inactivity watchdogs,
   multi-window routing and the unified progress presentation. What is left is documentation, the
   store-surface measurement, and **writing this work's QA rows** — the Light/Dark and compact rows
   for the unified dialog, the owner/observer, timeout and recovery-required states, and a
   multi-window checklist that `qa/phase-8b/` does not have today, with its fixture requirements in
   `fixture-scenarios.md` so Phase 8a can prepare them. **Stage 6; independent, but it must land
   before QA cycle 2 walks those rows.**

5. **[`CODE_ORGANIZATION_PLAN.md`](./CODE_ORGANIZATION_PLAN.md) — establish a layout and enforce
   it.** Scheduled **after** the dialog migration, so it moves settled code rather than code in
   flight. Dialogs currently live in four places by accident of chronology, and `src/lib/` is a
   110-file flat drawer mixing pure helpers, IPC wrappers, domain logic and desktop-plus's GitHub
   service code — beside subdirectories that *are* grouped, so the repository demonstrates two
   conventions and follows neither. Measured on 2026-08-07: **95 of 237 non-test modules are
   unreachable from `src/main.tsx`**, of which the 30 directly under `src/lib/` are genuinely
   unreferenced (`refs.ts`, `create-branch.ts`, `rebase.ts` have no non-test importer; `api.ts`
   forms a dead cluster with three models). The `src/models/` share of that number is largely a
   false positive — `import type` is erased, so type-only modules read as unreachable while being
   in use. The plan document holds the inventory and the questions; it deliberately decides
   nothing yet. **Stage 5; after the dialog migration.**

**LICENSE (MIT) is added**, copyright holder Jose Gutierrez. `CONTRIBUTING.md`, issue/PR templates,
README polish and an `ARCHITECTURE.md` newcomer overview are deliberately deferred to the
post-MVP promotion phase, once the project is actually accepting contributions — recording that as
a decision, not an oversight. `ARCHITECTURE.md` depends on item 5: there is no point documenting a
structure nobody chose.

### QA cycle 2

6. **Native-menu-dispatch verification, on both platforms.** The branch-operations MVP blocker
   itself is closed — `BRANCH_OPERATIONS_PLAN.md` Slices 1–3 landed rename, delete, discard-all
   (×2) and merge initiation, all gated-green and capability-parity tested across
   `macos`/`windows`/`linux`. (`update-branch-with-contribution-target-branch` stays deferred to
   Phase 7f, unchanged.) What's left is proving these — plus the five capability-parity actions
   from `qa/phase-8b/evidence/menu-mvp-alignment-findings.md` F-MENU-003, item 3's abort-merge
   action once it lands, and the message system's toast accessibility once item 2 lands — actually
   dispatch from the *native* menu, which nothing automated can do: `17df5bf` moved Linux from an
   in-window DOM menu bar onto Tauri's native menu on every platform, so Linux lost its
   WebDriver-testable surface the same way macOS never had one. Run `qa/phase-8b/macos-checklist.md`
   §7 and `qa/phase-8b/linux-wayland-checklist.md`'s equivalent section to close it.
7. **Discard-all at scale, on Fedora.** New `discardMany99` and `discardMany1000` fixture scenarios
   plus a table in `qa/phase-8b/dialog-migration-checklist.md`. Two counts because `VirtualList`
   virtualizes past 100 rows: 99 keeps every row in the DOM, 1000 windows them, and the failure being
   guarded against is a list that looks right at 99 and is empty or unscrollable at 1000. It is
   *only* verifiable by hand — discard-all is reachable solely from the native menu, which item 6
   above is about. The pass must also record the perceived duration of a confirmed 1000-file discard:
   removals are now one batched IPC call, but there is deliberately no progress indicator and no
   cancel (Convention 8 refuses every dismissal mid-operation), and that measurement is the input to
   deciding whether progress reporting is needed before MVP.
8. **Produced-package inspection is not automated yet.** `pnpm qualify:phase8a` deliberately audits
   inputs and reports `finalPackagesProduced: false`; no current command opens the macOS/Linux bundle
   outputs and checks identity, resources, sidecar permissions and legacy destinations. Phase 8b's
   plan explicitly requires automated metadata/resource/package smoke. Add that reproducible check
   after final icon/identifier and concrete bundle targets are chosen, before treating the manual
   `final-package-smoke.md` pass as sufficient.
9. **One Windows body remains** — `custom_integration`'s `has_execute_access`. The three platform
   seams themselves are done (`AGENTS.md` rule 11): `rdc-printenvz`'s two arms now share a
   signature, `cli_installer`'s symlink is behind a per-OS `link` module with both arms real, and
   `custom_integration`'s unix code is in a gated inner module. What is left is a genuine Phase 10
   *decision*, flagged by a `compile_error!` rather than guessed: "executable" on Windows means
   `PATHEXT` membership or a DACL `AccessCheck`, not a mode bit. Adding it is additive.

---

## Carried debt

- **Tailwind 4 debug CSS source maps are incomplete.** A debug Tauri/Vite build emits Rolldown's
  `Sourcemap is likely to be incorrect` warning for `@tailwindcss/vite:generate:build` when
  `src/App.css` contains real Tailwind roots. The production build is quiet, the generated JavaScript
  map was traced back to both `App.tsx` and `use-app-controller.ts`, and application output is
  unaffected; the missing fidelity is CSS-to-source mapping in development tools. Enabling
  `css.devSourcemap` only moves the warning to Vite's CSS transform and emits no usable standalone
  CSS map, so do not suppress the warning or disable the working JavaScript maps. Recheck after
  Tailwind/Vite/Rolldown upgrades; upstream context is Tailwind
  [discussion #16119](https://github.com/tailwindlabs/tailwindcss/discussions/16119) and
  [issue #19930](https://github.com/tailwindlabs/tailwindcss/issues/19930). This is not an MVP
  runtime or packaging blocker.
- **Legacy `url.parse()` — 8 sites** in `api.ts` (3), `find-account.ts` (3), `parse-app-url.ts` (1),
  `repository-matching.ts` (1). `DEP0169`, security-relevant, and the WHATWG `URL` migration is a
  strict behaviour change that needs its own change with tests as the guard. **None of these modules
  ships in the MVP bundle** (verified), so the deprecation warnings visible during `pnpm test` come
  from Vitest importing them, not from the application. Correct time to fix each: the phase that
  lands its consumer — Phase 5b for the API/account modules, Phase 9 for `parse-app-url`. The
  blocking browser bundle-boundary CI check is what keeps that deferral honest.
- **Node `path` in `lib/repository-matching.ts`** — same boundary, same guard.
- **OAuth callback still points at `https://desktop-plus.org/oauth`** (`lib/api.ts`). Unlike the
  User-Agent and About copy, this cannot simply be renamed: it needs an rdc-owned domain and a
  registered OAuth application. Phase 9, travelling with the GitHub sign-in consumer.
- **Two names are deliberately *not* rebranded**, because they are bytes inside a user's repository
  that other clients read: `git-ops`'s `STASH_ENTRY_MARKER` (`!!GitHub_Desktop`) and
  `models/remote.ts`'s `ForkedRemotePrefix` (`github-desktop-`). Both carry comments explaining why.
  See `MIGRATION_PLAN.md` principle 6 — config and UI are rdc's to choose, repository bytes are not.

---

## Post-MVP backlog

One line each; detail lives in the plan under the same heading.

| Phase | Scope |
|---|---|
| 5b | Authenticated media + GitHub collaboration (retires `update-accounts`) |
| 5c | Enterprise networking — PAC/proxy resolution, certificate trust. Highest architectural risk in the plan; no longer blocks the UI |
| 6b | Consent-aware crash/error reporting pipeline |
| 7f | UI and upstream parity: accounts, stashes, tags, advanced merge/rebase, worktrees, LFS, submodules, syntax-highlighted diffs, full xterm, spell checking. History operations (reset hard/mixed/soft, revert, cherry-pick, checkout-commit, amend) are scoped in [`HISTORY_OPERATIONS_PLAN.md`](./HISTORY_OPERATIONS_PLAN.md), with the backend-complete inventory itemised there |
| 9 | Public release engineering: signing, notarization, updater key/endpoint, single-instance/deep-link routing, OAuth callback, standalone CLI |
| 10 | Windows support — six work groups. `git-ops`'s library already compiles for `x86_64-pc-windows-msvc` and CI keeps it that way |

---

## Accepted gaps

- **No automated native-Wayland coverage.** The E2E harness is X11 (Xvfb) only, while current
  desktop environments are Wayland-only — so the rendering path most users hit has no automated
  test, and the mitigation is a blanket `WEBKIT_DISABLE_COMPOSITING_MODE=1`. Compensated by the
  Phase 8b real-Wayland checklist. This should be a named limitation in the MVP release notes, with
  a decision recorded for what happens if 8b finds Wayland-only defects.
- **No PAC/proxy or application-managed certificate trust** (Phase 5c). Remote operations must fail
  with actionable copy rather than pretending; MVP release notes should say so.
- **`models/popup.ts` and `models/repository.ts`** remain blocked on their consumers
  (`MIGRATION_MAP.md` §9); `models/popup.ts` additionally needs a certificate type from Rust.
