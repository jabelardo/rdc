# Phase 8b human-assisted QA

Phase 8b starts only from a green Phase 8a commit. It is an iterative QA/fix cycle, not a one-time
approval pass. Do not create the final macOS/Linux packages until the development-build cycle has no
agreed MVP blocker.

## Prepare

1. Run every repository gate, including `pnpm qualify:phase8a` and `pnpm test:e2e`.
2. Create a fresh, disposable fixture outside the repository for this platform and cycle:

   ```sh
   pnpm fixture:phase8b -- /tmp/rdc-phase8b-macos-cycle-1
   ```

3. Read that target's `fixture-manifest.json` and this directory's `fixture-scenarios.md`, but do not
   add the `populated` scenario until the clean shell/empty-state gate has been captured. The manifest
   owns independent paths for every mutating journey plus clean, populated, delayed-progress and
   failure states. Treat a scenario as consumed after its journey; generate a new uniquely named
   target to repeat it rather than repairing it by hand. Linux always gets its own fixture.
4. Copy `evidence-template.md` for the run. Record the commit, OS, desktop/session, build mode,
   display scale and fixture path before testing.

## Cycle

1. Complete `baseline-layout-checklist.md` first for the shell and empty state.
2. Select the generated `populated` scenario and complete all five gates in
   `selected-repository-baseline-checklist.md`. Do not spend visual or functional checklist budget on
   a toolbar/navigation/workspace frame whose structure is still expected to change.
3. Once both foundation checklists pass, complete the visual matrix, then
   `menu-mvp-alignment-checklist.md`, before functional workflows.
4. Run the platform checklist's functional groups in dependency order: read-only, reversible local,
   mutating local, remote, failure/recovery, integrations/accessibility/lifecycle. After every
   mutating group, verify the claimed result with Git CLI commands as well as the UI.
5. Complete `multi-window-checklist.md` after the platform checklist's remote group, which is where
   the operations it needs are first exercised. It is cross-platform — run it on both — and it
   deliberately does not repeat what `e2e/operation-windows.test.mjs` already proves; its rows are
   about whether a second window's situation is *legible*, which no test can judge.
6. Record every issue with reproduction steps and evidence. Classify it as MVP-blocking, accepted
   non-blocking, or deferred with a named owner.
7. Implement agreed fixes and add automated regression coverage wherever human judgment is not
   essential.
8. Rerun the complete Phase 8a gate, refresh both development builds and repeat affected human checks.
9. Repeat until no agreed MVP blocker remains.
10. Settle the final icon, bundle identifier and release presentation (whether/how version 0.1.0 is
   labelled Preview/Beta in About and package-facing metadata), package once, then run
   `final-package-smoke.md`.
   Packaging-only defects return through the same fix, Phase 8a, repackage and focused recheck loop.

## Immediate cycle-one order

Use the available macOS host first so the first human feedback arrives before arranging a separate
Linux machine/session:

1. Create the fixture and evidence record, then launch the macOS development build from the exact
   green commit recorded in that evidence.
2. With no registered repositories, complete the empty-state `baseline-layout-checklist.md`; the
   2026-07-31 macOS record already owns the first accepted result.
3. Select `populated` and complete Gate A, Gate B, Gate C, Gate D, then Gate E, in
   `selected-repository-baseline-checklist.md`. These are blocking foundational design passes, not
   functional tests.
4. Complete the macOS rows of `visual-matrix.md`: normal, default and compact Light first, then
   Dark/System and accessibility variants. Do not repeat every workflow in every visual cell.
5. Complete `menu-mvp-alignment-checklist.md`, then `macos-checklist.md` in its numbered functional
   order. The menu gate verifies the product inventory before the later journeys exercise it.
6. Classify and fix macOS findings. Any code change invalidates the recorded green prerequisite:
   rerun all of Phase 8a and repeat every affected macOS check before moving on.
7. On a real Ubuntu 26.04 Wayland session, create a new Linux-specific fixture, repeat both
   foundation checklists, then complete `linux-wayland-checklist.md` plus the Linux visual rows. Xvfb
   E2E remains a prerequisite, never a substitute.
8. Repeat the fix/regression/recheck loop across both platforms until neither has an agreed MVP
   blocker. Only then choose final identity/icon values and enter `final-package-smoke.md`.

Do not wait for the Linux session before starting macOS evidence, and do not interpret a clean macOS
cycle as permission to package: both native-platform records are required.

The fixture-expansion prerequisite is complete: schema 2 provides independent discard, commit,
conflict and remote repositories plus a bare-remote delay for deterministic progress inspection. Use
the named scenario mapping in `fixture-scenarios.md`; ad hoc state construction is not QA evidence.

The phase closes only when the evidence record links all completed matrices/checklists, every blocker
is resolved, accepted deviations are explicit, and the final packages pass their focused smoke pass.
