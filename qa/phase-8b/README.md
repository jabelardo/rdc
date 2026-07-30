# Phase 8b human-assisted QA

Phase 8b starts only from a green Phase 8a commit. It is an iterative QA/fix cycle, not a one-time
approval pass. Do not create the final macOS/Linux packages until the development-build cycle has no
agreed MVP blocker.

## Prepare

1. Run every repository gate, including `pnpm qualify:phase8a` and `pnpm test:e2e`.
2. Create a fresh fixture outside the repository:

   ```sh
   pnpm fixture:phase8b -- /tmp/rdc-phase8b-qa
   ```

3. Read `/tmp/rdc-phase8b-qa/fixture-manifest.json`. Add its `primary` repository to rdc. The fixture
   contains local modified/untracked files, a bare `origin` one commit ahead, a separate publisher,
   and the unpublished `publish-me` branch.
4. Copy `evidence-template.md` for the run. Record the commit, OS, desktop/session, build mode,
   display scale and fixture path before testing.

## Cycle

1. Complete the visual matrix and the platform checklist against development builds.
2. Record every issue with reproduction steps and evidence. Classify it as MVP-blocking, accepted
   non-blocking, or deferred with a named owner.
3. Implement agreed fixes and add automated regression coverage wherever human judgment is not
   essential.
4. Rerun the complete Phase 8a gate, refresh both development builds and repeat affected human checks.
5. Repeat until no agreed MVP blocker remains.
6. Settle the final icon and bundle identifier, package once, then run `final-package-smoke.md`.
   Packaging-only defects return through the same fix, Phase 8a, repackage and focused recheck loop.

The phase closes only when the evidence record links all completed matrices/checklists, every blocker
is resolved, accepted deviations are explicit, and the final packages pass their focused smoke pass.
