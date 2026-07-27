# desktop-plus → rdc Migration Plan (Electron → Tauri 2.0)

Source: `desktop-plus` (GitHub-Desktop-derived Electron app, Electron 42, React 16.8.4, dugite/git, keytar, Squirrel.Windows updater).
Target: `rdc` (Tauri 2.0 + React 19 + Vite, currently the untouched default scaffold).

## Guiding principles

1. **Tests move first, code follows.** Every phase below starts by porting the relevant `app/test/unit` tests to the new stack (failing/unimplemented), then writes the minimal Rust/TS to make them pass. This gives an objective "done" signal per module and prevents silent behavior drift from the original app.
2. **Mirror the source tree, don't reinvent it.** Every old path gets one obvious new path, tracked in a mapping table (`MIGRATION_MAP.md`, generated as we go — see below). Nobody should have to guess where `app/src/lib/git/commit.ts` ended up.
3. **Behavior parity before modernization.** Flag improvements (listed inline per phase) but don't block porting a module on a rewrite. Modernize in a fast-follow pass once parity tests are green.
4. **Native modules become Tauri commands/plugins, not FFI shims.** Don't try to `bind` to keytar/dugite from Rust — replace them with the idiomatic Rust/Tauri equivalent and re-verify behavior via the ported tests.

## Module mapping strategy

Create `rdc/MIGRATION_MAP.md` with one row per source module:

| Old path | Concern | New path | Status |
|---|---|---|---|

Populate it up front from the inventory below (all rows `not-started`), and flip status as PRs land. This is the single source of truth for "where did X go" — keep it more current than this plan doc.

### Directory mirroring convention

