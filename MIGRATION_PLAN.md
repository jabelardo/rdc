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

### Phase 1 — Port models + pure-TS lib (test-first) — **first slice DONE**

> **The original assumption here was wrong and worth recording.** This phase was
> written as "almost entirely mechanical". In reality, `desktop-plus`'s dependency graph
> is badly tangled: taking the ~48 test files that *look* like pure models/lib work and
> resolving their transitive imports pulls in **455 files**, including 120 `ui/` files,
> 57 `lib/git/` files, 36 `lib/stores/` files, plus `electron`, `dugite`, `keytar` and
> `react-virtualized`. A naive "copy the tests and their sources" pass would have dragged
> most of the application into Phase 1. Always resolve the transitive closure before
> sizing a porting batch.

**What actually landed (verified: `tsc --noEmit` clean, 31 test files / 288 tests green):**
- 52 source files in `rdc/src/{lib,models}` + 2 test helpers in `rdc/src/test-helpers/`.
- Tests colocated as `src/**/*.test.ts` (Vitest), converted from `node:test` near-verbatim
  to preserve parity — see the conversion recipe below.
- Three **layering-inversion fixes** that were the entire cause of the 455-file explosion
  (all zero-runtime-impact, detail in `MIGRATION_MAP.md`): `lib/api.ts` importing a React
  dialog for a type, `lib/http.ts` reaching Electron through `ui/lib/app-proxy` just to read
  a build constant, and `lib/format-number.ts` importing a pure math helper from `ui/`.

**`node:test` → Vitest conversion recipe** (reuse for later phases):
- `from 'node:test'` → `from 'vitest'`; `mock` → `vi` in the import list.
- `mock.fn(` → `vi.fn(`, `mock.method(` → `vi.spyOn(`.
- Fake timers need real API translation, not a rename: `mock.timers.enable()` →
  `vi.useFakeTimers()`, `mock.timers.reset()` → `vi.useRealTimers()`,
  `mock.timers.tick(n)` → `vi.advanceTimersByTime(n)`.
- Keep `node:assert` and all assertions **verbatim** — that's what makes these tests a
  parity check rather than a rewrite. Requires `esModuleInterop: true` in tsconfig.

**Node 24 is pinned deliberately** (`.nvmrc`, `engines`, CI, Dockerfile). Node 26 ships an
experimental built-in `localStorage` global that is `undefined` unless `--localstorage-file`
is passed, and it *shadows jsdom's implementation* — silently breaking every
web-storage-dependent test (17 failures in `local-storage`/`welcome`) with a confusing
`Cannot read properties of undefined`. Keep `@types/node` on the v24 line too, or the types
will declare globals the runtime doesn't have.

### Phase 1 — miniplan to finish

Each step below was validated by simulating the import cuts against the real dependency graph,
so the "unblocks" numbers are measured, not estimated. Steps are independent unless noted.

**Step 1 — Port the 31 remaining portable models. ✅ DONE** — 30 models + 3 supporting `lib/`
files landed (`lib/fonts/installed-fonts.ts`, `lib/fonts/monospace-font-filter.ts`,
`lib/update-branch-strategy.ts`); `tsc` clean, 288 tests still green. Two things the
import-graph analysis could not have predicted, both now documented in `DEVELOPMENT.md`:
`models/app-menu.ts` turned out to be Electron *adapter* code (`Electron.MenuItem` via the
ambient namespace, no import) and was **deferred to Phase 4**, and `models/accessible-message.ts`
needed `import type { JSX } from 'react'` because React 19 removed the global `JSX` namespace.
No `lodash` dependency was added — its single `uniq()` call became a native `Set`.

<details><summary>original step description</summary>

*(mechanical, no blockers)*
Verified self-contained (no `ui`/`git`/`stores`/`electron`/Node-IO in their closure):
`accessible-message`, `app-menu`, `author`, `branch-preset`, `branch-sort-order`,
`branches-tab`, `clone-options`, `clone-repository-tab`, `commit-message`, `computed-action`,
`copy-path-normalization`, `diff-font` (needs `lodash`), `dot-com-bots` (`semver`), `fetch`,
`git-account`, `git-author`, `last-thank-you`, `menu-ids`, `merge`, `preferences`, `progress`,
`publish-settings` (`semver`), `pull-request` (`semver`), `release-notes`, `repo-rules`,
`show-branch-name-in-repo-list`, `stash-entry`, `submodule`, `tutorial-step`,
`uncommitted-changes-strategy`, `workflow-preferences`.
Only new dependency needed: `lodash`. These have no tests in the portable set — `tsc` is the
only gate, so keep them low priority relative to Step 2.

