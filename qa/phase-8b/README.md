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

3. Read that target's `fixture-manifest.json`, but do not add `primary` until the clean
   shell/empty-state gate has been captured. The fixture contains local modified/untracked files, a
   bare `origin` one commit ahead, a separate publisher, and the unpublished `publish-me` branch.
   Never reuse a fixture after a discard, commit, pull, push or conflict-resolution journey for a
   check that assumes the initial manifest. Create a new uniquely named target instead—the generator
   deliberately refuses to replace an existing directory. Linux always gets its own fixture.
4. Copy `evidence-template.md` for the run. Record the commit, OS, desktop/session, build mode,
   display scale and fixture path before testing.

## Cycle

1. Complete `baseline-layout-checklist.md` first for the shell and empty state.
2. Select the generated fixture and complete all five gates in
   `selected-repository-baseline-checklist.md`. Do not spend visual or functional checklist budget on
   a toolbar/navigation/workspace frame whose structure is still expected to change.
3. Once both foundation checklists pass, complete the visual matrix before functional workflows.
4. Run the platform checklist's functional groups in dependency order: read-only, reversible local,
   mutating local, remote, failure/recovery, integrations/accessibility/lifecycle. After every
   mutating group, verify the claimed result with Git CLI commands as well as the UI.
5. Record every issue with reproduction steps and evidence. Classify it as MVP-blocking, accepted
   non-blocking, or deferred with a named owner.
6. Implement agreed fixes and add automated regression coverage wherever human judgment is not
   essential.
7. Rerun the complete Phase 8a gate, refresh both development builds and repeat affected human checks.
8. Repeat until no agreed MVP blocker remains.
9. Settle the final icon, bundle identifier and release presentation (whether/how version 0.1.0 is
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
3. Select `primary` and complete Gate A, Gate B, Gate C, Gate D, then Gate E, in
   `selected-repository-baseline-checklist.md`. These are blocking foundational design passes, not
   functional tests.
4. Complete the macOS rows of `visual-matrix.md`: normal, default and compact Light first, then
   Dark/System and accessibility variants. Do not repeat every workflow in every visual cell.
5. Complete `macos-checklist.md` in its numbered functional order.
6. Classify and fix macOS findings. Any code change invalidates the recorded green prerequisite:
   rerun all of Phase 8a and repeat every affected macOS check before moving on.
7. On a real Ubuntu 26.04 Wayland session, create a new Linux-specific fixture, repeat both
   foundation checklists, then complete `linux-wayland-checklist.md` plus the Linux visual rows. Xvfb
   E2E remains a prerequisite, never a substitute.
8. Repeat the fix/regression/recheck loop across both platforms until neither has an agreed MVP
   blocker. Only then choose final identity/icon values and enter `final-package-smoke.md`.

Do not wait for the Linux session before starting macOS evidence, and do not interpret a clean macOS
cycle as permission to package: both native-platform records are required.

Before steps 4–5, close `REMAINING.md`'s fixture-expansion item. The current single-primary manifest
does not yet provide independent discard/commit/conflict scenarios or a deterministic transient state,
so proceeding as written would force the human tester to invent setup and would make the evidence
non-reproducible.

The phase closes only when the evidence record links all completed matrices/checklists, every blocker
is resolved, accepted deviations are explicit, and the final packages pass their focused smoke pass.