- `app/src/models/**` (63 files, pure TS, no Electron deps) → `rdc/src/models/**`, same filenames, kebab/camel-case preserved.
- `app/src/lib/**` pure-TS subset (parsers, formatters, stats, misc utils, markdown-filters, progress, hooks-that-don't-spawn) → `rdc/src/lib/**`, 1:1.
- `app/src/lib/**` Electron/Node-coupled subset (git, stores needing OS access, trampoline, ssh, shells, editors, ipc-renderer/shared) → split:
  - Business logic that becomes a Rust command → `rdc/src-tauri/crates/<concern>/src/**`
  - The thin TS-side caller that used to `ipcRenderer.invoke` → stays in `rdc/src/lib/**`, now calls `@tauri-apps/api/core::invoke`.
- `app/src/main-process/**` (28 files) → mostly Rust, split by concern into `rdc/src-tauri/src/commands/**` (IPC-equivalent handlers), `rdc/src-tauri/src/platform/**` (OS integrations: menu, notifications, window-state, registry), and `rdc/src-tauri/crates/*` (heavier standalone logic, e.g. git).
- `app/src/ui/**` (109 entries) → `rdc/src/ui/**`, 1:1 component-by-component; `dispatcher/` keeps its shape but calls `invoke`/`listen` instead of `ipcRenderer`.
- `app/test/unit/**` → mirrored: Rust-side logic tests → `rdc/src-tauri/crates/<concern>/tests/` or `#[cfg(test)]` inline; TS-side tests → `rdc/src/**/*.test.ts(x)` colocated (Vitest), same relative structure as today's `app/test/unit/`.

### Rust workspace layout (src-tauri)

Use a Cargo workspace, not one flat crate — mirrors the old `main-process`/`lib` separation and keeps each concern independently testable:

```
src-tauri/
  Cargo.toml            # workspace root
  src/                  # the tauri binary: command registration, app setup, menu, window mgmt
    main.rs / lib.rs
    commands/           # #[tauri::command] handlers, one module per old ipc-shared.ts channel group
    platform/           # macOS/Windows/Linux-specific: notifications, registry, window-state, keychain
  crates/
    git-ops/            # replaces app/src/lib/git/** (45 files) — process-spawning wrapper around system git
    models/             # domain types shared with frontend (optionally codegen'd to TS)
    stats/              # telemetry, mirrors app/src/lib/stats
    trampoline/          # askpass/credential-helper sidecar, mirrors app/src/lib/trampoline + ssh
```

Rust conventions to enforce in review: `thiserror` for library error enums, `anyhow` only at the command boundary, no `unwrap`/`expect` outside tests, `tokio` for async process spawning (git, trampoline), commands return `Result<T, String>` (or a serializable error type) — never panic across the IPC boundary, `#![warn(clippy::all)]` in each crate, unit tests colocated per Rust convention (not a mirrored `tests/` tree, since Cargo idiom differs from the old JS layout — note this one deliberate deviation in the mapping doc).

## Phased plan

### Phase 0 — Tooling parity (no app logic yet)
- Add Vitest to `rdc` (replaces the old Node-builtin `node --test` runner — an improvement: better watch mode, jsdom, coverage, matches Vite tooling already in `rdc`).
- Add `cargo test` + `cargo clippy` + `cargo fmt --check` to whatever CI you set up for `rdc`.
- Stand up `MIGRATION_MAP.md` from the inventory above.
- **Decided: E2E uses `tauri-driver`** (WebDriver protocol). Consistent with the project's primary target being Linux for both development and end-user usage, even though the migration is starting on a Mac. `tauri-driver` has no macOS support (no WebDriver backend for WKWebView), so this isn't optional: E2E cannot run against a native macOS build at all.
- **Enforced: all E2E runs happen inside a Linux container, on every host, no exceptions.** This isn't just a fallback for Mac devs — it's the only supported path, so CI and every developer machine (Mac or Linux) exercise the identical environment and there's no "works on my Mac" drift for the one platform (Linux) users will actually run.
  - Provide a `docker-compose.e2e.yml` (or a `Dockerfile.e2e`) that builds the Tauri app for Linux, installs `tauri-driver` + WebKitWebDriver + a headless X server (`xvfb`), and runs the Playwright/WebDriver suite inside the container.
  - `package.json`'s `test:e2e` script must not shell out to a locally-installed `tauri-driver` at all — it should only ever invoke `docker compose -f docker-compose.e2e.yml run --rm e2e`, so there is no code path that "accidentally" runs E2E on bare macOS. Running the underlying tools outside the container is unsupported, not just discouraged.
  - CI uses the same image/compose file as local dev (build once, reuse), so parity is structural rather than a convention people have to remember.
  - Mac devs need Docker Desktop (or an equivalent Linux container runtime) as a hard prerequisite for running E2E locally; document this in the repo's setup instructions, not just in this plan.
  - **This harness runs entirely over X11 (Xvfb)** — it does not exercise native-Wayland WebKitGTK rendering, which is the only rendering path real users on the primary target actually hit. See Phase 3.5 for why, and for the accepted gap here.

### Phase 1 — Port models + pure-TS lib (test-first)
- Copy `app/test/unit/` tests for `models/**` and the pure-TS `lib/**` utils verbatim into `rdc/src/**` (adjust imports only), run them red.
- Copy the corresponding source files, fix the 3 models using Node's `path` (`repository.ts`, `worktree.ts`, `cloning-repository.ts`) to use a small path-utils shim (or `@tauri-apps/api/path` where actually needed at runtime — for pure string manipulation, a tiny local helper is enough, don't pull in a Tauri API for something that doesn't need the OS).
- This phase is almost entirely mechanical and de-risks nothing architecturally, but it's the fastest way to get a green test suite running end-to-end early, which is valuable for morale and CI setup.

### Phase 2 — Git backend (`git-ops` crate)
- Port `app/test/unit/git/**` (45 files, largest single test category) as the acceptance spec for `crates/git-ops`.
- **Keep shelling out to the system `git` binary** (Rust `tokio::process::Command`), do **not** switch to `git2`/libgit2. This mirrors dugite's own deliberate choice — libgit2 has known gaps with LFS, credential helpers, partial clone, and hook execution that real desktop Git clients depend on. Reimplementing dugite's spawn/parse logic in Rust is more work than a libgit2 rewrite would save, and avoids a category of subtle correctness bugs.
- Each `dugite`-based file in `app/src/lib/git/` maps to one Rust module in `crates/git-ops/src/`; port the parsing/formatting logic test-by-test.
- `trampoline/` (10 files) + `ssh/` (4 files) → `crates/trampoline`, compiled as a small Rust sidecar binary bundled via Tauri's sidecar mechanism, replacing the vendored `desktop-trampoline` native binary. This is a real improvement: one Rust toolchain instead of a separately-maintained vendored binary per platform.

### Phase 3 — IPC surface → Tauri commands
- `app/src/lib/ipc-shared.ts` declares 77 channels — treat this as the literal spec. Build a table (in `MIGRATION_MAP.md`) of channel → Tauri command/event, and knock them out systematically rather than ad hoc as UI needs them.
- Request/response channels (`ipcMain.handle`) → `#[tauri::command]` + `invoke`.
- Main→renderer push channels (`webContents.send`) → `app.emit()` + `listen()`.
- **Improvement**: adopt `tauri-specta` (or `ts-rs`) to generate TS bindings + types directly from Rust command signatures. The current hand-synced `ipc-shared.ts` channel list is exactly the kind of manually-maintained contract this eliminates — do it from day one of Phase 3 rather than retrofitting later.

### Phase 3.5 — Wayland/X11 reality on the primary target (decided ahead of schedule, in Phase 0)

GNOME 50 (Mar 2026) and KDE Plasma 6.8 have both dropped native X11 sessions — Wayland is the
only session type on the primary target now. XWayland itself is *not* gone (both keep it "for
legacy apps"), but architecting a 2026 app around it would be swimming against the ecosystem's
direction, and it's not guaranteed present on minimal/Wayland-only installs. So native Wayland
support in WebKitGTK is mandatory, not optional — this isn't a case where forcing `GDK_BACKEND=x11`
is a safe permanent fallback.

The problem: native-Wayland WebKitGTK GPU compositing has real, currently-unresolved bugs as of
2026 (startup crashes, a text-blur-on-resize bug filed against `tauri-apps/wry`). One analysis put
it plainly: waiting on upstream WebKitGTK/Tauri to fix this isn't viable on any predictable
timeline.

**Decided**: force `WEBKIT_DISABLE_COMPOSITING_MODE=1` unconditionally at launch on Linux
(implemented already in `src-tauri/src/lib.rs`, `disable_webkit_compositing()`, called before
`tauri::Builder` runs). Trades GPU-accelerated rendering for sidestepping the known crash class —
favors stability over performance given this is a known, currently-unfixed gap, not a hypothetical.
Revisit once upstream native-Wayland WebKitGTK rendering actually stabilizes.

**Known, accepted gap**: there is no mature headless-Wayland WebDriver testing pipeline as of
2026 — Tauri's own CI docs and observed practice are still entirely X11/Xvfb-based. Building one
(`cage`/`weston --backend=headless-backend.so` + some WebDriver bridge) would be from-scratch R&D.
**Decided**: keep the Phase 0 Xvfb/X11 E2E harness as-is; it validates IPC/WebDriver plumbing but
does **not** cover native-Wayland rendering bugs. Compensate with manual testing on a real Ubuntu
26.04/Wayland session before releases, specifically watching for startup crashes and
resize/repaint artifacts — the two failure modes found in current upstream bug reports. Revisit
investing in real headless-Wayland CI as a later, explicitly-scoped effort, not bundled into
Phase 0/8's mechanical harness work.

### Phase 4 — Native platform integrations
Each of these is a self-contained swap; port with its own small test where the original had one (most don't — these were thin native wrappers in the old app, so add tests now):
- `electron-window-state` → official `tauri-plugin-window-state`. Direct replacement.
- `keytar` (OS keychain, used by `token-store.ts`) → Rust `keyring` crate wrapped in a command. **Improvement**: keytar is unmaintained (archived); this swap is forced either way, so no extra cost to doing it right.
- Native menu (`main-process/menu/**`, 8 files) → Tauri 2's `Menu`/`MenuBuilder` API. Direct replacement, including context menus and the spell-check-suggestions menu (spell-check suggestions come from the OS spellchecker via the webview — check what Tauri's webview exposes per-platform before assuming parity).
- Windows toast notifications (`notifications.ts` + vendored `desktop-notifications`) → `tauri-plugin-notification` (cross-platform, also gets you macOS/Linux notifications for free — currently Windows-only).
- `registry-js` (Windows registry reads) → Rust `winreg` crate.
- Squirrel.Windows updater (`squirrel-updater.ts`, `squirrel-error-parser.ts`) → **replace entirely** with `tauri-plugin-updater`. This is a genuine architectural improvement: Squirrel is Windows-only and unmaintained; Tauri's updater is cross-platform (Windows NSIS/MSI + macOS), so this also closes a long-standing gap if desktop-plus never had a real macOS auto-update path.
- `fs-admin` (elevated filesystem ops) → **decided: keep macOS-only, same behavior as today.** Usage audit: the only consumer is `app/src/ui/lib/install-cli.ts`, called from the single macOS-gated menu action `Dispatcher.installDarwinCLI()` (`app/src/ui/app.tsx:568`) — a user-initiated, low-frequency action that unlinks/mkdir-p/symlinks `/usr/local/bin/desktop-plus-cli`, retrying with elevation only if the unprivileged attempt fails. No Windows or Linux runtime equivalent exists today (Windows gets its CLI shim from the Squirrel installer at install time; Linux packaging is expected to place it on PATH at package-install time), so there's no gap to fill on the primary target. No native addon/crate is needed for the port: shell out to `osascript -e 'do shell script "..." with administrator privileges'` for the three trivial `std::fs`-equivalent ops (unlink, mkdir -p, symlink), mirroring the old callback API 1:1 with a single Rust command.
- Custom protocol handler (`x-github-client://`) → Tauri's deep-link plugin (`tauri-plugin-deep-link`).

### Phase 5 — webRequest-based behaviors (needs a redesign, not a port)
Electron's `webRequest` API (used for `alive-origin-filter.ts`, `same-origin-filter.ts`, `ordered-webrequest.ts`, `authenticated-image-filter.ts`) has no direct Tauri equivalent — Tauri's webview doesn't expose the same request-interception hooks.
- **Authenticated image loading**: instead of injecting auth headers into webview-issued requests, fetch the image in Rust (which already has the credentials) and hand the webview a data URL or blob via a command. Cleaner than the old approach, not just a workaround.
- **Origin/CSP enforcement**: enforce via Tauri's CSP config (`tauri.conf.json`) and the capability/permission system instead of a runtime filter — this is more declarative and auditable than the old imperative filter chain.
- This phase is the highest architectural risk in the whole plan — budget explicit design time, don't estimate it like a mechanical port.

### Phase 6 — Crash/exception reporting
- Old pattern: separate `CrashWindow` BrowserWindow + custom IPC. Tauri has no equivalent built-in.
- Recommend: Rust panic hook + a lightweight in-process error dialog (native `tauri::api::dialog` or a small dedicated webview), plus a unified Sentry (or similar) integration across both the Rust and React sides instead of the old bespoke crash-window/exception-reporting split. Simpler and gets you one reporting pipeline instead of two.

### Phase 7 — UI migration (React 16.8.4 → 19)
Port `app/test/unit/ui/**` (~30 files) alongside each component group, component-by-component, using the existing dispatcher/store pattern as the seam:
- `app/src/ui/dispatcher/**` + `app/src/lib/stores/**` (27 files, e.g. `app-store.ts`) is a solid seam — keep it. Only the leaf calls that currently go through `ipc-renderer.ts`/`main-process-proxy.ts` need to change to `invoke`/`listen`; the store/dispatcher shape itself doesn't need to change.
- **react-virtualized → replace, don't port.** It's effectively unmaintained and known to misbehave under React 18+ StrictMode/concurrent rendering. Replace with `@tanstack/react-virtual` (actively maintained, hooks-based, composes well with the existing function-component surfaces). This is a required change, not optional, given the React 19 target — flag it early since virtualized lists (`repositories-list`, `history`, `changes`) are core UI.
- React 16.8.4 → 19 is a large jump: `ReactDOM.render` → `createRoot` (rdc's scaffold already uses `createRoot`), string refs (if any remain) must go, legacy `defaultProps` on function components now warns — grep for these before porting each component rather than discovering them at runtime.
- CodeMirror 5, `dompurify`, `marked`, `@floating-ui/react-dom`, `focus-trap-react`, `dexie`, `@xterm/xterm` are all React-version-agnostic; port as-is. **Optional fast-follow improvement**: CodeMirror 5 → 6 has a much better TS-first API, but don't couple this to the Tauri migration — separate effort.
- **Optional modernization** (explicitly not required for parity): many GH-Desktop-era components are class-based `PureComponent`s for manual `shouldComponentUpdate` optimization. React 19 supports class components fine — don't force a hooks rewrite during the port. Revisit per-component after parity, where profiling shows it's worth it.

### Phase 8 — E2E
- Resolve the Playwright-vs-Tauri-driver question from Phase 0's spike.
- Port `app-launch.e2e.ts` and the mock-update-server-based update flow test last, once Phase 4's updater swap has landed — the old test is intrinsically Squirrel-shaped and needs rewriting against `tauri-plugin-updater`'s flow, not a straight port.

### Phase 9 — Packaging & CLI
- `app/src/cli/**` (small, Node-target CLI) is not part of the Tauri app proper — lowest priority, can stay a thin standalone Node/Rust binary, port last or in parallel by anyone not blocked on the main app.
- `app/src/highlighter/**` (webworker target) → straightforward Vite `?worker` import, no architectural change needed.

## Sequencing recommendation

Phases 1–3 (models, lib, git, IPC) can mostly proceed in parallel once Phase 0 tooling is in place — they don't depend on each other. Phase 4 (platform integrations) can start as soon as the relevant Tauri plugins are wired into `src-tauri/src/lib.rs`, independent of UI progress. Phase 5 (webRequest redesign) and the fs-admin elevation helper in Phase 4 are the two items to prototype *early* despite being "later" in the dependency chain, because they're the only two places where "port the old code" isn't a valid strategy — you need working design spikes before estimating the rest of the timeline. Phase 7 (UI) is naturally last-to-finish since it depends on Phases 3–6 being available to call, but individual component groups can start against a mocked `invoke` layer as soon as the IPC channel table from Phase 3 is drafted (even before the Rust side implements it).

## Weak points in the current codebase worth calling out (summary)

| Area | Issue | Fix during migration |
|---|---|---|
| `react-virtualized` | Unmaintained, breaks under React 18+ concurrent mode | Replace with `@tanstack/react-virtual` |
| `keytar` | Archived/unmaintained | Replace with Rust `keyring` crate |
| Squirrel.Windows updater | Windows-only, bespoke, unmaintained upstream | Replace with `tauri-plugin-updater` (cross-platform) |
| `ipc-shared.ts` manual channel list | Hand-synced contract, drifts silently | Generate via `tauri-specta`/`ts-rs` |
| `webRequest`-based auth header injection | Imperative, hard to audit, no Tauri equivalent anyway | Rust-side authenticated fetch → data URL to webview |
| Crash window + custom exception reporting | Two bespoke reporting paths | Unify behind one Rust+JS crash/error pipeline |
| Node built-in test runner | Works, but weaker DX than Vitest for the Vite-based frontend | Vitest for TS/React tests |
| WebKitGTK native-Wayland rendering (new, not in the old app) | Unresolved upstream crash/render bugs on the only session type the primary target now has | Force `WEBKIT_DISABLE_COMPOSITING_MODE=1` on Linux (see Phase 3.5); no automated CI coverage yet, compensate with manual pre-release testing |
