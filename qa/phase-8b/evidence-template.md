# Phase 8b evidence record

- Commit:
- Tester:
- Date/time:
- Platform and version:
- Desktop/session and compositor:
- Architecture and display scale:
- Development build command or package SHA-256:
- Fixture manifest path(s) and purpose:

## Automated prerequisite

- `pnpm qualify:phase8a`:
- `pnpm test`:
- `pnpm exec tsc --noEmit`:
- `pnpm format:check`:
- `pnpm lint`:
- `pnpm build`:
- `pnpm check:bundle-boundary`:
- `pnpm test:e2e`:
- `cargo test --workspace`:
- `cargo clippy --workspace --all-targets -- -D warnings`:
- `cargo fmt --check`:

## Human results

- Shell/empty-state baseline:
- Selected-repository Gate A — context/toolbar/navigation:
- Selected-repository Gate B — left-pane design:
- Selected-repository Gate C — Changes workspace frame:
- Selected-repository Gate D — History workspace and cross-frame stability:
- Selected-repository Gate E — top-level resizing behavior:
- Visual matrix:
- Read-only/reversible local journeys and Git CLI oracle:
- Destructive/commit/conflict journeys and Git CLI oracle:
- Local-bare and system-credential remote journeys:
- Failure/recovery presentation:
- Native integrations, multi-window, accessibility and lifecycle:
- Config/log locations and secret-free final log review:
- Final icon, identifier and Preview/Beta presentation decision:
- Final package smoke (only after development-build acceptance):

## Issues

| ID | Classification | Reproduction | Evidence | Owner/fix commit | Retest |
|---|---|---|---|---|---|

## Accepted deviations

| Behavior | Reason | Later owner |
|---|---|---|

## Decision

- [ ] No agreed MVP blocker remains.
- [ ] Every fix passed Phase 8a again.
- [ ] Every affected human check was repeated.
- [ ] Final packages passed the focused smoke pass.
