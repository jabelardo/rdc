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

**Cycle one's findings are closed.** The UI foundation gap, the message-system gap and the one
functionality gap all landed on 2026-08-15: shadcn/Radix is the foundation with no hand-rolled primitives left, and every store-owned
error field has become either a toast or a dialog-owned inline failure — `.application-error` is at
zero, from 17. Abort merge is reachable from the conflict banner and the
Branch menu, so MVP exit criterion 3 — recovering from a conflict without being stranded — is
satisfied in-app.

| Gate | State (2026-08-16) |
|---|---|
| `pnpm test` (Vitest) | 1,123 passing / 128 files |
| `pnpm exec tsc --noEmit` | clean |
| `pnpm format:check` / `pnpm lint` | clean |
| `pnpm build` / `pnpm check:bundle-boundary` | clean; 181 browser-reachable modules, no Node built-ins |
| `pnpm check:module-boundaries` | clean |
| `cargo test --workspace` | 1,274 passing |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| Windows `git-ops --all-targets` compile guard | clean (was failing; see below) |
| `pnpm test:e2e` (Linux container) | 42 tests / 19 suites passing |
| `pnpm qualify:phase8a` | green, `"errors": []` |

**The Vitest count fell from 1,269 and that is deletion, not loss.** 22 test files went with the
GitHub-service cluster and the dead conflict-status logic; 8 were added. Nothing is skipped: the
suite has zero `.skip`, `.only` or `todo`, and every one of the 125 test files under `src/` plus 3
under `scripts/` runs.

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

Sequenced ahead of the QA-cycle-2 items below: rdc is greenfield and not racing an MVP date, so the
priority is architectural foundation a future open-source collaborator can pick up, not minimizing
the current diff. The UI foundation, the message system and `OPERATION_PROGRESS_PLAN.md` closed on 2026-08-15;
`CODE_ORGANIZATION_PLAN.md` closed on 2026-08-16 — the layout is
[`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md), it is applied, and
`pnpm check:module-boundaries` fails the build on a violation. One item remains:

**No engineering items remain.** The last one, dialog width drift, was settled on 2026-08-16 as
`COMPONENT_MIGRATION_PROCESS.md` Convention 18: every width is a Tailwind step and every dialog
states its own, four tiers built around shadcn's own `sm:max-w-lg` default. `CODE_ORGANIZATION_PLAN.md`
closed the day before. **Phase 8b's QA cycle 2 is what is left.**

**LICENSE (MIT) is added**, copyright holder Jose Gutierrez. `CONTRIBUTING.md`, issue/PR templates,
README polish and an `ARCHITECTURE.md` newcomer overview are deliberately deferred to the
post-MVP promotion phase, once the project is actually accepting contributions — recording that as
a decision, not an oversight. `ARCHITECTURE.md` is now unblocked — the structure exists and is enforced — but stays deferred
to the post-MVP promotion phase along with the rest.

### QA cycle 2

2. **The multi-window operation rows have never been walked.**
   `qa/phase-8b/multi-window-checklist.md` is new, written by `OPERATION_PROGRESS_PLAN.md` Slice 20,
   and its fixtures (`multiWindowPushA`/`multiWindowPushB`) require a freshly generated root — an
   older fixture predates them. It deliberately does not repeat what `e2e/operation-windows.test.mjs`
   proves; every row is a judgement about whether a second window's situation is legible, plus the
   process-tree termination check that no UI can show. Cross-platform: run it on both.

3. **Native-menu-dispatch verification, on both platforms.** The branch-operations MVP blocker
   itself is closed — `BRANCH_OPERATIONS_PLAN.md` Slices 1–3 landed rename, delete, discard-all
   (×2) and merge initiation, all gated-green and capability-parity tested across
   `macos`/`windows`/`linux`. (`update-branch-with-contribution-target-branch` stays deferred to
   Phase 7f, unchanged.) What's left is proving these — plus the five capability-parity actions
   from `qa/phase-8b/evidence/menu-mvp-alignment-findings.md` F-MENU-003, abort merge — landed, and the only
   Branch item gated on repository state — and the message system's toast accessibility, actually
   dispatch from the *native* menu, which nothing automated can do: `17df5bf` moved Linux from an
   in-window DOM menu bar onto Tauri's native menu on every platform, so Linux lost its
   WebDriver-testable surface the same way macOS never had one. Run `qa/phase-8b/macos-checklist.md`
   §7 and `qa/phase-8b/linux-wayland-checklist.md`'s equivalent section to close it.
4. **Discard-all at scale, on Fedora.** New `discardMany99` and `discardMany1000` fixture scenarios
   plus a table in `qa/phase-8b/dialog-migration-checklist.md`. Two counts because `VirtualList`
   virtualizes past 100 rows: 99 keeps every row in the DOM, 1000 windows them, and the failure being
   guarded against is a list that looks right at 99 and is empty or unscrollable at 1000. It is
   *only* verifiable by hand — discard-all is reachable solely from the native menu, which item 3
   above is about. The pass must also record the perceived duration of a confirmed 1000-file discard:
   removals are now one batched IPC call, but there is deliberately no progress indicator and no
   cancel (Convention 8 refuses every dismissal mid-operation), and that measurement is the input to
   deciding whether progress reporting is needed before MVP.
5. **Produced-package inspection is not automated yet.** `pnpm qualify:phase8a` deliberately audits
   inputs and reports `finalPackagesProduced: false`; no current command opens the macOS/Linux bundle
   outputs and checks identity, resources, sidecar permissions and legacy destinations. Phase 8b's
   plan explicitly requires automated metadata/resource/package smoke. Add that reproducible check
   after final icon/identifier and concrete bundle targets are chosen, before treating the manual
   `final-package-smoke.md` pass as sufficient.
6. **One Windows body remains** — `custom_integration`'s `has_execute_access`. The three platform
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
- **The `url.parse()`, Node-`path` and OAuth-callback entries are gone**, discharged on 2026-08-16
  rather than fixed: every module carrying them — `api.ts`, `find-account.ts`, `parse-app-url.ts`,
  `repository-matching.ts` — was in the deleted GitHub-service cluster. `src/` now has **zero**
  `url.parse()` call sites. Phase 5b and Phase 9 will need a URL layer and an OAuth callback, and
  will write them against Tauri with WHATWG `URL` from the start.
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