</details>

**Step 2 — Unblock `diff-parser-test`. ✅ DONE** — 33 test files / 298 tests green (+1 file,
+10 tests). `getHunkHeaderExpansionType`, `getLargestLineNumber` and `DefaultDiffExpansionStep`
were extracted from `ui/diff/text-diff-expansion.ts` and `ui/diff/diff-helpers.tsx` into a new
`src/lib/diff-hunks.ts` that imports only `models/diff`, then `lib/diff-parser.ts` was ported
pointing at it. This **broke a real import cycle** (`lib/diff-parser` →
`ui/diff/text-diff-expansion` → `lib/diff-parser` for `HiddenBidiCharsRegex`) rather than
relocating it: the dependency is now one-way, and the diff *parser* no longer needs React to
run. `HiddenBidiCharsRegex` is still exported from `diff-parser.ts` for the `ui/` consumers to
import in Phase 7.

**Step 3 — ~~Cheap UI-decontamination moves~~ → REVISED: do not port these now. ✅ DONE as a
decision, deliberately no code.**

This step was written before Steps 1–2 were executed, and its premise turned out to be wrong.
Verified before acting, and the conclusion is that doing it as written would make rdc *worse*:

- **`ui/lib/git-perf.ts` must not be ported at all.** Its only consumers are `lib/git/spawn.ts`
  and `lib/git/core.ts` — i.e. the dugite subprocess layer, which Phase 2 rewrites **in Rust**,
  so it never becomes TypeScript in rdc — plus a devtools debug global in
  `ui/install-globals.ts`. Porting it to `lib/git-perf.ts` would create a module with no
  possible consumer, forever. The original rationale ("prerequisite for Phase 2's `git-ops`
  extraction") was simply mistaken: Phase 2 is a Rust rewrite guided by the ported tests, not a
  TS port of `lib/git/**`, so the `lib/git → ui/` edge never has to be severed in TypeScript.
  **Correct replacement:** timing belongs inside the `git-ops` crate (`tracing` spans, or
  `std::time::Instant`), optionally surfaced through a dev-only command. Recorded in
  `MIGRATION_MAP.md`.
- **The enum/interface extractions unblock nothing and would land as orphans.** Measured
  earlier: applying all of them still leaves the 15 blocked tests at ~384 files. And
  `models/popup.ts` needs `Electron.Certificate` as well (for the untrusted-certificate popup),
  so it cannot be ported until that type has a Tauri/Rust equivalent regardless of the enums.
  Creating `models/` modules now with **zero consumers and zero test coverage** buys nothing and
  invites drift against `desktop-plus`.
  **Correct replacement:** bind each extraction to the phase that ports its consumer, as
  explicit instructions — see `MIGRATION_MAP.md` §9. That way the inversion cannot be
  accidentally re-created, without carrying dead code in the meantime.

The "120 → 61 files" figure was measured in the **desktop-plus** import graph. It describes how
much easier a future port becomes, not a change to rdc — nothing in rdc imports `ui/` today
(verified), so there is no contamination in this repo to remove.

**Step 4 — Re-scope the 15 remaining tests out of Phase 1. ✅ DONE** *(a decision, not a code
change — recorded here and in `MIGRATION_MAP.md` §6)*
Measured: applying every fix in Steps 2–3 still leaves these 15 at ~384 files with `git:57`,
`stores:35`, and `electron` in their closure. They are **not** blocked by layering nits; they
are blocked by `models/repository.ts` genuinely *executing git at runtime*. They belong to
Phase 2/3 (git → Rust) and Phase 7 (stores), and should be tracked there:
`format`, `ipc-contract`, `model-type-guards`, `multi-commit-operation`, `popup-manager`,
`pull-request-refs`, `repository`, `ssh`, `create-branch`, `name-of`, `text-token-parser`,
`wrap-rich-text-commit-message`, `format-commit-message`, `stats-store`,
`app-store-test-harness`.
The same root cause blocks 13 models (`repository`, `branch`, `commit`, `tip`, `popup`,
`worktree`, `avatar`, `banner`, `cherry-pick`, `drag-drop`, `multi-commit-operation`,
`rebase`, `retry-actions`). Two more (`editor-override`, `menu-labels`) are blocked only by
Node `fs`/`child_process` and belong to Phase 4 (editors/shells).

> **Latent bug found in the root blocker — fix during the Phase 2/3 port, don't copy it.**
> `Repository.url` is a *synchronous* getter that fires an un-awaited async git subprocess:
> ```ts
> public get url(): string | null {
>   if (this._url === null) { this.fetchUrl() }  // fire-and-forget getRemotes()
>   return this._url                              // so the first call always returns null
> }
> ```
> Consequences: the first read always yields `null`; every read before the promise resolves
> spawns *another* `git remote` process; and the promise has no `.catch`, so failures surface
> as unhandled rejections. When this moves to a Tauri command, make resolving the remote URL
> an explicit `async` call owned by a store/service — a model should not perform IO, and
> certainly not from a property getter.

**Step 5 — Carried debt (tracked in `MIGRATION_MAP.md` §8, deliberately not done in the port).**
`url.parse()` → WHATWG `URL` (8 sites, `DEP0169`, security-relevant); browser-safe answer for
Node `path` usage before these modules enter the app bundle;
`lib/copilot-in-memory-session-fs-provider.ts` deferred because `@github/copilot-sdk` drags in
`koffi`, a native FFI binary, for a *type-only* import.

**Definition of done for Phase 1:** Steps 1–3 landed with `tsc --noEmit` clean and Vitest green
(expected: 32 test files, ~290 tests), Step 4 re-scoped in `MIGRATION_MAP.md`, Step 5 recorded.

---

## ✅ Phase 1 COMPLETE

| Step | Outcome |
|---|---|
| 1 — port portable models | 30 models + 3 supporting `lib/` files; `models/app-menu.ts` deferred to Phase 4 |
| 2 — unblock `diff-parser` | +1 test file / +10 tests; real import cycle broken via `lib/diff-hunks.ts` |
| 3 — UI-decontamination moves | **Revised to "do not port"** — would have created permanently-orphan modules; extractions bound to their consumer phases in `MIGRATION_MAP.md` §9 |
| 4 — re-scope 15 tests | Moved to Phase 2/3 (git → Rust) and Phase 7 (stores) |
| 5 — carried debt | Recorded in `MIGRATION_MAP.md` §8 |

**Final state:** 87 source files (48 `models/`, 39 `lib/`) + 32 test files / 298 tests, all
green, `tsc --noEmit` clean, zero `ui/` imports anywhere under `src/`.

**Phase 1 delivered more than a port:** four layering inversions fixed (three in the initial
slice, plus a genuine circular dependency in Step 2), and a set of findings that change how
later phases should be approached — the `Repository.url` fire-and-forget bug, the ambient
global-namespace blind spot in import analysis, and the Node 26 `localStorage` shadowing trap.

**Next up: Phase 2** (`git-ops` crate). Its acceptance spec is `app/test/unit/git/**` (45 files).
Note that ~15 of the tests re-scoped in Step 4 also depend on it, so they unblock as a side
effect. Start with the `Repository.url` redesign — the git-calling model is the knot that keeps
the largest number of tests out of reach.

### Phase 2 — Git backend (`git-ops` crate) — **IN PROGRESS**

**Landed so far** (`cargo fmt`/`clippy -D warnings`/`test` green, 39 Rust tests):
- `src-tauri` is now a **Cargo workspace** (root package = the Tauri app, members = `crates/*`)
  with a shared `[workspace.dependencies]`. CI runs `--workspace`, without which cargo checks
  only the app crate and silently skips `crates/*`.
- `crates/git-ops/src/exec.rs` — the git invocation core, ported from `lib/git/core.ts`:
  `git(args, path, name, options)` over `tokio::process`, `success_exit_codes` (default `{0}`),
  env overrides, stdin, `TERM=dumb`, `kill_on_drop`. stdout is kept as **bytes** (git output
  isn't always UTF-8 — binary diffs, and Unix paths are arbitrary bytes) with `stdout_lossy()` /
  `stdout_trimmed()` helpers. Signal-terminated processes are a distinct error rather than being
  conflated with an exit code.
- `crates/git-ops/src/error.rs` — `GitError` via `thiserror`.
- `crates/git-ops/src/terminal_output.rs` — `push_terminal_chunk`, ported from
  `lib/git/push-terminal-chunk.ts` with all 27 of its test cases.
- `crates/git-ops/src/test_support.rs` — `empty_repository()` with deterministic branch name and
  identity/signing config, so tests don't depend on the developer's global git config.

**Test-suite reality check.** `app/test/unit/git/**` is **47 files, 36 of which build real
repositories** from fixtures — this is an integration suite, not a set of string-parsing unit
tests. So Phase 2 needs a fixture harness (copy fixture dir → temp dir, rename `**/_git` → `.git`
— the mechanism is simple), and the fixtures themselves are **8.7 MB**, 4.6 MB of that a single
image-diff repo. **Vendor fixtures lazily**, per module as its tests are ported, rather than
importing all 22 up front.

**Also landed (second slice, 53 Rust tests):**
- `crates/git-ops/src/git_error_kind.rs` — **generated**, not transcribed, from dugite v3.2.2's
  own `errors.js`: 60 `GitErrorKind` variants and all 62 patterns in dugite's exact order.
  **Order is load-bearing** (`parseError` takes the first match, and e.g. the HTTPS auth pattern
  must precede the generic one), which is why this is generated. Also ports `isAuthFailureError`
  and `parseBadConfigValueErrorInfo`.
- Classification is wired into `exec.rs` with dugite's real semantics, which are subtler than
  they look: parsing tries **stderr first, then stdout**, and a recognized failure the caller
  declared via `expected_errors` returns **`Ok`** with `GitOutput::git_error` set rather than an
  `Err` — the caller branches on it. `GitError::UnexpectedExitCode` carries the classified kind.
- `fixture_repository()` — copies a vendored fixture to a temp dir and renames `**/_git` → `.git`,
  ported from `setupFixtureRepository`. `test-repo` (88K) is vendored; the rest stay lazy.

**Decision: user-facing error copy stays in the frontend.** `getDescriptionForError` in `core.ts`
is ~140 lines of English strings. Rust returns the typed `GitErrorKind`; mapping kind → display
text belongs in the UI (Phase 7), where it can be localized. Porting English into the backend
would be a step backwards.

**Next:** port the first real command modules against the harness, starting with the ones whose
tests need no fixture (`init`, `add`), then the fixture-backed ones (`config`, `rev-parse`,
`branch`, `status`).

<details><summary>original phase description</summary>
- Port `app/test/unit/git/**` (45 files, largest single test category) as the acceptance spec for `crates/git-ops`.
- **Keep shelling out to the system `git` binary** (Rust `tokio::process::Command`), do **not** switch to `git2`/libgit2. This mirrors dugite's own deliberate choice — libgit2 has known gaps with LFS, credential helpers, partial clone, and hook execution that real desktop Git clients depend on. Reimplementing dugite's spawn/parse logic in Rust is more work than a libgit2 rewrite would save, and avoids a category of subtle correctness bugs.
- Each `dugite`-based file in `app/src/lib/git/` maps to one Rust module in `crates/git-ops/src/`; port the parsing/formatting logic test-by-test.
- `trampoline/` (10 files) + `ssh/` (4 files) → `crates/trampoline`, compiled as a small Rust sidecar binary bundled via Tauri's sidecar mechanism, replacing the vendored `desktop-trampoline` native binary. This is a real improvement: one Rust toolchain instead of a separately-maintained vendored binary per platform.

</details>

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
| **`lib/api.ts` imports a React UI component** (found in Phase 1) | A lib module importing `ui/secret-scanning/bypass-push-protection-dialog` for one type; transitively pulled the whole UI tree into the API client and its tests | **Fixed**: type moved to `models/secret-scanning.ts` |
| **`lib/http.ts` reaches Electron for a build constant** (found in Phase 1) | `ui/lib/app-proxy` → `ui/main-process-proxy` → `lib/ipc-renderer` → `electron`, all to read `__APP_VERSION__` | **Fixed**: uses the `__APP_VERSION__` define directly |
| **`ui/lib/round.ts` misfiled** (found in Phase 1) | Dependency-free pure math helper under `ui/`, imported by `lib/format-number.ts` | **Fixed**: moved to `lib/round.ts` |
| **Legacy `url.parse()` — security-relevant** (found in Phase 1) | 8 call sites across `api.ts`, `find-account.ts`, `parse-app-url.ts`, `repository-matching.ts`. Node emits DEP0169: behavior "is not standardized and prone to errors that have security implications. CVEs are not issued for `url.parse()` vulnerabilities." Also won't bundle for a webview without a Node polyfill. | Migrate to the WHATWG `URL` API. **Not** done during the port: `url.parse()` is lenient where `new URL()` is strict, so this is a behavior change that needs its own change with the ported tests as the guard. Tracked in `MIGRATION_MAP.md`. |
| `models/repository.ts` imports the whole `lib/git` barrel (hub #2) | A domain model depending on the entire git layer; blocks ~15 tests from porting | Break the barrel dependency — models should be leaf types |
| `models/popup.ts` imports UI dialog components (hub #2) | Popups typed by their dialog props, inverting the model→UI direction | Decouple popup payload types from component props |
