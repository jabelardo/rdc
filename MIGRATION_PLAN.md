# desktop-plus → rdc Migration Plan (Electron → Tauri 2.0)

Source: `desktop-plus` (GitHub-Desktop-derived Electron app, Electron 42, React 16.8.4, dugite/git, keytar, Squirrel.Windows updater).
Target: `rdc` (Tauri 2.0 + React 19 + Vite, currently the untouched default scaffold).

## Guiding principles

1. **Tests move first, code follows.** Every phase below starts by porting the relevant `app/test/unit` tests to the new stack (failing/unimplemented), then writes the minimal Rust/TS to make them pass. This gives an objective "done" signal per module and prevents silent behavior drift from the original app.
2. **Mirror the source tree, don't reinvent it.** Every old path gets one obvious new path, tracked in a mapping table (`MIGRATION_MAP.md`, generated as we go — see below). Nobody should have to guess where `app/src/lib/git/commit.ts` ended up.
3. **Behavior parity before modernization.** Flag improvements (listed inline per phase) but don't block porting a module on a rewrite. Modernize in a fast-follow pass once parity tests are green.
4. **Native modules become Tauri commands/plugins, not FFI shims.** Don't try to `bind` to keytar/dugite from Rust — replace them with the idiomatic Rust/Tauri equivalent and re-verify behavior via the ported tests.
5. **If it ran on Node, it probably belongs in Rust — not in ported TypeScript.** The default
   destination for a `desktop-plus` module is *not* `rdc/src`. Anything that shells out, touches the
   filesystem, or otherwise depended on Node should move to `src-tauri`, with the frontend calling
   it. Measured on the still-blocked Phase 1 tests: of 374 files in their closure only **67 are
   Node-bound**, and those 67 are what block the other 307 pure-TypeScript files from being ported
   at all. Porting a Node-bound module to TypeScript doesn't just fail to help — it can't work,
   because the Node API isn't there in a webview.
6. **rdc is not a drop-in replacement for `desktop-plus`, and owes it no configuration
   compatibility.** `desktop-plus` is the *starting point*, not a compatibility target: rdc is planned
   to diverge, particularly in UI and UX, before its first real release. So **settings, preferences and
   config-directory formats are rdc's own** — nothing needs to be readable by, or inherited from, a
   `desktop-plus` install. The first consequence is that `main-process/migrate-config-dir.ts` (which
   migrates `GitHub Desktop Plus` and `GitHub Desktop` config directories) is **dropped rather than
   ported**, along with the `get-config-migration-result` channel that only exists to report it.

   **This does not extend to repository data.** A user's git repositories are read by both applications,
   so anything written *into* a repository still has to interoperate — which is why Phase 2 kept the
   stash marker string `!!GitHub_Desktop<branch>` verbatim rather than renaming it. Config formats are
   rdc's to choose; bytes in someone's `.git` directory are not. Keep the two questions apart.

   Note this narrows principle 3 rather than contradicting it: *behaviour* parity remains the default
   for anything ported, and it is the storage format and the UI that are free to move.
7. **The first product milestone is a macOS/Linux MVP, not complete upstream parity.** A phase
   boundary must not make an unrelated parity feature a prerequisite for a useful application. The
   MVP is the same exposed Git workflow on macOS and Linux; Linux supplies deterministic
   `tauri-driver` automation, while development builds supply the native macOS/real-Wayland QA that
   automation cannot. Local packages are created only after that QA loop settles and receive a
   focused final artifact pass. Windows remains a named, complete Phase 10 rather than being hidden
   inside the MVP. GitHub collaboration, enterprise proxy/certificate handling, telemetry,
   signing/notarization, automatic updates and the standalone CLI are post-MVP unless an MVP slice
   directly depends on them.

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
    git-ops/            # replaces app/src/lib/git/** (60 files) — process-spawning wrapper around system git
    models/             # domain types shared with frontend (optionally codegen'd to TS)
    stats/              # telemetry, mirrors app/src/lib/stats
    trampoline/          # askpass/credential-helper sidecar, mirrors app/src/lib/trampoline + ssh
```

Rust conventions to enforce in review: `thiserror` for library error enums, `anyhow` only at the command boundary, no `unwrap`/`expect` outside tests, `tokio` for async process spawning (git, trampoline), commands return `Result<T, String>` (or a serializable error type) — never panic across the IPC boundary, `#![warn(clippy::all)]` in each crate, unit tests colocated per Rust convention (not a mirrored `tests/` tree, since Cargo idiom differs from the old JS layout — note this one deliberate deviation in the mapping doc).

## Phased plan

### Phase 0 — Tooling parity (no app logic yet) — **COMPLETE**
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

Closure re-verified after audit: CI has frontend, Rust, and Compose E2E-harness jobs; a clean
`rdc-e2e` image build starts Xvfb, WebKitWebDriver, and `tauri-driver` successfully.

### Phase 1 — Port models + pure-TS lib (test-first) — **COMPLETE**

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

**State at Phase 1 closure:** 87 source files (48 `models/`, 39 `lib/`) + 32 test files /
298 tests, all green, `tsc --noEmit` clean, zero `ui/` imports anywhere under `src/`. Later
phases superseded some of these files and increased the current counts.

**Phase 1 delivered more than a port:** four layering inversions fixed (three in the initial
slice, plus a genuine circular dependency in Step 2), and a set of findings that change how
later phases should be approached — the `Repository.url` fire-and-forget bug, the ambient
global-namespace blind spot in import analysis, and the Node 26 `localStorage` shadowing trap.

**Phase 2 is complete and export-audited** (`git-ops` crate) — its
acceptance spec is `app/test/unit/git/**` (51 files recursively: 45 top-level plus 6 under
`pull/` and `rebase/`); see the exit criteria below. Phase 3 subsequently completed the git command
surface and the exact §7 IPC channel-table audit; remaining exported-behavior deferrals are implemented
by their named later-phase owners.
Nine of the 15 tests re-scoped in Step 4 were subsequently recovered through the
`Repository.url` redesign, trailer/regex extraction, and app-state decomposition. The remaining
four are assigned to Phases 5 and 7 in `MIGRATION_MAP.md` §6. The former `ipc-contract` deferral is
superseded by the exact channel measurement and regression tests, while `format-commit-message` now has
its Phase 3 `merge_trailers` command and retains only Phase 7 consumer-layer work.

### Phase 2 — Git backend (`git-ops` crate) — **COMPLETE — EXPORT-AUDITED**

**Minimum git.** rdc runs the **system** git, where upstream bundled its own — so an option newer than a
supported distro's git is a real failure, not a hypothetical one. `cherry-pick --empty` is shimmed and
`hook run --to-stdin` is capability-guarded rather than assumed; CI holds the line with a job on git
2.39. Ubuntu 22.04
ships 2.34, Debian 12 ships 2.39, Ubuntu 24.04 ships 2.43, and the primary target Ubuntu 26.04 ships 2.53.
Use `exec::supports_flag` rather than a version comparison; see `MIGRATION_MAP.md` §8.

**Current state, measured.** `lib/git` is 60 files / 9,485 lines. `git-ops` is 74 files /
32,900 lines with 903 tests of its own; the workspace runs 1,027 Rust tests plus 547 TypeScript ones,
with `fmt`/`clippy -D warnings`/`test`/`tsc` green. 67 commands are exposed.

#### Exit criteria, and what they deliberately exclude

Phase 2 owns **git**: running it, parsing it, and the helper binaries git itself invokes. It is
closed when every exported `lib/git` and `lib/hooks` behaviour either exists in `git-ops` or is
recorded against the phase that owns its blocker. File counterparts alone are insufficient:
`MIGRATION_MAP.md` §3 now carries the export-level checklist used for closure.

- **Every `lib/git` file has a counterpart** — 60 of 60, once the nine that map by concern rather than by
  name are followed through: `core.ts` → `exec`+`error`+`git_error_kind`, `spawn`/`create-tail-stream`/
  `push-terminal-chunk`/`coerce-to-*` → `exec`+`terminal_output`, `credential.ts` → the `trampoline`
  crate, `index.ts` → a barrel with nothing to port, and `environment.ts` → `authentication.rs` for the
  half that has a Tauri equivalent.
- **`lib/hooks/**` is ported**, by concern rather than by filename: discovery, shell selection, shell
  environment, transport, runner and wiring, plus `rdc-printenvz` and `rdc-hook-proxy`.
- **Nine upstream bugs found and fixed**, each recorded in `MIGRATION_MAP.md` §8 with its consequence.
- **No deferral without a named owner.** The export-level audit found additional deferrals beyond
  the earlier file-level count. The complete list and owner for each is in `MIGRATION_MAP.md` §3;
  the major groups are:

| Left open | Owner | Why it isn't Phase 2 |
|---|---|---|
| Commit terminal transport | Phase 3 | **Done:** combined stdout/stderr crosses a command-scoped Channel. The only production consumer upstream is commit progress. |
| Commit terminal history/dialog and the hook-failure decision | Phase 7 | **Complete:** the late-subscriber buffer and hook decision remain in `WorkingTreeStore`; the shared `OperationProgressDialog` owns the in-flight commit terminal presentation. They are consumers of the Phase 3 seams, not transport work. |
| Image diff production and blob transport | Phase 3 / Phase 7 | **Phase 3 done:** image diffs use scoped `rdc-blob` capability URLs, with no raw-byte command. Phase 7 owns rendering and the bounded text-prefix consumer. |
| `envForProxy` | Phase 5c | Electron's `session.resolveProxy` is a `session`-level capability, not a platform swap — rehomed from Phase 4 when Phase 4 was planned. **No remote operation has proxy support today**; that is a known gap, not an oversight. |
| `getGlobalConfigPath` | Phase 4 — **done** | `GlobalConfig::path` asks `git config --edit --global` under `GIT_EDITOR=printf %s`, preserving path resolution and file creation; the command and typed wrapper are green. |
| `getFilesDiffText`, the remaining rev-list queries, `getConfigValueWithOrigin` and its formatters, accounts/keychain, SSH env | Phase 7 | Each lands with its consumer, and the config formatters emit UI strings. |

What Phase 2 does **not** own, and never did: deciding *whether* to intercept hooks, how bytes reach the
webview, or where a proxy comes from. Those are the three places this phase stops.

The implementation gates and the 60-file counterpart count are green. Every deferred export in
the checklist now has an explicit Phase 3, 4, or 7 owner, so formal closure does not depend on
implementing those later-phase features.

| | |
|---|---|
| `lib/git` files covered by a Rust concern | **60 of 60**. There are 59 filename-level counterparts; `environment.ts` is intentionally split between `authentication.rs` and Phase 5 proxy integration — see below |
| `lib/diff-parser.ts` | ported to Rust, TypeScript version deleted |
| `lib/git/log.ts` | ported to Rust |
| `lib/git/show.ts`, `lib/git/diff-index.ts` | ported to Rust |
| `lib/git/diff.ts` | text, image, and conflict-resolution diff production ported; Phase 7 owns image rendering |
| `lib/trampoline/**`, `lib/git/credential.ts` | handlers ported; accounts/UI behind traits |
| `lib/git/{push,fetch,pull}.ts`, `lib/progress/**` | ported to Rust; hook command handoff subsequently completed in Phase 3 |
| `lib/git/{clone,remote}.ts` | ported to Rust |
| `lib/git/{stash,cherry-pick}.ts` | ported to Rust |
| `lib/git/submodule.ts` | ported to Rust; closes `checkout`'s deferral |
| `lib/git/{squash,reorder}.ts` | ported to Rust; closes `rebase`'s interactive deferral |
| `lib/git/{tag,revert,reflog,description,var,clean}.ts` | ported to Rust |
| `lib/git/apply.ts` + `lib/patch-formatter.ts` | ported to Rust; partial staging and partial discard done |
| `lib/git/{gitignore,checkout-index,format-patch}.ts` | ported to Rust |
| `lib/git/{worktree,worktree-include,merge-tree}.ts` | ported to Rust |
| `lib/git/lfs.ts`, `lib/progress/lfs.ts` | filters, attributes, and live transfer progress ported |
| `lib/git/multi-operation-terminal-output.ts` | bounded replay and live aggregation ported |
| `lib/git/for-each-ref.ts` | ported to Rust; the branch list, with hydration into the `Branch` class |
| `lib/git/environment.ts` | **partially ported**: the authentication env lives in `authentication.rs`; `envForProxy` has no Tauri equivalent — see below |

**Ported:** `exec`+`error`+`git_error_kind` (`core.ts`, less the frontend error copy), `status`,
`status_parser`, `rebase` (including interactive), `checkout`, `branch`, `commit`, `config`, `rev_parse`,
`update_index`, `interpret_trailers`, `terminal_output`, `git_delimiter_parser`, `operation_state`,
`merge`, `stage`, `rev_list` (partial), `reset` (`unstageAll`), `update_ref` (`deleteRef`), `add`,
`apply`, `patch_formatter`, `diff_check`, `refs`, `init`, `rm`, the text-diff path, `diff_parser`,
`diff_index`, `show`, `log`, `push`, `fetch`, `pull`, `clone`, `remote`, `stash`, `cherry_pick`,
`submodule`, `squash`, `reorder`, `tag`, `revert`, `reflog`, `description`, `var`, and `clean`.
`gitignore`, `checkout_index`, `format_patch`, `worktree`, `worktree_include`, and `merge_tree` are
also ported. LFS installation, attribute queries, and progress tracking are ported in `lfs` and
`progress`.

Narratives for the slices that landed as full vertical slices — merge, rebase, checkout progress
streaming — are written up under **Phase 3** below, because each shipped backend *and* command
together. The `git-ops` half of that work belongs to this phase.

**The diff parser landed next**, and it hit the same fork `status` settled, with the same answer.
`src/lib/diff-parser.ts` was ported to TypeScript in Phase 1 and had no importers except its own
test, so it is **deleted**: `crates/git-ops/src/diff_parser.rs` parses, and its 10 TypeScript test
cases became 26 Rust tests. `src/models/diff/**` stays — those are the domain types the UI renders.

Three things worth knowing from it:

- **The frontend must hydrate.** Unlike `AppFileStatus`, `DiffHunk` and `DiffLine` are *classes with
  methods*, so JSON is not assignable to them however well the fields line up. `src/lib/diff-ipc.ts`
  declares plain wire types and constructs the classes — and that hydration is the compile-time proof
  the shapes match, which is stronger than an assertion.
- **`DiffLineType` is a numeric enum**, so it serializes as `0`–`3`, and the diff types use
  `number | null` rather than optional properties, so they emit **explicit nulls**. Both are the
  opposite of the status types' conventions, and both are pinned by the snapshot.
- **`getHunkHeaderExpansionType` and `getLargestLineNumber` now exist in both languages, on purpose.**
  Rust applies them while parsing; Phase 7's `ui/diff/text-diff-expansion.ts` re-applies them to
  content fetched during hunk expansion, which never passes through the parser. Rather than trust two
  implementations to agree, `diff-ipc.test.ts` runs the TypeScript versions over Rust's own snapshot
  output and compares — including a guard against the check passing vacuously.

A fourth upstream bug turned up: `DiffHunkHeader.equals` compared `oldStartLine` twice and never
compared `newLineCount`. See `MIGRATION_MAP.md` §8.

Still unported from `diff.ts`: the 11 functions that *produce* diffs (`getWorkingDirectoryDiff`,
`getCommitDiff`, `convertDiff`, the image variants). Those need `show.ts` (blob contents),
`diff-index.ts` (`NullTreeSHA`) and `log.ts` (`parseRawLogWithNumstat`), so the parser was the
correct stopping point — it is the piece all of them feed.

**`log` landed after it**, which was the other Phase 7 blocker: `getCommits`, `getCommit`,
`getChangedFiles` and `getAuthors`, plus `CommitIdentity::parse` and the interleaved
`--raw --numstat -z` parser that `diff.ts` also needs.

The hydration pattern the diff types introduced gets a stronger justification here. `Commit`'s
constructor *derives* `coAuthors`, `bodyNoCoAuthors`, `authoredByCommitter` and `isMergeCommit`, and
`CommittedFileChange` derives `id` — so the wire carries constructor **arguments** and the derived
fields come out of the constructor. Sending them from Rust would create a second implementation of
each rule, which is what `AGENTS.md` forbids and what the conflict-shape bug came from.

Details worth keeping:

- **`parentSHAs` is the one field whose JSON name isn't plain camelCase**, because the TypeScript
  class spells it that way. Renaming it to `parentShas` would leave the field `undefined` and make
  every commit look like a root commit — pinned by a test.
- **Timestamps cross as epoch seconds**, not formatted strings, and `tzOffset` keeps the original's
  sign convention (`+120` for `+0200`) even though it is the *opposite* of
  `Date.getTimezoneOffset()`. That inconsistency is upstream; flipping it would silently shift every
  displayed timestamp, so it is documented rather than corrected.
- **`get_commits` treats exit code 128 as success**, because `git log` exits 128 on an unborn `HEAD`
  and a fresh repository with no commits is not an error.
- **`-C` must precede `-M`** in `getChangedFiles`; the original noted that reversing them means
  copies are never detected.
- The interleaved raw/numstat walk has to know which entries were renames, because a rename occupies
  three NUL-separated fields in both sections while an ordinary change occupies two in one and one in
  the other. The test that pins this asserts the entry *after* a rename is still aligned.

One boundary case is pinned as-is rather than "fixed": a rename record missing only its destination
path yields an empty path instead of an error, because `-z` output ends with a trailing NUL and the
empty field after it is a real element. The original behaved identically. git does not produce that
output, and inventing a stricter rule risks rejecting output it does produce.

**`show` and `diff-index` followed**, the last two prerequisites `diff.ts`'s producing functions
needed. Both are small, and scoping them was driven by asking who actually consumes each export:

- `get_blob_contents` is used only by `diff.ts` internals (`getResolutionDiff`, `getBlobImage`), so it
  is **Rust-internal with no command**. Phase 3 later settled the byte representation with scoped
  `rdc-blob` capability URLs rather than base64 or a byte-array command response.
- `getPartialBlobContents` **has since landed** — see the `git_capped` slice note below. It has no
  command because its only consumer is `ui/diff/syntax-highlighting/index.ts` (Phase 7); that phase
  will expose the bounded prefix in the text shape its consumer needs.
- `get_index_changes` is consumed by `lib/stores/git-store.ts`, so it **is** exposed as a command.

Two things verified rather than assumed:

- **`git show <rev>:<missing>` exits 128, not 1.** So the original's `successExitCodes: [0, 1]` never
  fires for a missing path, and such a path is an error exactly as its docstring claimed. The `1` looks
  defensive and is kept, so a git that does exit 1 behaves as before rather than suddenly failing.
- **The null tree SHA resolves in any repository** — it's a constant of the object format, not
  something a repository has to contain. A test asserts `cat-file -t` reports it as a tree, since the
  unborn-`HEAD` fallback depends on it.

`IndexStatus` moved to `src/models/index-status.ts`: an enum that crosses IPC is a domain type, and
its old home (`lib/git/diff-index.ts`) is now Rust. It is a *numeric* enum, so like `DiffLineType` it
serializes as its discriminant — pinned by the snapshot, because switching to variant names would
leave every `=== IndexStatus.Modified` comparison false.

**The text diff path landed**, which is what the previous three slices were for: the app can now
produce a renderable diff. `get_working_directory_diff`, `get_commit_diff`, `get_commit_range_diff`,
the size guards, and submodule diffs. 22 commands.

The `IDiff` union needed **hand-written `Serialize`/`Deserialize`**, and the reason generalises: it
discriminates on a *numeric* `kind`, and serde's internally-tagged representation writes the variant
*name* as the tag, so `"kind": "Text"` would never match `DiffType.Text === 0`. Nor can it be
`untagged` — `Text` and `LargeText` are structurally identical and differ only in `kind`, so untagged
deserialization would always pick whichever variant came first. That is now the third numeric enum on
the boundary (`DiffLineType`, `IndexStatus`, `DiffType`); all three are pinned by the snapshot.

Behaviour preserved that looks wrong until explained:

- **A new or untracked file is diffed against `/dev/null` with `--no-index`**, which emulates
  `diff(1)`'s exit codes — so **1 means "differences found"**, not failure, and is accepted as
  success. The path is passed *without* the `:(top,literal)` pathspec guard there, because
  `--no-index` treats its operands as filenames and the magic prefix would be taken literally.
- **A renamed file is diffed against the index, not `HEAD`.** The original called this "technically
  incorrect, the best kind of incorrect": showing exactly what will be committed would need a
  blob-to-blob diff, so changes already staged to a renamed file don't show up the way they do
  elsewhere. Preserved, with the reasoning attached.
- **A range diff retries against the empty tree** when the oldest commit has no parent, since
  `<root>^` doesn't resolve. Written as a two-iteration loop rather than the original's recursion, so
  it's evident the retry happens at most once.
- **The hard 70MB buffer limit is checked before parsing**, because past it the original couldn't
  decode the buffer at all. The soft limit (1/16th of it) and the 5,000-character line limit produce
  `LargeText`, which still carries text and hunks so the UI can offer to render anyway.

One improvement over the original: **line length is measured in characters, not bytes.** The original
used `line.text.length` on a JavaScript string, i.e. UTF-16 code units; measuring bytes in Rust would
have declared a file of CJK text unrenderable at a third of the real limit. A test pins a fixture that
exceeds the limit in bytes but not in characters.

**Subsequent disposition:** Phase 3 added image diff production and scoped `rdc-blob` capability URLs;
the bytes do not enter JSON. `getFilesDiffText`, the bounded syntax-highlighting prefix, and the image
viewer remain with their Phase 7 consumers. `getResolutionDiff` has its own backend-local temp-file
path, and the shared LFS command and progress layer is ported.

**The trampoline handlers landed**, which is the structural blocker for the eight network-bound files.
Three pieces: the credential protocol (`credential.rs`), per-operation session state and the
environment that points git at the trampoline (`session.rs`), and the handlers themselves
(`handlers.rs`). 111 tests in the crate, 14 of them end-to-end through the real binary.

**A security bug was found and fixed** — see `MIGRATION_MAP.md` §8. The askpass handler auto-accepted
GitHub's pre-2023 RSA host key, which GitHub **rotated after its private half was exposed**. The port
pins GitHub's three current fingerprints and keeps the retired one only so a test can assert it is
never accepted.

**Design decisions worth keeping:**

- **The account and UI decisions are traits** (`CredentialProvider`, `AskpassResponder`), so everything
  around them — prompt classification, the reply format git parses, the no-prompting rule — is
  implemented and tested now rather than waiting on Phase 7. `Decline` implements both by refusing,
  and that is **correct rather than a stub**: declining makes git fall through to its own helpers, so
  SSH agents and system credential managers keep working today.
- **A background task never prompts**, enforced in the handler rather than in the responder, so an
  implementation cannot forget it. A pinned github.com key is still accepted there, and a *stored*
  secret may still be used — declining to prompt is not declining to answer.
- **One session store replaces four global maps.** The original kept four module-level `Map`s keyed by
  token and deleted from each in a `finally` block. Here a `Session` guard removes its state and
  revokes its token on drop, so the two lifetimes cannot diverge.
- **Two deliberate default changes**, both toward the safe direction: an unknown token now counts as a
  background task (so it cannot cause a prompt), and has *no* path rather than falling back to the
  process working directory (which has nothing to do with any repository, and would make an external
  credential helper read the wrong configuration).
- **`Credential` is an ordered list, not a map.** git reads the reply as a sequence and `wwwauth[]`
  only means anything in order, so a `HashMap` would scramble it. `format` also refuses values
  containing a newline or NUL — a security check, since the protocol is newline-delimited and a
  crafted password could otherwise inject extra fields.
- **`GIT_CONFIG_PARAMETERS`, not `-c` arguments**, because arguments aren't passed to filters and Git
  LFS runs as one. The original also chose it over the documented `GIT_CONFIG_{COUNT,KEY,VALUE}` to
  work around a Python hook manager that mishandles blank values.

**Still deferred:** the accounts store and keychain (Phase 7), the UI prompt round-trip, SSH env
(`getSSHEnvironment` needs an ssh-wrapper binary), and the GitHub-vs-generic endpoint classification
that calls the API. None of them block porting `push`/`pull`/`fetch` now.

**push, fetch and pull landed**, the first operations needing *both* halves of the backend: `git-ops`
to run git, and the trampoline to answer the credential requests git makes while it runs. 26 commands.
`src-tauri/src/trampoline_state.rs` is where they meet.

**`lib/progress/**` came with them** as `progress.rs`, and it is the substantial part. git reports an
operation as several titled steps, each 0–100%, which have to become one number. Two behaviours there
are load-bearing:

- **Steps get skipped.** A push against a server with nothing to compress never reports
  `Compressing objects`, so recognising a step means every *earlier* step counts as complete —
  otherwise progress restarts near zero mid-operation.
- **Progress must not go backwards.** An unrecognised line reports the *last* percentage rather than
  zero, which is why the parser is stateful and single-use per invocation.

Details preserved with their reasons:

- **`--force-with-lease`, never `--force`**, and `--set-upstream` takes precedence over it: a lease
  against a ref that doesn't exist remotely would fail, and forcing onto a missing branch is
  meaningless. A test pins that precedence.
- **`fetch`/`pull` filter their context lines to `remote: Counting objects`.** Their stderr also
  carries ref-update summaries (`* [new branch] main -> origin/main`), which are not progress and would
  otherwise be displayed as though they were.
- **`fast_forward_branches` treats exit code 1 as success**, because git reports it when a ref can't be
  fast-forwarded — the expected outcome for any diverged branch. It also passes
  `--show-forced-updates` explicitly so a user's `fetch.showForcedUpdates=false` can't allow a
  non-fast-forward, and `--no-write-fetch-head` so it doesn't clobber `FETCH_HEAD`. Ref pairs go over
  stdin to avoid the command-line length limit.
- **`pull` supplies `--ff` only when `pull.ff` is unset.** Overriding a deliberate setting would be
  worse than letting git complain, and a *failed* config read yields no arguments so git's own message
  about needing a reconciliation strategy survives.
- **`GIT_TERMINAL_PROMPT=0` and `GIT_TRACE=0`** are set on every remote operation. The first stops a
  GUI-invoked git blocking on input nobody can supply; the second is pinned so an exported `GIT_TRACE`
  can't flood stderr and confuse the progress parser.

**The cancelled-prompt translation is now wired up**, which is what `is_cancelled_authentication`
existed for. A declining credential helper makes git give up with "could not read Username … terminal
prompts disabled" — accurate and useless. `commands/remote.rs` recognises that, combined with an
endpoint the session recorded as rejected, and reports an authentication failure instead. It is also
why the session is held for the whole operation rather than dropped once its environment is read:
rejections accumulate on it while git runs.

**What works today:** the handlers still decline, so rdc supplies no credentials of its own — but
declining makes git fall through to *its* helpers, so a repository reachable over SSH with a loaded
agent, or over HTTPS with a system credential manager, works now. Accounts, keychain and the prompt UI
are Phase 7.

**`clone` and `remote` finished the initial network group.** The LFS command and progress layer
followed in the later slice described below. 35 commands at this point.

Two things checked against real git rather than inferred, both of which corrected a test I had already
written:

- **Cloning an empty repository adopts the *source's* unborn branch name**, not `init.defaultBranch`.
  The latter only decides when the remote doesn't advertise one, which local and modern-protocol
  remotes do. So the original calling `getDefaultBranch()` on *every* clone was paying for a case that
  rarely fires — which is why `default_branch` is a caller-supplied option here rather than something
  resolved inside the crate.
- **A plain `git fetch` already records `refs/remotes/origin/HEAD`** when the remote advertises it. So
  `updateRemoteHEAD` is usually a refresh, not the thing that creates it. It still matters when the
  remote didn't advertise one, or when the upstream default branch changed.

Decisions worth recording:

- **`GIT_CLONE_PROTECTION_ACTIVE=false` is preserved deliberately**, and documented at the call site.
  It disables a *defense-in-depth* layer added alongside the CVE-2024-32002 fix, not the fix itself —
  and the layer is known to break Git LFS clones. See `MIGRATION_MAP.md` §8.
- **The clone's session is keyed on the destination**, not the source, because that is where the
  credential helper looks for configuration. It is the one operation whose session path is created
  rather than found.
- **`getRemotes` memoization is dropped.** The original wrapped it in `memoizeOne`, which caches for the
  most recent path — so adding a remote left the cache stale until some *other* path was queried.
  Caching belongs in the store that knows when remotes change.
- **`getRemoteURL` now trims.** The original returned git's output including its trailing newline, which
  fails every comparison the value is then used in.
- **`removeRemote` accepts exit codes 2 and 128**, so removing a remote that doesn't exist succeeds —
  the caller wants it gone, and it already is.

**`stash` and `cherry-pick` landed.** 47 commands. Three upstream bugs came with them, all in
`MIGRATION_MAP.md` §8:

- **`getStashes` under-reported the count by one** (`entries.length - 1`). With a single stash it said
  zero, which the UI reads as "no stashes".
- **`createDesktopStashEntry` guessed** whether a stash was created, from the exit code and stderr. Its
  own comment documented that this fails for an unborn repository and declined to fix it. The port asks
  git: `refs/stash` before and after.
- **Two dead guards in `cherry-pick`** from missing `await`s on the `async`
  `isCherryPickHeadFound` — `!promise` in one place, `await !promise` in the other. Both are real checks
  now.

Things worth recording:

- **`cherry-pick` reports progress on *stdout***, unlike every operation ported so far. `exec` gained
  `git_with_stdout` and a `git_streaming` that drains both pipes, which `git_with_stderr` now delegates
  to.
- **A bug I introduced and the tests caught:** I first accepted exit code 1 as *success* for
  cherry-pick. That makes `exec` return before classifying, so `git_error` was `None` and a conflict
  looked like an unknown failure. `expected_errors` is the mechanism that converts a recognised failure
  into an `Ok` *while keeping* the classification.
- **The stash marker string is unchanged** (`!!GitHub_Desktop<branch>`). Renaming it would orphan every
  stash a user made in `desktop-plus`. Custom names are percent-encoded to `encodeURIComponent`'s
  unreserved set for the same reason — a name written by the old app has to decode identically — and
  encoding is required at all because the marker uses `<`/`>` as delimiters.
- **`createdAt` crosses as epoch seconds**, not the original's ISO-8601 string, matching
  `CommitIdentity`. `renameStashEntry`/`moveStashEntry` send it back unchanged so the rebuilt entry
  keeps its sort position.
- **`StashEntry` omits `files`**, which is a `NotLoaded`/`Loading`/`Loaded` state the frontend owns —
  the same split as `WorkingDirectoryFileChange`.
- **`renameStashEntry` returns `null` when nothing changed**, because rebuilding the entry would change
  its SHA and invalidate whatever the caller holds.
- **An unrecognised cherry-pick failure returns `CherryPickResult::Error`** rather than throwing as the
  original did; the repository is still in a state the UI has to describe, and the enum already had a
  variant for it.

**`submodule` landed**, which was the only remaining item that unblocked *already-ported* code rather
than adding surface. 49 commands.

**A fourth upstream bug, and the most consequential so far.** `listSubmodules` required a parenthesised
`git describe` value, which git prints only for a checked-out submodule — so **uninitialized and
conflicted submodules were silently dropped from the list**. That list is what tells the
discard-changes path a given path is a submodule and must be *reset* rather than moved to the trash, so
an omission removes that protection for precisely the submodules most likely to need it. `describe` is
now `string | null` and every entry is reported. See `MIGRATION_MAP.md` §8.

**`checkout`'s deferral is closed, and its progress weighting restored.** The original treated the
checkout itself as the first 90% and reserved the last 10% for the submodule update; this port had been
emitting a flat `1.0` because there was nothing to fill that tenth. `CHECKOUT_STEP_WEIGHT` is back, with
a test asserting the checkout step completes at 0.9 and the whole operation at 1.0.

Two decisions there worth recording:

- **A submodule failure does not fail the checkout.** The branch has already changed; reporting failure
  would tell the user their checkout failed when it didn't. Progress still advances to 1.0 with
  "Submodules could not be updated", because leaving it at 90% for ever is the worse lie.
- **Submodule progress is deliberately fake** — `1 - e^(-n/4)` over the number of clone/checkout events.
  There is no way to know upfront how many submodules there are or what git will do with each, so it
  moves quickly at first, slows, and never claims completion on its own.

**A test premise I got wrong twice, worth knowing:** `git submodule deinit` leaves `.git/modules/<name>`
in place, so `submodule update --init` restores from that local copy *without using any transport*. A
test that only deinits therefore never exercises the clone path — or the `protocol.file.allow`
restriction git added for CVE-2022-39253. Removing the modules directory too is what forces a real clone;
the helper that does so says why.

**`squash` and `reorder` landed, closing `rebase`'s last deferral** — interactive rebase. 51 commands.

Both work the same way: compute an interactive-rebase todo list and hand it to git, so all the work is
in *building the list*. `rebase_interactive` replaces git's editor with one that writes the prepared
list out, and the ordering rules are the interesting part:

- **The replay order is the log's, not the caller's.** Squashing `A` and `E` onto `C` in history
  `A, B, C, D, E` must give `B, A-C-E, D`, so `A` folds before `C` and `E` after — regardless of the
  order the caller listed them. The original spelled this out ("not trust that what was sent is in the
  order of the log") and both ports have a test passing the list backwards to prove it changes nothing.
- **Commits after the anchor are held back**, because a later commit might itself be one being moved or
  squashed. They're replayed at the end.
- **The "anchor not in the log" check happens after the walk**, as upstream did — and it matters, since
  continuing would silently drop every commit being squashed or moved.

The todo-building is a pure function (`build_squash_todo`, `build_reorder_todo`) tested without git,
which is what makes those rules cheap to pin; the integration tests then confirm real git agrees.

Two mechanics worth recording:

- **`GIT_SEQUENCE_EDITOR` must be *removed*, not emptied.** The original set it to `undefined`, which
  dugite translated to a removal. Setting it to `""` makes git try to run `""` as an editor and fail
  with "unable to start editor ''" — which is exactly what happened on the first run. `GitOptions`
  gained `without_env` for this, since setting and unsetting are genuinely different operations.
- **git runs editor values through a shell.** Both the todo list and squash's commit message are fed in
  as `cat "<path>" >`, so a path containing a quote, backtick or `$` could break out of the command.
  `cat_editor_command` refuses such a path. We build these paths ourselves, but a surprising `TMPDIR` is
  how "can't happen" happens — and the temp files are now RAII guards rather than `finally` blocks.

**Six small files swept: `tag`, `revert`, `reflog`, `description`, `var`, `clean`.** 62 commands.
`lib/git` is now 53 of 60 files.

Two findings, in `MIGRATION_MAP.md` §8:

- **`getGitDescription` used a path that can't exist in a worktree or submodule.** `<repo>/.git/description`
  isn't a path when `.git` is a *file*, and because a read failure meant "no description" it failed
  silently. The right question is `rev-parse --git-common-dir` — **not** `--absolute-git-dir`, which in a
  worktree reports `.git/worktrees/<name>` where no description lives. Tested from inside a real worktree.
- **`RevertProgressParser` was a no-op by construction**, so a revert's progress was always zero. An empty
  step title can never match, and a zero total weight makes every weight NaN. Worth recording so nobody
  "fixes" the port's constant zero; the parser only ever routed text into the description.

Smaller things preserved with their reasons:

- **`show-ref --tags -d`**, where the `-d` is load-bearing: an annotated tag yields two lines, and only
  the `^{}` one names the commit. Without it every annotated tag would map to its *tag object*. The
  original's comment called that a "blob object", which is the wrong object type but the right instinct.
- **`clean` without `-x`**, so gitignored build output survives — and it is irreversible, which the doc
  comment says plainly since these files are not in git.
- **`revert -m 1` only for merge commits.** Passing it always would make git refuse a normal commit;
  omitting it makes git refuse a merge. A test asserts the second direction, so the flag is provably
  load-bearing rather than decorative.
- **The reflog date is passed unquoted.** The original interpolated `--after="<iso>"` and, since argv
  reaches git directly, those quotes were literal. git tolerates them — verified — but an unparseable date
  makes git filter out *everything* silently, so the failure mode was invisible. Timestamps now cross as
  epoch seconds, which also drops the original's `[a-z0-9]{40}` pattern that assumed SHA-1.

**A test isolation bug of mine, caught by running the whole suite.** The worktree test created its
worktree at `repo/../linked-worktree` — which resolves into the *shared* system temp directory, so it
passed alone and then failed in the full run against a leftover from the earlier one. Tests must write
only inside their own temp directory; it now uses a dedicated one.

**Partial staging landed next.** `lib/git/apply.ts` and its only prerequisite,
`lib/patch-formatter.ts`, now live in `apply.rs` and `patch_formatter.rs`. `FileToStage` carries the
domain `AppFileStatus` plus absolute selected-line indices only when a file is partial; full-file
staging keeps its small shape. `stage_files` preserves the original order: rebuild whole-file index
state first, then apply each partial patch sequentially.

The formatter keeps the non-obvious patch arithmetic the original depended on: an unselected
addition disappears, an unselected deletion becomes context, and a new file has no old side on
which context can exist. Partial staging uses `git apply --cached --unidiff-zero`; partial discard
omits `--cached` and takes the exact diff the user selected against, so a stale file fails rather
than discarding different lines.

Two details worth keeping:

- **`--unidiff-zero` is not optional.** A partial patch legitimately rewrites its own context — an
  unselected deletion becomes a context line — so git's usual check that the surrounding lines match
  would reject a patch that is correct.
- **The discard command takes the diff as an argument**, the only command that does. The line indices
  only mean anything against the diff the user was shown, so re-reading it in the backend could
  discard different lines. That gave the boundary its first *reverse* hydration:
  `dehydrateTextDiff` in `diff-ipc.ts` turns the domain classes back into the wire shape, and the
  proof it agrees with Rust is a test that dehydrates Rust's own snapshot output and compares, plus a
  Rust test that deserializes the same snapshot bytes back into `TextDiffData`.

Partial staging needs no command of its own: it travels as the `partial` field of an existing
`FileToStage`, so every path that already stages files — commit, merge commit, rebase continue, stash
— gained per-line selections without a new endpoint. 63 commands.

**`for-each-ref` landed next, and it was not in the plan — the plan said it was done.** A file-by-file
recount against the tree found it unported: `refs.rs` is `refs.ts`, and nothing produced the branch
list. That makes it the largest single thing Phase 2 was still missing, since `getBranches` feeds the
branch dropdown, the compare view and history, and `getBranchesDifferingFromUpstream` feeds
fast-forwarding. The lesson is the counting method: matching module names 1:1 makes a *missing* file
look like a renamed one, so the recount compared upstream filenames against the tree rather than
against the doc.

Both functions came over with the four upstream tests plus twelve more, and two fixtures
(`repo-with-many-refs`, `repo-with-non-updated-branches`) were vendored for them. `Branch` hydrates in
`branch-ipc.ts`, since its getters derive `remoteName`, `nameWithoutRemote` and `upstreamRemoteName`.
65 commands.

Three details worth keeping:

- **Timestamps come from git as epoch seconds, not ISO strings.** The original asked for
  `%(authordate:iso8601)` and handed the result to `new Date()` — but git's `iso8601` is
  space-separated (`2021-01-22 11:45:28 +0100`), which the ECMAScript spec does not require an engine
  to parse; it worked because V8 accepts it. `%(authordate:unix)` removes the parse and matches how
  every other timestamp crosses this boundary.
- **The worktree-path comparison canonicalizes both sides.** `getBranchesDifferingFromUpstream`
  excludes branches checked out in *other* worktrees by comparing `%(worktreepath)` against the
  repository path. git prints a fully resolved path, so on macOS — where a temp directory is reached
  through `/var` but reported as `/private/var` — the original's string comparison would have
  classified a branch checked out *here* as belonging elsewhere. A test reaches a repository through a
  symlink to pin this.
- **The SHA comparison is why this is one git invocation.** Ahead/behind counts would need a rev-list
  per branch; comparing each local tip against its upstream's tip answers "does it differ?" from a
  single `for-each-ref`.

**`deleteRemoteBranch` closed `branch.rs`.** Its recorded blocker had been stale for several slices —
`envForAuthentication` landed with the trampoline — so all it needed was the credential env the caller
already threads through push, pull and fetch. 66 commands.

Two behaviours are worth knowing, both the original's:

- **Authentication failures propagate as errors here**, unlike in `push` where they come back
  classified. The original said why in a comment: the caller handles them. So only
  `BranchDeletionFailed` is declared expected.
- **That one expected failure means the remote ref was already gone**, and the response is to delete the
  local remote-tracking ref instead of reporting anything. Someone else deleting the branch first
  produces the state the user asked for, and leaving the tracking ref would point at a branch that no
  longer exists.

**The hooks subsystem, first half.** `lib/hooks/**` was recorded in the map as a target directory that
had never been created, and four modules name "hook output" as deferred without pointing at it. It turns
out to be two very different halves.

What it exists for is worth stating plainly: a hook is a script the user wrote, and it assumes the
environment their *terminal* has — `nvm`, `rbenv`, `asdf`, `~/.local/bin`. A desktop app inherits none of
that, so a hook that works in a terminal fails when git is run by the app, usually with `command not
found`. Upstream's answer is to stop git running the hook directly: point `core.hooksPath` at stand-in
binaries, and have the app run the real hook via `git hook run` with an environment loaded from the
user's **login shell**.

**Landed:** `hooks/discovery.rs` (which hooks exist, honouring `core.hooksPath`, correct in a worktree),
`hooks/shell.rs` (shell selection and POSIX quoting), `hooks/shell_env.rs` (run the login shell, collect
what it built), and `rdc-printenvz` — a Rust replacement for the vendored ten-line C program, which
removes a native build step. 45 tests, nine of them end-to-end through the real binary and a real shell.

**Deliberately not landed:** `hooks-proxy.ts` and `with-hooks-env.ts`. Both are built on the
`process-proxy` npm package, which ships a *native binary*, so **its wire protocol is not in the
desktop-plus tree at all** — that half is a protocol design, not a port. The shape is already familiar:
it is what `trampoline` does for credentials, and it should be built the same way. Nothing about how git
is invoked changes until it lands, which is why the four hook-output deferrals stay open.

Three things worth keeping from the half that did land:

- **An upstream bug: a `"*"` filter returned no hooks.** `matchAll` sat on the *skip* side of the loop's
  condition, so asking for every hook skipped every hook. No caller passes `"*"`, so it was latent — but
  `withHooksEnv` reads an empty result as "no hooks here" and skips interception silently, so a caller
  using the documented wildcard would have got unhooked git invocations and no error. See
  `MIGRATION_MAP.md` §8.
- **The child shell gets an empty environment, not ours.** Inheriting rdc's variables would mask the very
  difference being looked for: the `PATH` the app was launched with would stand in for the one the user's
  init files build.
- **Its stdin is closed, where the original left the pipe open.** The shell runs interactive, so an init
  file that reads stdin is possible, and upstream would have blocked on it forever with no timeout.
  Markers around the output are what keep a chatty init file (a MOTD, a version manager announcing
  itself) from being parsed as environment variables — there is an end-to-end test for exactly that.

Windows shell support is described rather than half-ported: registry-based Git Bash discovery plus
MSYS2, PowerShell and `cmd` quoting is most of upstream's shell layer, none of it testable on the primary
target, and the setting that selects between them is frontend state.

**`safe.directory` closed the last user-facing dead end in the backend.** git refuses a repository owned
by another user — "dubious ownership" — and `RepositoryType::Unsafe` already detected that, but the
remedy was unported: rdc could tell the user their repository was unsafe and offer nothing. It has to be
the *global* config, because git won't read a repository's own configuration until it trusts the path.
67 commands.

**A ninth upstream bug, and a reachable one.** The existence check before appending passed the value as
`git config --get-all <name> <value>`, where that argument is a **value-pattern** — a regular expression
unless `--fixed-value` is given. So a path like `app (old)` made git exit **6** with `invalid pattern`,
an exit code the original didn't accept, and the call failed. Since this is the *recovery* path for an
unsafe repository, a user with an ordinary directory name containing `(`, `[`, `*`, `+` or `?` could be
left unable to open it at all. `--fixed-value` fixes it and makes the comparison exact, which replaces
the string comparison the original did afterwards to compensate for the pattern matching a different
value. Verified against real git; see `MIGRATION_MAP.md` §8.

The tests assert the end state rather than the config write: with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`,
git refuses the repository, and after vouching for the path it works.

**The hook proxy transport, which is a design rather than a port.** `process-proxy` ships a native
binary, so nothing about its wire format exists in the desktop-plus tree — the shape had to be chosen.
`trampoline` was already the answer to the same problem for credentials, so this follows it: a tiny
binary git runs, a loopback server, a token, every decision in the app.

```
 git ──runs──> rdc-hook-proxy ──TCP 127.0.0.1──> rdc ──runs──> git hook run <name>
```

Landed: `hooks/{protocol,client,server}.rs` and the `rdc-hook-proxy` binary, 58 tests of which twelve
run the real binary against a real server.

The choices worth recording, all of them consequences of what this protocol carries:

- **The response is framed, not a single reply** — `E` chunks of stderr followed by exactly one `X` exit
  code. A hook's output has to appear while it runs (a slow `pre-commit` printing nothing would look
  hung), and an exit code has to follow it. A bare stream could do the first but not the second. A test
  proves a chunk arrives *before* the hook finishes.
- **One binary serves every hook.** git runs `<hooksPath>/<name>`, so the name it was invoked as is the
  hook name — the same trick upstream's stand-in used.
- **The token matters more here than in the trampoline.** There, a valid token buys an answer to a
  credential prompt; here it makes the app **run a program**. So the token is 32 random bytes compared in
  constant time, the server binds loopback only, the request is size-capped because it must be read
  before it can be authenticated, and the server's lifetime is one git invocation rather than the app's.
- **The stand-in fails closed.** If the app can't be reached, it exits non-zero: a hook that didn't run
  is not a hook that passed, and reporting success would let a commit through that the user's
  `pre-commit` hook would have blocked.
- **Stdin is read only for the five hooks git pipes it to**, and carried as length-prefixed bytes.
  Reading it unconditionally would block until git closed the pipe — the trap `rdc-trampoline` already
  documents for askpass — so there is a timeout-guarded test that would fail by hanging.

**The hook runner landed after the transport**, which is the behaviour half: what happens once an
invocation arrives. `hooks/runner.rs`, 22 tests, all driving real hooks in real repositories.

It runs **`git hook run <name>`** rather than executing the hook file. git decides what running a hook
means — the interpreter, whether it exists, how arguments are passed — and executing the file directly
would put a second implementation of those rules here.

Details worth keeping:

- **git is resolved to an absolute path before the environment is replaced.** Rust resolves a bare
  program name through the *child's* `PATH` — verified experimentally rather than assumed — and the
  child's environment here is the user's *shell* environment. Leaving it as `git` would let a hook's
  shell decide which git ran it, or fail outright if that environment had no `PATH`. This also removes
  upstream's `ensureGitExecPathEnv`, which existed only to repair `GIT_EXEC_PATH` after invoking a
  *bundled* git built without a prefix.
- **`GIT_CONFIG_PARAMETERS` is the exclusion that matters.** It is how `core.hooksPath` gets pointed at
  the stand-ins, so a hook that inherited it would send every git command *it* runs back through the
  stand-ins and recurse into itself. There is a test for that specifically, alongside one for
  `GIT_ASKPASS` — a hook that pushes should use the user's own credential setup, not rdc's prompt.
- **The "don't ask about it" hook list does not mean "ignore the failure".** Upstream's
  `ignoredOnFailureHooks` suppresses the *prompt*; the exit code still reaches git unchanged, because
  git's own semantics already make it harmless for those hooks. Pinned by a test asserting both halves.
- **The closing status line is appended to the captured output before the prompt**, which upstream
  called out: the user is being asked whether to ignore *this* transcript, so how it ended has to be
  part of it.
- **`RDC=1` is set alongside `GITHUB_DESKTOP=1`.** The latter is compatibility, not identity — hooks in
  the wild test for it — and `RDC` is the honest signal to test for from here on.

Aborting kills the `git hook run` process. A hook that spawned children of its own may leave them
running; upstream's `AbortController` had the same limitation, and it is documented rather than papered
over.

**`withHooksEnv` closed the subsystem.** It is what ties the other four together, and the whole chain now
works against real git: install a stand-in per discovered hook, point `core.hooksPath` at it, run git, and
git runs the hooks through us. `hooks/with_env.rs` plus 13 end-to-end tests that drive actual commits and
pushes.

The tests are the interesting part, because each pins something that could only be verified by running the
whole thing:

- A hook runs **with the login shell's environment** and the commit succeeds.
- A failing hook **aborts the commit**; the same failure, ignored by the user, lets it through.
- **A hook that runs git does not recurse** — the hook's own `git config --get core.hooksPath` comes back
  empty, which is what excluding `GIT_CONFIG_PARAMETERS` buys.
- `pre-push` **gets its refs on stdin**, carried from git through the stand-in, the protocol, and into the
  file `git hook run --to-stdin` reads.
- **The login shell is started once per operation**, proven by a shell that counts its own invocations
  while three hooks run. Upstream memoized this too, and the reason is cost: an interactive login shell on
  a machine with version managers takes hundreds of milliseconds, and a commit runs up to six hooks.
- A **missing stand-in binary fails the operation** rather than quietly running git without interception.
  Skipping would mean the user's `pre-commit` hook doesn't run and nothing says so, which is worse than a
  failed commit.

Two more decisions worth recording. **Any existing `GIT_CONFIG_PARAMETERS` is kept in front** of ours,
because git reads the list left to right and the last entry wins — so the caller's configuration survives
and ours still applies. And the directory is **`sq_quote`-escaped**, which closes a TODO the original left
open ("could it possibly include a single quote? probably not?"): the parent is `TMPDIR`, which the user
sets, and an unescaped quote would let git read the rest of the path as configuration.

What was left outside this crate is now split cleanly: Phase 3 wired `HookInterception`, progress, abort,
and failure callbacks through the four commands that actually intercept upstream. Phase 7 still owns the
preference that enables interception and the failure dialog that answers abort/ignore.

**A capped read closed `show`'s deferral.** `getPartialBlobContents` reads the beginning of a blob —
enough for syntax highlighting to tokenize what is on screen — and the point is not to hold the rest in
memory, so slicing after the fact would defeat it. `exec::git_capped` reads to a limit and kills git.

The refactor came first: `spawn_git` and `finish_git` now hold the invocation setup and the exit-code
classification, so the ordinary and capped paths cannot drift on what counts as success or which failures
a caller declared expected.

Three things about the cap are worth keeping:

- **Truncation is success, not an error.** Node's `maxBuffer` *rejects* past the limit, so upstream caught
  the rejection and recovered `e.stdout` as its answer. That is an artifact of the API; here the prefix
  comes back with `truncated: true`.
- **git has to be killed.** Once reading stops it blocks writing to a full pipe and never exits, so
  nothing downstream would complete. Because the death is then a signal, the exit status is deliberately
  not classified — it would otherwise read as `GitError::Terminated`.
- **Stderr drains in its own task.** A git that filled *stderr* while stdout was being read would block
  before writing the bytes being waited for. A test with a 4 MiB blob and a 10-byte cap fails by hanging
  if either half of that is wrong.

For "how big is this blob?" the answer remains `git cat-file -s <rev>:<path>`, which doesn't read the
object at all; this is for when the prefix itself is what's wanted.

**Three small local primitives landed next.** `gitignore.rs` preserves the original line-ending
rules driven by `core.autocrlf` and `core.safecrlf`, including its deliberate escaping set for file
patterns. `checkout_index.rs` sends NUL-delimited paths to `checkout-index --stdin -z`, so newline
paths remain unambiguous, and keeps exit 1 as an accepted partial result. `format_patch.rs` emits
the original minimal, one-line-context mailbox patch for an exclusive commit range. These are
backend-local building blocks, so they add no IPC surface until a frontend workflow needs them.

**The whole-file counterpart sweep is complete.** `worktree.rs` preserves the NUL-delimited
porcelain parser, linked-admin-directory fallback, and add/move/remove operations.
`worktree_include.rs` uses Git-compatible ignore matching, copies only already-ignored files, and
keeps the original best-effort copy behavior plus its lexical path-traversal guard. `merge_tree.rs`
uses `merge-tree --write-tree` without touching the index or worktree, counts conflicted paths, and
classifies unrelated histories as invalid. These remain backend-local until their store/UI
consumers land.

**The LFS slice landed next.** `lfs.rs` installs global filters and repository hooks, detects
configured LFS patterns from `lfs track --json`, asks Git's attribute engine whether individual
paths use the LFS filter, and filters batches without reimplementing `.gitattributes` matching.
`GitLfsProgressParser` preserves the side-channel protocol and aggregates byte counts across files.

`git_with_stderr_and_lfs` creates a private progress file, tails it while Git is running, and removes
it on completion. Clone, fetch, pull, push, checkout, revert, and submodule update now report those
events. The progress file is a side channel because Git LFS is a filter process and does not write
its detailed transfer records to Git's stderr. Image previews remain a separate Phase 7 concern:
they require choosing how raw blob bytes cross IPC, not additional LFS plumbing.

**Conflict-resolution diffs followed as a backend-local slice.** `get_resolution_diff` compares the
working-tree conflict-marker file with either caller-supplied resolved content or Git's stage 2/3
blob. A missing stage is the deletion side of a modify/delete conflict and intentionally becomes an
empty target, matching the original. Private temporary files are removed by their RAII directory,
and the result keeps both exact content strings for later syntax highlighting and context expansion.
All five cases from `diff-resolution-test.ts` and `diff-stage-test.ts` are ported; no IPC shape was
needed.

**Multi-operation terminal output is now backend-local too.** A cloneable aggregator replaces the
original's nested callback/listener API: sequential Git operations share one bounded history, late
subscribers receive that history before live chunks, and live chunks remain untrimmed. Subscription
handles unsubscribe on drop. The six upstream cases run against two real `git version` processes;
one additional Rust test pins the RAII ownership behavior. Phase 3 subsequently added the concrete
per-command capture and Tauri Channel adapter for `create_commit`; the other upstream optional terminal
callbacks have no production consumer and are recorded for Phase 7 rather than exposed speculatively.

**What remains, by what blocks it:**

- **Filename-level whole-file counterparts:** **59 of 60; export coverage is 60 of 60 by concern.**
  `environment.ts` is the split exception: `envForAuthentication` is `authentication.rs`, but
  `envForProxy` resolves a proxy through Electron's
  `session.resolveProxy`, which has no Tauri counterpart — it needs reading the OS proxy configuration
  natively. **Rehomed to Phase 5** when Phase 4 was planned: this is a `session`-level capability, not a
  platform swap. **No remote operation has proxy
  support today**, not just the deferred ones; that gap is wider than the branch-deletion note below
  implied and is recorded here rather than inside one module.
- **Not a `lib/git` file, but adjacent:** `app/src/lib/hooks/**` (7 files, 863 lines). Discovery, shell
  selection, login-shell environment loading **and the proxy transport** have landed; `config.ts` is
  `localStorage`, so it belongs to Phase 7. Discovery, the shell environment, the transport, the runner
  and `withHooksEnv` have **all** landed — see the slice notes below. Phase 3 wired the four commands and
  their progress Channels. Phase 7 landed the bidirectional hook-failure prompt; the working-tree
  commit flow now intercepts by default and exposes an explicit **Bypass hooks** option that maps to
  `--no-verify`. Persisted hook-environment preferences remain later refinement.
- **Deferred inside ported modules:** the commit terminal stream now crosses in Phase 3. Phase 7 retains
  its bounded history and renders the progress dialog. Merge/rebase/push expose the same optional callback
  upstream but have no production consumer; pull declares it but never wires it into the Git options.
  `getFilesDiffText` and the remaining config/proxy helpers retain their named later owners.

**Landed, in order** (the counts below are historical, from each slice as it landed):
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

**Test-suite reality check.** `app/test/unit/git/**` is **51 files recursively** (45 top-level
plus 6 under `pull/` and `rebase/`), at least 36 of which build real repositories from fixtures
— this is an integration suite, not a set of string-parsing unit
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

**Also landed (third slice, 59 Rust tests): the first two command modules.**
- `init.rs` — `init_repository(path, default_branch)`. The branch is a **parameter**, not resolved
  internally: the original's `getDefaultBranch()` reads the user's global `init.defaultBranch` with
  a `"main"` fallback, which is ambient machine state plus app policy reached from inside a git
  primitive. It also made the original test tautological — it compared the result against the very
  function the code called, so it could not detect the argument being ignored.
- `add.rs` — `add_conflicted_file(repository, file)`, taking plain paths rather than the frontend
  `Repository`/`WorkingDirectoryFileChange` models. `file` goes after `--` so a path resembling a
  revision can't be misread. Built as `OsStr` since Unix paths needn't be UTF-8.
- `test_support.rs` gains `conflicted_repository()` (port of `setupConflictedRepo`), `commit_file()`
  and `unmerged_paths()`.

**A note on test oracles.** Neither original test could be ported verbatim: `init-test` and
`add-test` both assert through `getStatus`, and `lib/git/status.ts` isn't ported. Rather than port
status prematurely or skip the tests, they assert against **git itself** (`symbolic-ref`,
`ls-files -u`, `show :file`) — the same behavioural claims, with git as the oracle instead of
another unported module. Recorded per-module in `MIGRATION_MAP.md` §8.

**Also landed (fourth slice, 83 Rust tests): `config` and `rev-parse`.**
- `config.rs` — repository get/set/remove + git-boolean interpretation, plus a `GlobalConfig` type
  for the global scope. Global access carries its `HOME` **as a property of the accessor** rather
  than an optional trailing `env` argument, because "global" means whatever `HOME` says: a test
  that forgets it would write to the developer's real `~/.gitconfig`. `GlobalConfig::with_home()`
  is the test path, and a test asserts two homes can't see each other's values.
- `rev_parse.rs` — `RepositoryType` (`Regular`/`Bare`/`Missing`/`Unsafe`), `get_repository_type`,
  and the upstream-ref helpers. Path resolution is **lexical**, matching Node's `path.resolve`;
  canonicalizing would resolve symlinks and return a different path than the caller passed —
  immediately wrong on macOS where the temp dir is `/var` → `/private/var`.
- Deferred from `config.ts` at Phase 2 closure (all recorded in `MIGRATION_MAP.md`):
  `getGlobalConfigPath` **has since landed in Phase 4**; `getConfigValueWithOrigin` + its four
  display formatters still emit strings like
  `"global, via [includeIf]"` and so belong in the frontend. `addSafeDirectory` **has since landed** —
  see the slice note below.

`getDefaultBranch` is now unblocked by `GlobalConfig`, but its `"main"` fallback is app policy —
wire it up above `git-ops`, not inside it.

**Also landed (fifth slice, 118 Rust tests): `branch` and its helpers.**
- `branch.rs` — create/rename/delete/list, `get_branches_pointed_at`, `get_merged_branches`.
  `deleteRemoteBranch` **has since landed** — see the slice note below. (Its blocker was stale by the
  time anyone checked: `envForAuthentication` arrived with the trampoline.)
- `git_delimiter_parser.rs` (`createForEachRefParser`), `refs.rs`, `update_ref.rs` (`deleteRef`).
- `GitError::Parse` added, for "git succeeded but its output didn't match the requested shape".

Note that `branch-test.ts` mostly **doesn't test `branch.ts`** — its `tip` block drives `GitStore`
(Phase 7) and `upstreamWithoutRemote` tests the `Branch` model. Only two of its blocks were
portable, so most coverage here is new. `renameBranch`'s case-only-rename retry is untested
upstream despite being the file's subtlest logic; it now has tests, including the guard that
refuses to force a rename over a genuinely different branch.

---

### Phase 2 — `status` — **DONE**

Kept as a record of the analysis, because the architectural fork it settled — *which side owns
parsing* — is the reason `status_parser.ts` was deleted rather than kept, and that reasoning applies
again to every parser still to be ported (`diff`, `log`).

**The cascade was smaller than it looked.** `status.ts` imports from `diff-check`, `merge`, `diff`,
`rebase` and `cherry-pick` — 2,339 lines of host modules — but only needs **~106 lines** of
specific functions from them: `getFilesWithConflictMarkers` (19), `isMergeHeadSet` (4),
`isSquashMsgSet` (4), `getBinaryPaths` (15), `getRebaseInternalState` (50),
`isCherryPickHeadFound` (14). Those can be ported as partial modules rather than whole files.

**The real work is the parser**, and there is an architectural fork:

`lib/status-parser.ts` (426 lines, porcelain v2) was ported to **TypeScript** in Phase 1, with 12
passing tests — and currently has **no importers in rdc except its own test**. Meanwhile
`lib/git/status.ts` is destined for Rust. They can't both own parsing:

- **Rust parses (recommended).** `get_status` returns a typed `StatusResult` over IPC. Git
  execution and interpretation stay in one place, and the frontend receives structured data
  instead of raw porcelain. The Phase 1 TypeScript parser becomes dead and should be deleted when
  the Rust parser lands — its tests are not wasted, they become the Rust parser's spec, which is
  exactly the test-first principle.
- **TypeScript parses.** Rust would return raw `--porcelain=2 -z` bytes for the webview to parse.
  Keeps the Phase 1 work live, but splits git logic across the boundary and ships raw git output
  over IPC.

The first is the better architecture; the second only looks attractive because it preserves work
already done, which is a sunk cost, not a reason.

**DECIDED: Rust parses.** Sequencing, with step 1 complete:

1. ✅ **Port `status-parser.ts` → Rust** — `crates/git-ops/src/status_parser.rs`, using the
   TypeScript tests as the spec. `parse_porcelain_status`, `map_status`, and the status types
   (`GitStatusEntry`, `SubmoduleStatus`, `UnmergedEntrySummary`, `OrdinaryChange`, `FileEntry`,
   `StatusEntry`, `StatusItem`) ported from `models/status.ts`.
   - `src/lib/status-parser.ts` and its test are **deleted**. So is `src/lib/split-buffer.ts`,
     which existed only to serve that parser and is Node `Buffer`-based, so it could never have
     run in the webview.
   - Test math: 7 TypeScript tests replaced by **21 Rust tests** — the ported cases plus coverage
     the original lacked (unmerged entries, the rename similarity score, malformed input, a rename
     missing its original path, every conflict code, and submodule-code decoding).
   - Parsing takes `&[u8]`, not `&str`, because paths are arbitrary bytes on Unix; fields are
     decoded lossily, matching the original's `Buffer::toString()`.
   - The regexes need `(?s)` so the trailing path group can span newlines — in `-z` mode paths are
     unquoted, so a newline in a path is data rather than a delimiter. One of the ported tests
     covers exactly that.
2. ✅ **Port the helper functions** — `operation_state.rs` (the merge/squash/cherry-pick/rebase
   marker checks, collected from three large modules), `diff_check.rs`, `diff.rs` (`getBinaryPaths`
   only), and `LogParser`. Also added `rev_parse::resolve_git_dir`, which asks git via
   `--absolute-git-dir` rather than assuming `<repo>/.git` — correct for worktrees and submodules,
   where `.git` is a file pointing elsewhere.
3. ✅ **Port `getStatus`** — `status.rs`. **179 Rust tests green.**

**Two things worth knowing from step 3:**

- **An upstream bug is fixed.** `binaryListRegex` in `diff.ts` captures an *empty string* for a
  renamed binary file, because its greedy `.+` swallows both paths of a rename. Upstream, that
  means a renamed binary is never recognized as binary, so a conflict involving one is treated as
  text and the UI looks for conflict markers that cannot exist. Confirmed against Node and real
  git; fixed, with both a unit test and an end-to-end test.
- **`getStatus` returns git facts only.** The original built `WorkingDirectoryFileChange` objects
  carrying a `DiffSelection` — the lines/files the user has ticked for staging — wrapped in a
  `WorkingDirectoryStatus`. That is view state the UI mutates, so it stays in the frontend, which
  constructs it from `StatusResult`. The one piece of real logic in there is preserved as
  `StatusFileChange::starts_unselected` (a dirty submodule whose commit hasn't changed starts
  unticked), so the frontend doesn't have to rediscover the rule.

Also renamed `includeUntracked` → `list_untracked_files_individually`, because `false` does not
exclude untracked files — git's default still reports them, just collapsing untracked directories.
Details in `MIGRATION_MAP.md` §8.

---

### Re-check of the 15 deferred Phase 1 tests (after `status` landed)

**Result: none are unblocked. Zero.** All 15 still show near-identical blocker counts (75 `lib/git`,
36 `lib/stores`, 117 `ui`, 26 electron, 56 Node-IO files).

**Why porting git to Rust didn't help them**, which is worth stating plainly because it was the
expectation: these are *TypeScript* tests, and their closure reaches `lib/git/**` through
`import` statements. A Rust implementation gives the TypeScript side nothing to import. The blocker
was never "git isn't implemented"; it is "TypeScript still asks for git the Node way."

**All 15 enter the git layer through just eight edges:**

| Edge | Tests | What it should become |
|---|---|---|
| `models/repository.ts` → `../lib/git` | 5 | `Repository` becomes a plain data type. Resolving a remote URL is a Rust query — which also fixes the `Repository.url` fire-and-forget bug, since a data type can't do IO. |
| `lib/app-state.ts` → `./git/config` | 3 | A Rust-backed config query; `app-state.ts` is a large state-type module that shouldn't reach into git. |
| `models/commit.ts` → `lib/git/interpret-trailers` | 2 | Trailer parsing is git text-processing → **Rust**. The TS model receives already-parsed trailers. |
| `models/popup.ts` → `../lib/git` | 1 | Also needs `Electron.Certificate` (see §9 of the map). |
| `lib/trampoline/trampoline-environment.ts` → `../git/core` | 1 | Already planned as the `crates/trampoline` Rust sidecar. |
| `lib/format-commit-message.ts` → `./git/interpret-trailers` | 1 | Same as `models/commit.ts`. |
| `lib/stats/stats-store.ts` → `../git` | 1 | |
| `lib/stores/cloning-repositories-store.ts` → `../git` | 1 | |

**✅ DONE — `interpret-trailers`, and the first deferred test recovered.**

The fix turned out to be smaller and better than "port the module to Rust". `models/commit.ts`
imported only two things from `lib/git/interpret-trailers`: the `ITrailer` type (a plain pair of
strings) and `isCoAuthoredByTrailer` (a case-insensitive token comparison). **Neither needs git.**
They sat in a git module by association, and that one edge pulled the whole git layer into the
commit model. So the work split:

- **`crates/git-ops/src/interpret_trailers.rs`** — everything that genuinely runs git:
  `parse_trailers`, `merge_trailers`, `get_trailer_separator_characters`, plus the unfolded-trailer
  parsing they depend on.
- **`rdc/src/models/trailer.ts`** — the type and the predicate, as a layering extraction (same
  pattern as `BypassReasonType` in Phase 1).

**Measured result, matching the prediction exactly:**
- `create-branch` is **unblocked and ported** — `src/lib/create-branch.test.ts`, 9 tests passing,
  along with the `models/commit.ts` → `models/branch.ts` → `models/tip.ts` → `lib/create-branch.ts`
  chain it needed. First of the 15 recovered.
- `pull-request-refs` is down to **exactly one** blocker, as predicted:
  `lib/markdown-filters/emoji-filter.ts` using `fs/promises`.
- The other 13 are unchanged.

**✅ DONE — `pull-request-refs` recovered, but *not* the way this plan predicted.**

> **Correction to the note above.** It claimed the emoji data becoming a bundled asset was "the
> single thing standing between `pull-request-refs` and a port". That was wrong — it read the
> blocker's *name* (`emoji-filter.ts` using `fs/promises`) as the blocker's *cause*. Tracing the
> actual chain:
>
> `pull-request-refs.ts` → `issue-mention-filter.ts` → `node-filter.ts` → `emoji-filter.ts`
>
> `pull-request-refs.ts` needs exactly one thing from that chain: `IssueReference`, a `RegExp`
> constant. Because it's a value rather than a type it can't be erased at compile time, so it
> dragged in the filter class, which imports the pipeline builder, which constructs `EmojiFilter`,
> which reads PNGs off disk. **Four hops from a regex to filesystem access.**
>
> The fix was extracting the regex constants into `lib/markdown-filters/issue-reference.ts`.
> `pull-request-refs` is now ported (`src/lib/pull-request-refs.test.ts`, 6 tests) with **no
> filesystem dependency anywhere in its closure**. No emoji work was needed.

**This is the third instance of one pattern**, and it is worth stating as a rule: in this codebase,
*shared constants and types are routinely co-located with heavy implementations*. Each time, a
consumer needed only the declaration and inherited the implementation's whole dependency tree:

| Consumer needed | Was co-located with | Cost |
|---|---|---|
| `BypassReasonType` (type) | a React dialog | pulled 120 `ui/` files into `lib/api.ts` |
| `ITrailer` + `isCoAuthoredByTrailer` | `git interpret-trailers` calls | pulled the git layer into `models/commit.ts` |
| `IssueReference` (regex constant) | a markdown filter class | pulled `fs/promises` into `lib/pull-request-refs.ts` |

**So when a port looks blocked, check what the consumer actually imports before porting the
dependency.** Twice now the answer has been a few lines of extraction rather than the large piece of
work the blocker's name implied.

**The emoji work is still real, just not urgent.** `read-emoji.ts` reads `emoji.json` off disk and
`emoji-filter.ts` base64-encodes PNGs — both should become bundled frontend assets (and in a webview
the base64 step can go entirely, since `<img src="/emoji/…">` just works). But nothing consumes them
until the markdown filters are ported, so building it now would be an orphan. **Do it with Phase 7.**

**✅ DONE — the `Repository` redesign. 5 tests recovered, and the bug is now unrepresentable.**

`Repository` is a plain data type. `url` is a readonly field supplied by whoever loads the
repository; the `_url`/`fetchUrl()` machinery is gone, along with the imports of `lib/git` and
`lib/stores`. **A data type cannot do IO, so the fire-and-forget bug is unrepresentable rather than
merely fixed** — the first read no longer returns `null`, repeated reads can't spawn repeated
`git remote` processes, and there is no un-caught promise.

`resolvedGitDir` was dropped too. It was `gitDir ?? join(path, '.git')`, which is wrong for worktrees
and submodules where `.git` is a *file*. Every consumer was in `lib/git/**` or `git-store.ts` — all
Rust-bound — and Rust resolves it correctly by asking git (`rev_parse::resolve_git_dir`).

Supporting work, all of it the same co-located-declaration pattern:
- **`models/custom-integration.ts`** — `ICustomIntegration` extracted out of
  `lib/custom-integration.ts`, which imports `child_process`, `fs`, `fs/promises` and
  `windows-argv-parser`. **Fourth instance.**
- **`lib/path-utils.ts`** — a `basename` that Node's `path` was being imported for. Tested against
  `node:path/posix` directly rather than hand-written expectations, which caught a genuine surprise:
  Node compares the suffix against the *entire path*, so `basename('.git', '.git') === ''` but
  `basename('/foo/.git', '.git') === '.git'`. Reproduced deliberately. Deliberately **no
  `normalize`/`resolve`** — those edge cases belong in Rust's `std::path`.
- Ported `models/worktree.ts`, `models/editor-override.ts`, `lib/text-token-parser.ts`,
  `lib/wrap-rich-text-commit-message.ts`, `lib/emoji.ts`, and cleaned up
  `models/cloning-repository.ts`'s leftover Node `path` import from Phase 1.

**Recovered (5): `repository`, `name-of`, `model-type-guards`, `text-token-parser`,
`wrap-rich-text-commit-message`.** The deferred list is now **8**, down from 15.

**Remaining 8 and what each needs:**

| Test | Blocker |
|---|---|
| `format`, `ipc-contract`, `multi-commit-operation` | `lib/app-state.ts` → `git/config`; `app-state.ts` also reaches `ui/lib/application-theme` |
| `popup-manager` | `models/popup.ts` → UI dialogs **and** `Electron.Certificate` (Phase 5) |
| `ssh` | `lib/trampoline/**` → the Rust sidecar (`crates/trampoline`) |
| `stats-store`, `app-store-test-harness` | `lib/stores/**` (Phase 7) |
| `format-commit-message` | `mergeTrailers` over IPC (Rust side exists) + a TypeScript repository-setup test helper (Phase 3) |

**✅ DONE — `app-state` decomposition. 2 of the 3 recovered; the deferred list is now 6.**

`app-state.ts` was **not** ported. It is 1,319 lines with 49 imports — every piece of application
state in one file, from window widths to Copilot conflict resolutions — and importing a single type
from it drags in the whole tree, including `lib/git/config` and `ui/lib/application-theme`.

Instead it is being **decomposed per concern** into `src/lib/app-state/`, one file per extraction, as
consumers need it (see that directory's README). Extracted so far: `IBranchesState`,
`MultiCommitOperationConflictState`, `IConstrainedValue`. When `app-state.ts` is eventually ported
with the stores in Phase 7, it should **re-export from these** rather than redeclare them.

**A second finding worth generalizing: the god-module types were over-specified at the call site.**
`lib/multi-commit-operation.ts` declared parameters as `IRepositoryState` and
`IMultiCommitOperationState`, but reads only `state.branchesState` and `state.step.kind`. So the
parameter types were **narrowed to the subset actually read**:

```ts
type RepositoryStateForChooseBranch = { readonly branchesState: IBranchesState }
type OperationStateForConflictsFlow = { readonly step: { readonly kind: MultiCommitOperationStepKind } }
```

TypeScript is structurally typed, so **callers are unaffected** — a full `IRepositoryState` still
satisfies the narrower type. Two field reads no longer depend on 1,319 lines, and the signature now
documents the real contract. Worth checking for elsewhere: naming a large state type when you read
one field of it is how a god module acquires its gravity.

**Recovered (2): `format`, `multi-commit-operation`** (20 tests). `ipc-contract` stayed blocked, as
expected — `lib/menu-update.ts` needs `IAppState`, the actual root state type, *and* `lib/ipc-shared.ts`
uses the ambient `Electron` namespace. That one is Phase 3.

**Remaining 6, all genuinely phase-gated — the cheap extraction wins are now exhausted:**

| Test | Blocker | Phase |
|---|---|---|
| `ipc-contract` | `IAppState` (whole module) + ambient `Electron` IPC types | 3 |
| `format-commit-message` | `mergeTrailers` over IPC + a TypeScript repository-setup test helper | 3 |
| `ssh` | `lib/trampoline/**` → the `crates/trampoline` Rust sidecar | 2 |
| `popup-manager` | `models/popup.ts` → UI dialogs **and** `Electron.Certificate` | 5 / 7 |
| `stats-store`, `app-store-test-harness` | `lib/stores/**` | 7 |

**✅ DONE — `crates/trampoline`, plus `ssh` recovered. 240 Rust tests; deferred list now 5.**

`crates/trampoline` replaces **two** things at once, which is the improvement this phase promised:
the vendored `desktop-trampoline` **C binary** (a node-gyp native addon built per platform) and the
TypeScript half in `app/src/lib/trampoline/**`. One Rust crate, one toolchain.

git can't prompt a GUI for credentials, so it spawns a helper and reads the answer from its stdout.
rdc points `GIT_ASKPASS`/`SSH_ASKPASS`/the credential helper at `rdc-trampoline`, which forwards its
argv, environment and stdin to the app over loopback and prints the reply:

```text
 git ──spawns──> rdc-trampoline ──TCP 127.0.0.1──> rdc (TrampolineServer)
  ^                    │                                    │
  └───── stdout ───────┘<──────────── reply ───────────────┘
```

- `protocol.rs` — the NUL-framed wire format, ported from `trampoline-command-parser.ts` and the C
  client. NUL framing is load-bearing: prompts span multiple lines and argv can contain anything but
  NUL. Environment entries split on the **first** `=` so values may contain `=`.
- `token.rs` — the security boundary. The port is on loopback but **any local process can connect**,
  so a per-operation random token is what distinguishes git-invoked-by-us from anything that found
  the port. Comparison is constant-time (the original's `Set.has` was not), and `scoped()` revokes via
  a drop guard so it survives an unwind.
- `server.rs` — accepts, authenticates, dispatches to injected handlers, one task per connection so a
  slow prompt can't block another git process.
- `bin/rdc-trampoline.rs` — deliberately dumb. One subtlety: it reads stdin **only** for the
  credential helper. Askpass invocations get no stdin, and reading unconditionally would block until
  git closed the pipe — deadlocking the prompt. There's a timeout-guarded regression test for it.

**Handlers are deliberately out of scope**: deciding which account to use, prompting, and storing
credentials need account state and UI, so they arrive with Phase 3/7. The server takes handlers as
injected closures precisely to keep that boundary clean.

**Verification worth noting**: besides 36 unit tests there are **7 end-to-end tests that spawn the
real compiled binary** (via `CARGO_BIN_EXE_`) against a real server. Unit tests exercising each half
against the other in-process cannot catch a mismatch in argv handling, environment forwarding, the
stdin decision, or how the reply reaches stdout — which is exactly where a two-process protocol
breaks.

`ssh` was recovered separately and cheaply: `parseAddSSHHostPrompt` is a pure regex parser that sat
in `lib/ssh/ssh.ts` next to `getSSHEnvironment`, which imports the trampoline paths and `fs`. Sixth
instance of the co-located-declaration pattern; extracted to `lib/ssh/ssh-host-prompt.ts` (4 tests).

**Historical handoff, subsequently reconciled:** `ipc-contract` is superseded by the exact 82-channel
measurement plus its regression tests. Phase 3 supplied the `merge_trailers` command required by
`format-commit-message`; its helper/test now travels with the Phase 7 store and UI consumers.
The remaining four deferred test modules are `popup-manager` (Phase 5/7), `format-commit-message`,
`stats-store`, and `app-store-test-harness` (Phase 7).

**Historical next step (now complete):** the rest of `lib/git/**` —
commit/checkout/merge/rebase/stash/push/pull/fetch/log/remote/tag. The remote ones
(push/pull/fetch/clone, and `deleteRemoteBranch`) can now use the trampoline for credentials, though
their handlers were subsequently wired through Phase 3 commands.

**Subsequent Phase 3 disposition:** the status types now carry their serde contracts and are pinned by
the Rust serializer snapshot plus TypeScript fixtures. Binding generation was evaluated and rejected;
the paired contract tests prevent drift without duplicating domain types.

**Next:** step 2, then step 3.

<details><summary>original phase description (count corrected after recursive audit)</summary>
- Port `app/test/unit/git/**` (51 files recursively, largest single test category) as the acceptance spec for `crates/git-ops`.
- **Keep shelling out to the system `git` binary** (Rust `tokio::process::Command`), do **not** switch to `git2`/libgit2. This mirrors dugite's own deliberate choice — libgit2 has known gaps with LFS, credential helpers, partial clone, and hook execution that real desktop Git clients depend on. Reimplementing dugite's spawn/parse logic in Rust is more work than a libgit2 rewrite would save, and avoids a category of subtle correctness bugs.
- Each `dugite`-based file in `app/src/lib/git/` maps to one Rust module in `crates/git-ops/src/`; port the parsing/formatting logic test-by-test.
- `trampoline/` (10 files) + `ssh/` (4 files) → `crates/trampoline`, compiled as a small Rust sidecar binary bundled via Tauri's sidecar mechanism, replacing the vendored `desktop-trampoline` native binary. This is a real improvement: one Rust toolchain instead of a separately-maintained vendored binary per platform.

</details>

### Phase 3 — IPC surface → Tauri commands — **COMPLETE — 104 COMMANDS AT CLOSURE**

The phase started with `get_status` wired end to end from Rust to React and closed with **104 registered
commands**. Later platform phases use the same pattern; the repository currently has **146 registered
commands**, each with a typed wrapper.

#### What this phase is, measured

**The 82 channels in `ipc-shared.ts` are entirely not git** — the routing pass confirmed it, with **not one
channel owned by this phase**. They are menus, window state, crash reporting, the auto-updater,
notifications, dialogs, theme, URL and CLI actions, accounts and `resolve-proxy`: 70 to Phase 4, 5 to
Phase 6, 4 to Phase 5, 3 to Phase 9. (Phase 4 was 71 and Phase 5 was 3 until planning Phase 4 rehomed
`resolve-proxy`.) Git never crossed IPC in Electron at all — the renderer called dugite
in-process — which is why every git row in `MIGRATION_MAP.md` §7.2 reads "no direct equivalent — new",
and why the channel inventory was a *routing* exercise rather than a work list. (82, not the 77 this
document claimed for two phases; the number had never been derived from the file.)

The work list is the **store layer's call surface**: upstream's `lib/stores/**` imports **122 names** from
`lib/git`, of which 13 are types, leaving **109 functions**. Every one has a proven consumer, which is the
bar a new command has to meet.

**`scripts/measure-store-surface.mjs` produces these numbers**, and it exists because the earlier figure in
this document — "104 distinct functions" — could not be reproduced. Whatever filter produced it went
unrecorded, so a recount disagreed with it and there was no way to tell which count was wrong. The script
takes the classifications that used to live in prose here (which names are types, which belong in
TypeScript, which a later phase owns) and turns them into data it checks, exiting non-zero when anything
is uncovered. It needs the upstream checkout, so it is a local gate at the end of a slice rather than a CI
job. A number in a plan that nobody can re-derive is a claim, not a measurement.

| | Count | Note |
|---|---|---|
| Has a command | 98 | of 146 currently registered |
| Lives in TypeScript by design | 8 | the script verifies the named file exports it |
| Owned by a later phase | 3 | `envForRemoteOperation` (Phase 5c for proxy, Phase 7d/7f for remote/account consumers); `getConfigValueWithOrigin`, `getFilesDiffText` (Phase 7) |
| **Not covered** | 0 | the classification is exhaustive |

**The 8 in TypeScript**, each because a round trip would buy nothing: `formatAsLocalRef`, `revRange` and
`revSymmetricDifference` are string manipulation; `isCoAuthoredByTrailer` is a predicate over one object;
`getBranchAheadBehind` composes `get_ahead_behind` with `revSymmetricDifference` and its branch-specific
cases are decidable from data the frontend already holds; `git` is the exec wrapper that `git-ops`
replaces rather than exposes; and `memoizedGetRemotesFromPath` is a caching decorator, which is the store
layer's call to make and not something to bake into the boundary.
`parseSingleUnfoldedTrailer` is pure line parsing beside `isCoAuthoredByTrailer`; the Rust copy remains
for backend parsing, while the frontend copy avoids one IPC round trip per commit-message line. A command
that computes a string from a string is a command that shouldn't exist.

**The two former gaps are closed**:

- **`fetchRefspec`** now has a command and typed wrapper, using
  `TrampolineState::session_for` exactly as `fetch` and `delete_remote_branch` do.
  Note this **corrects an earlier claim**: the credential env was filed under Phase 4 via
  `envForRemoteOperation`, but the trampoline landed in Phase 2, so what remained was proxy support and
  account state, not this — and planning Phase 4 then moved the proxy half to Phase 5 and the accounts
  half to Phase 7, leaving Phase 4 nothing here at all.
- **`parseSingleUnfoldedTrailer`** now lives in `src/models/trailer.ts` next to
  `isCoAuthoredByTrailer`; it deliberately has no command.

**The three commands that had no consumer were removed**, while their backend functions and tests remain:

| Command | Upstream situation |
|---|---|
| `get_authors` | `getAuthors` has **no caller at all** upstream, not even a test — dead since some earlier refactor |
| `fetch_tags_to_push` | called only by `app/test/unit/git/tag-test.ts`; the tags-to-push indicator is fed from local storage instead |
| `stage_manual_conflict_resolution` | **internal** to upstream's `lib/git`, called by `stageFiles` and `cherry-pick.ts` — and ours is internal too, since `create_commit` stages manual resolutions itself |

They were speculative wire surface rather than missing functionality. The reverse-direction check now
finds **zero consumerless commands**: 97 answer store imports and 7 have named consumers outside the store
import set.

The earlier recount lesson still holds and now has a second layer: **count functions, not files**, and
**check both directions** — coverage of the consumer list says nothing about surface the list never asked
for.

#### Decisions settled before starting

**Raw bytes cross the process boundary as a custom URI protocol, not in a command response.** An
`rdc-blob://` scheme handler in Rust serves blob contents, so `<img src>` and CSS reach them directly and
the bytes never enter JSON. base64 in a response was the alternative and is rejected for the consumer that forced the question:
a 4 MB PNG becomes ~5.5 MB of JSON string, copied twice, living in JS memory for as long as the diff is
open. The implemented handler is scoped with an opaque, random capability token whose registry entry
binds it to one repository/revision/path request; constructing a repository path in a URL grants nothing.

**Order: Phase 2's handovers first, then the command surface.** The hook and byte-representation work is
what other phases are blocked on, and the hooks half is freshest now.

#### Slices, in order

1. ~~**Hook interception, wired.**~~ **Done** — see the slice note below. Note the plan overstated the
   scope: upstream intercepts in **four** modules, not five. `rebase.ts` passes no `interceptHooks` at all,
   which a grep confirmed before any code was written.
2. ~~**`rdc-blob://` plus image diffs.**~~ **Done** — see the slice note below. The protocol handler and its scoping, then `getBlobImage`/
   `getWorkingDirectoryImage` and the `DiffType::Image` arm. Blob readers remain Rust-internal: the full
   read is served through the capability URL, while the bounded text-prefix consumer belongs to Phase 7.
   Closes `diff.rs`'s image-production deferral without adding raw-byte commands. Checked before starting:

   - **`DiffType.Image` already exists** in the ported enum at discriminant **1**, so the Rust arm slots
     into the existing numeric contract without touching it.
   - **The `Image` domain model changes** from `{ rawContents, contents, mediaType, bytes }` to
     `{ url, mediaType, bytes }`. Its only consumer is one component — `ImageContainer.loadImage` — which
     builds a `data:` URI for everything except DirectDraw Surface textures, where it converts
     `rawContents` in JS. A URL makes the first case simpler than it is today and the second a `fetch`
     away, with no base64 inflation and nothing large in JSON. It is a **ported type changing while its
     consumer is unported**, which is the cheapest moment for it: Phase 7 writes against the new shape
     from the start.
   - **`getMediaType` is ported in Rust**, because the protocol handler is what sets `Content-Type`.
     The port uses the registered `image/jpeg` media type rather than upstream's `image/jpg`.
   - **CSP is currently `null`.** When Phase 5a adds one it must allow `rdc-blob:` in `img-src` and
     `connect-src`; recorded there rather than guessed at here.
   - **URL construction goes through a helper**, since Tauri serves custom schemes through different URL
     forms per platform. Verified in the Linux container before anything is built on top of it.
3. ~~**Command batches, by domain**~~ **Done.** Branch operations → reset/stage →
   rev-list ahead/behind → the three diff functions → config → worktrees → gitignore → LFS →
   mergeability and repository state → trailers, each a full vertical slice: command, typed wrapper, both
   halves of the wire contract, tests. `fetchRefspec` is exposed, `parseSingleUnfoldedTrailer` is kept in
   TypeScript by design, and the three consumerless commands are gone.
4. **The routing table** (`MIGRATION_MAP.md` §7): one row per upstream channel, its direction, and the
   phase that owns it. The measurement script parses the table and compares the exact upstream names,
   directions, and counts, so a channel cannot be ported twice or forgotten silently.

#### Exit criteria

Measured by `scripts/measure-store-surface.mjs`; all implementation criteria are green.

- ✅ Every function `lib/stores/**` imports from `lib/git` either **has a command**, **stays in
  TypeScript by design**, or **names the later phase that owns it** — the same rule Phase 2 closed on.
  **109 of 109**, with zero uncovered.
- ✅ **No command without a consumer.** Phase 3 closed at 104/104; the current reverse audit is
  **146 of 146** — 98 answer store imports and 48 name a consumer outside that import set.
- ✅ Every shape that crosses is in the snapshot, with a TypeScript fixture annotated against
  `src/models/**`. **57 keys, every one referenced from a test** — checked by walking the snapshot rather
  than by inspection, since an unused key is invisible.
- ✅ Every command has an actual typed TypeScript `invoke()` wrapper. **146 of 146 currently.**
- ✅ The 82 channels are each routed, so Phase 4/6/7/9 inherit a list rather than a search —
  `MIGRATION_MAP.md` §7.1. The script checks all **53 request** and **29 request/response** names against
  upstream rather than accepting a matching total, and checks each row's direction against the type that
  declares it: request/response exactly when the channel is in `RequestResponseChannels`. Which way a
  *simplex* channel points was read from whether `ipcRenderer.send`/`ipcMain.on` or
  `ipcWebContents.send`/`ipcRenderer.on` names it, and that half is not re-derived on each run — a table
  edit could get an arrow backwards without failing the check.

**Closed 2026-07-29:** Phase 3's implementation and measurement criteria are complete. The closure
revision passed the required local gates and is held to the same standard in CI. Remaining work is
explicitly owned elsewhere: platform commands by Phase 4, proxy integration by Phase 5c, the capability URL's
production CSP by Phase 5a, and UI/store consumers—including terminal history and the unused upstream
merge/rebase/push/pull terminal callbacks—by Phase 7.

**What closing on these criteria does not buy, learned immediately after.** A review of the closure
revision found `create_merge_commit` dropping a conflict's index entries, which made a modify/delete
conflict resolved in favour of the deleting side *uncommittable* — see `MIGRATION_MAP.md` §8. **All four
exit criteria were green while that bug existed, and would have stayed green.** They measure the
*surface*: that every consumer has a command, every command has a caller, every shape is pinned, every
channel is routed. None of them looks at whether a command does the right thing — that is what tests do,
and the gap was a missing test, not a missing measurement. Worth remembering when Phase 4 writes its own
exit criteria: a command counted is not a command that works.

**Decisions settled by the slice, each of which was blocking:**
- **Native Tauri IPC, no codegen** (see the struck-through item below), with a wire-contract test as
  the mitigation.
- **Serialization shapes chosen so the already-ported TypeScript is reused, not duplicated.**
  `GitStatusEntry` serializes to its single characters (`'M'`), `UnmergedEntrySummary` to kebab-case,
  `AppFileStatusKind` to PascalCase — exactly the values in `src/models/status.ts`. `AppFileStatus`
  uses serde's **internally tagged** representation, which reproduces the original TypeScript
  discriminated union (`{ kind: 'Modified', … }`) precisely; `ConflictedFileStatus` is **untagged**,
  because the original distinguished its two shapes by the *presence* of `conflictMarkerCount` rather
  than a discriminator.
- **`Option` fields are omitted, not `null`**, matching TypeScript optional properties under
  `strictNullChecks`.
- **Errors keep their classification.** Tauri requires the error type to implement `Serialize`, and
  the usual `.map_err(|e| e.to_string())` would discard the work in `git_error_kind.rs`. Commands
  return a `CommandError { message, kind, isAuthFailure }` instead, so the UI can branch on a
  specific failure without parsing prose — which is also what keeps user-facing wording in the
  frontend, per the `getDescriptionForError` decision.
- **Streaming uses Channels, not events.** Tauri's docs are explicit that events are not for
  high-throughput data. Git progress and the concrete commit terminal stream therefore use Channels.
  `create_commit` is the only terminal stream added: it is the only one with a production consumer
  upstream. Merge/rebase/push merely expose unused optional callbacks, and pull declares one without
  passing it to Git.

Also committed the generator for `git_error_kind.rs`
(`crates/git-ops/scripts/generate-git-error-kind.mjs`), which previously lived only in a scratch
directory even though the generated file told you to re-run it. The TypeScript `GitErrorKind` enum is
likewise derived from the Rust source rather than hand-typed, so its 60 variants can't drift.

**Commit and checkout landed next**, with their prerequisites: `unstage_all` (reset), `stage_files`
(update-index), `remove_conflicted_file` (rm), and `stage_manual_conflict_resolution` (stage). Eight
commands are now exposed. Three things are deliberately deferred, each with a named prerequisite
rather than an intention:

- ~~**Partial (per-line) staging**~~ **Done**, in the `apply` + `patch_formatter` slice below.
- **Checkout progress** is now a `Channel`, not a callback (see the streaming note above).
  ~~**Submodule updates**~~ **Done**, with `lib/git/submodule.ts`.
- **Hook progress** (`interceptHooks`, `onHookProgress`) is also a Channel. The working-tree commit flow
  intercepts hooks by default so they run with the user's shell environment and its failure dialog can
  supply the abort/ignore decision. Its explicit **Bypass hooks** option is semantically different: it
  sends `--no-verify`, so the hooks do not run.

A third upstream bug turned up here, and this one was pinned by a test: `parseCommitSHA` returns the
string `"(root-commit)"` instead of a SHA for a repository's first commit, and the original asserted
exactly that. The port asks `rev-parse HEAD` instead of parsing git's summary line, and returns the
full SHA. See `MIGRATION_MAP.md` §8.

Also worth recording, because it shaped the design: **command arguments needed their own contract
test.** The wire snapshot pins what Rust *serializes*, but `FileToStage`, `CommitOptions` and
`ManualConflictResolution` travel the other way, so what matters is that Rust can *deserialize* what
`invoke` sends. `wire_contract.rs` now has a second section of tests written as the literal JSON the
frontend produces.

**Merge and non-interactive rebase landed next.** `merge`, `getMergeBase`, `abortMerge`, `rebase`,
`continueRebase`, and `abortRebase` are ported through Rust, Tauri commands, typed invoke wrappers,
and both halves of the wire contract. The tests build real divergent repositories and cover clean
merge, noop merge, merge conflict/abort, merge-base lookup, rebase conflict state, abort, unresolved
continue, resolved continue, omitted tracked files, selected unrelated tracked changes, and keeping
untracked files out of the replayed commit.

Interactive rebase subsequently landed through the `reorder` and `squash` commands and their
generated todo-list flows; ordinary branch-on-branch rebase remains the simpler path described here.

The port pins `rebase.backend=merge`. The state/status code already expects the
`.git/rebase-merge/**` files (`orig-head`, `head-name`, `onto`), and relying on a user's global
`rebase.backend=apply` would silently switch git to a different state layout. This makes the
assumption the original code already had deterministic.

**The first streaming Channel landed with checkout progress.** `exec::git_with_stderr` drains
stdout/stderr concurrently, retains stderr for classification, and also delivers raw stderr chunks
to a transport-neutral callback. `checkout.rs` incrementally parses Git's carriage-return-delimited
`Checking out files: N% (x/y)` records into the already-ported `ICheckoutProgress` shape; only the
Tauri command layer knows about `Channel<CheckoutProgress>`. Branch, remote-branch, and commit
checkout wrappers accept an optional frontend callback, while always supplying the command's
Channel. A closed webview drops progress updates without cancelling git and leaving the repository
half-switched.

Checkout reserves the final 10% for submodule updates, matching the original weighting. The
submodule implementation has now landed and fills that final portion; before it existed, checkout
temporarily emitted an explicit `value: 1` after git succeeded.

**Rebase now reuses that stream.** Start and continue parse Git's `Rebasing (n/m)` stderr records
incrementally and emit the existing `IMultiCommitOperationProgress` domain shape through a Channel.
The new partial `rev_list.rs` port supplies full-SHA commit summaries in replay order. When a
conflict interrupts the operation, `getRebaseSnapshot()` reconstructs the same progress plus the
complete commit list from `.git/rebase-merge/{msgnum,end,orig-head,onto}` and `REBASE_HEAD`, so a
reopened frontend can recover without having observed earlier Channel events. A real two-commit
repository test covers the initial event, snapshot recovery, conflict resolution, and the continued
event.

`getRebaseSnapshot` is why the merge backend is pinned: the recovery contract reads
`.git/rebase-merge/**` directly, so a user's global `rebase.backend=apply` would silently hand it a
different state layout. `git-ops` stays independent of Tauri throughout — only the command layer
adapts callbacks to Channels.

**Historical checkpoint at 67 commands.** The next work at that point was the literal `ipc-shared.ts`
inventory, hook and terminal Channels, raw-byte blob transport, configuration/reset surfaces, and
trampoline handlers that needed account state. Those slices are described by their completed entries
below rather than by this old queue.

Note the sequencing argument here competes with Phase 2's: the channel inventory produces a *queue*,
whereas `diff` removes the thing that makes the app unusable. `diff` first, then the inventory.

<details><summary>original phase description</summary>
- `app/src/lib/ipc-shared.ts` declares 82 channels (this said 77) — treat this as the literal spec. Build a table (in `MIGRATION_MAP.md`) of channel → Tauri command/event, and knock them out systematically rather than ad hoc as UI needs them.
- Request/response channels (`ipcMain.handle`) → `#[tauri::command]` + `invoke`.
- Main→renderer push channels (`webContents.send`) → `app.emit()` + `listen()`, or a **Channel** for
  anything streaming (git progress, terminal output).

</details>
- ~~**Improvement**: adopt `tauri-specta` (or `ts-rs`)~~ — **DECIDED AGAINST after prototyping
  ts-rs against the real types.** ts-rs emits string-literal unions (`"M"`) where the ported models
  use `enum`, and TypeScript string enums are nominal — so its output is not assignable to
  `src/models/status.ts`. The deeper reason: a Rust→TS generator assumes Rust owns the domain model,
  but here the 50+ ported types in `src/models/**` own it. Full evaluation in `MIGRATION_MAP.md` §8.
  **rdc uses Tauri's native IPC**: `#[tauri::command]` + `invoke`, with events and Channels for the Rust→frontend
  direction. No binding generator, no extra dependency.

  The tradeoff is real and needs a mitigation, since a hand-written TypeScript contract is the very
  thing criticised about `ipc-shared.ts`. The mitigation went through two rounds, and the first was
  not enough:

  - `crates/git-ops/tests/wire_contract.rs` pins the exact JSON of every boundary type, and
    `src/App.test.tsx` pins the command name and camelCase argument names. This caught a real
    mistake immediately — `#[serde(rename_all)]` on an enum renames *variants*, not fields, so the
    conflict types were emitting `conflict_marker_count`.
  - **But pinning Rust against JSON written in the same file is not pinning it against the domain
    model.** A conflict shape passed every one of those assertions while being unusable by
    `src/lib/status.ts`: the Rust flattened `action`/`us`/`them`, the ported `models/status.ts` nests
    them under `entry`, and the Rust, its test, and `git-ipc.ts`'s own redeclared type were all
    wrong together. Two definitions of one domain concept is what made it invisible.
  - The fix closes the loop with no hand-copied JSON: Rust **emits** its real serializer output to
    `src/lib/__generated__/wire-snapshot.json`, and `src/lib/git-ipc.test.ts` compares it to fixtures
    annotated with the ported types — so `tsc` checks the shape against `src/models/**` and the
    assertion checks it against Rust. Neither side can drift alone. Verified by reintroducing the
    flattened shape and watching the suite go red.

  The rule that came out of it: **if a type already exists in `src/models/**`, the IPC layer imports
  it — never redeclares it.**

**Slice 1: hook interception is wired.** The four operations that reach hooks — `commit`, `merge`, `push`,
`pull` — now take the machinery and run the repository's hooks with the **user's shell environment**. 68
commands.

The design decision worth keeping is **who owns the list of hooks**. It is the operation, not the caller:
a commit reaches `pre-commit`/`prepare-commit-msg`/`commit-msg`/`post-commit`, `--amend` also reaches
`post-rewrite`, a squash merge reaches the commit hooks *in addition* to the merge ones, and a push reaches
only `pre-push`. A frontend cannot know that, and a list it could pass would let it ask for a hook git never
runs — or miss one it does. So the app supplies a `HookSupport` (where the binaries are, which shell, who to
tell) and each operation names its own hooks. The four lists are upstream's, taken from its own reading of
`githooks(5)`.

Three consequences of turning callbacks into messages:

- **`HookProgress` cannot cross IPC**, because it carries an abort handle — a live thing, not data. So the
  wire carries an **id**, the app keeps a table of running hooks, and `abort_hook(id)` looks the handle up.
  `false` from it means the hook had already ended, which is not an error: the user cancelled a moment late.
- **The failure prompt is a seam, not a stub.** A failing hook can be *ignored* by the user, which needs an
  answer from the UI, so `HookSupport::with_failure_prompt` is left at its conservative default: a failure
  is a failure and git aborts the operation, exactly as it would without rdc. That is the trampoline's
  `Decline` decision again — declining is correct behaviour — and Phase 7 fills the seam rather than
  changing anything here.
- **Interception is off unless asked for.** The switch is a `localStorage` setting upstream, so nothing
  turns it on until the preferences UI exists. `None` is not a degraded mode: git runs the hooks either way,
  just with the app's environment rather than the user's.

The wire type moved to `git-ops` mid-slice, for a reason worth recording: it started in the app crate, where
**the snapshot generator cannot reach it** — and a hand-written JSON literal in the snapshot would break the
one property that makes it worth having, that it is Rust's real serializer output. `HookStatus` grew a
`Serialize` derive instead of a second wire-only twin, since `git-ops` already serializes dozens of types.

Nineteen tests drive the chain through `create_commit` itself: the hook sees the shell environment, a
refusing `pre-commit` stops the commit, an amend intercepts `post-rewrite` and a plain commit does not, and
the reported hooks are exactly the four a commit reaches, in git's order.

**Slice 1b: commit terminal transport is wired, and only where it has a consumer.** Upstream's app store
passes `onTerminalOutputAvailable` only to `createCommit`; that listener backs the “Show commit progress”
dialog. `create_commit` therefore streams the real commit process's combined stdout and stderr through a
`Channel<String>`. The `git-ops` side stays transport-neutral and a test observes the real Git commit
summary; the TypeScript command test pins the Channel argument and chunk callback.

The Channel is deliberately a live transport rather than frontend state. Phase 7 must attach its receiver
when the command starts, retain a bounded history for a dialog opened later, expose the subscription through
repository state, and clear it when the operation ends. Phase 7 also owns the separate hook-failure popup
and its asynchronous abort/ignore answer. A one-way terminal stream cannot answer that prompt, so the two
features must not be conflated.

No matching Channel was added to merge, rebase, or push: each exposes the optional callback in its library
API, but no production caller supplies it. Pull is stronger evidence against mechanical parity — it
declares the callback but never puts it in the options passed to `git`, so it is a no-op upstream. Adding
those four command arguments would violate the “no wire surface without a consumer” rule, and making pull
work would be an unrecorded behavior change.

**Slice 2: image diffs, over a URL rather than through JSON.** `rdc-blob://` serves blob bytes to the
webview, and `Diff::Image` finally has something to name. No new command — deliberately: the point is that
bytes *don't* cross as a command result.

**A URL is a capability, not a query.** The design that first suggests itself —
`rdc-blob://…?repo=…&rev=…&path=…`, validated against the repositories the app has open — turns out to be
unimplementable today, and finding out why was the useful part: there is no backend list of open
repositories. That state lives in the frontend store until Phase 7, so a validating handler would have had
nothing to validate against, and "serve any path on disk" is the failure mode. Instead Rust registers a blob
it has decided to expose and returns an opaque token. The webview fetches what it was handed and can name
nothing else, which makes the scoping structural rather than a rule I could get wrong — the trampoline's
argument, reused.

Consequences worth keeping:

- **`git-ops` cannot mint URLs**, since a URL's shape belongs to the webview host and the table that resolves
  one is app state. So it takes a `BlobUrls` trait, the same arrangement as `HookSupport` — and with no
  minting passed, an image is reported as `Binary`, which is exactly what the app showed before.
- **The `Image` model changed** from base64 to `{ url, mediaType, bytes }`. Its only consumer builds an
  `<img src>` — or fetches bytes for a DirectDraw Surface texture — so both cases are served without anyone
  paying for base64. Changing a ported type while its consumer is unported is as cheap as this ever gets.
- **Sizes come from `git cat-file -s`**, which answers without reading the object. The two-up view shows both
  sides and the difference between them, so the number is not optional.
- **An SVG is both.** It gets an image diff that also carries the text diff, so the viewer can offer a Code
  tab — upstream's behaviour, and nothing is lost by keeping it.
- **An unreadable side is absent, not an error**, which settles a TODO upstream left on `${oldest}^`: a file
  added in a repository's first commit has no parent to read, and "no previous version" is what an added file
  has.

`getMediaType` came over too, with one correction: upstream answers `image/jpg` for `.jpg`, which is not a
registered media type. Checked before changing it — the only place any consumer *compares* a media type is
the DirectDraw branch — and it matters more here than upstream, because the value is now a `Content-Type`
header rather than the middle of a `data:` URI.

`.dds` is excluded from the image extensions, matching upstream's default: it gates those previews behind a
feature flag whose converter is frontend code.

Also worth recording, because it invalidated part of the plan: **the two blob readers do not need commands.**
That bullet assumed bytes would cross as results. Images go over the protocol, and the one remaining consumer
— syntax highlighting — wants a bounded *text* prefix, which JSON carries perfectly well. When it lands it
will be an ordinary command returning a string.

**Slice 3 begins with branch operations**, the largest group the store layer needs and none of which had a
command: `createBranch`, `renameBranch`, `deleteLocalBranch`, `getBranchesPointedAt`, `getMergedBranches`,
`deleteRef`, `getSymbolicRef`. 75 commands. They live in a new `commands/branch.rs`, since branches are their
own domain in the store layer and `git.rs` was already long.

`formatAsLocalRef` went the other way — into `src/lib/refs.ts` as TypeScript, because it computes a string
from a string and a round trip to Rust would buy latency and a wire contract in exchange for nothing. That
leaves the rule implemented in both languages, which is accepted here and not in the diff-expansion case for a
reason: it is four lines, and the same cases are asserted on both sides.

**Wiring it up found a real defect.** `rename_branch` recursed through `Box::pin(rename_branch(…))` for its
case-only-rename retry, which makes the future's type refer to itself — so proving `Send` never terminated and
the function **could not be called from a Tauri command at all**. It compiled fine until something asked it to
cross a thread boundary. The recursion was never more than one level deep, since the retry passes
`force: Some(true)` and an early guard returns immediately on that, so the fix was to spell the second attempt
out. That also makes "at most once" evident, which is what `get_commit_range_diff` concluded about the same
pattern.

Two API details worth keeping, both of which a test pins:

- **An omitted `force` is not `false`.** Omitted allows a case-only rename by retrying with `-M`; `false`
  refuses every collision. A wrapper that sent `false` for an absent argument would quietly break renaming
  `Topic` to `topic` on a case-insensitive filesystem.
- **`getBranchesPointedAt` returns `null`, not `[]`, for a committish that doesn't resolve.** No branch
  pointing at a commit that exists is an answer; asking about a commit that doesn't is a mistake, and the two
  should not look alike.

**The reset/stage batch closed three of the eight function-level gaps**: `reset`, `resetPaths` and
`stageResolvedConflictFiles`, plus `unstageAllFiles` — which turned out to live in `rm.ts`, not `reset.ts`, and
is a genuinely different operation from `unstageAll` (`rm --cached` empties the index; a reset restores it to a
commit). 80 commands.

`GitResetMode` went to **`src/models/git-reset-mode.ts`**, for the reason `IndexStatus` did: an enum that
crosses IPC is a domain type. It is numeric, and `Hard` is **0** — so a missing or zeroed field selects the
mode that discards the working tree, which is why nothing gives it a default and why a test pins the number.

**An upstream comment I misread cost a wrong first attempt**, and the correction is the useful part.
`resetPaths` passes paths on stdin, which upstream did only on Windows via `git reset --stdin`, noting that the
flag "hasn't made it to Git core". I read that as "it has since", used it everywhere, and git answered
`unknown option` — it is still a Git for Windows extension. git core's portable equivalent is
`--pathspec-from-file=- --pathspec-file-nul`, which does the same job on every platform, so paths now go that
way always. That removes both problems an argument list has: the platform's length limit, and the
impossibility of passing a path containing a newline. A test resets exactly such a path.

`stageResolvedConflictFiles` takes git facts rather than upstream's `WorkingDirectoryFileChange` plus a `Map`,
the same split `getStatus` made — a `ResolvedConflict` carries the path, the index entries, the marker count
and the chosen side. Two kinds count as resolved and they stage differently: a side picked in the app, or a
marker count of **zero**, meaning the user edited until nothing was left. Anything else is left alone, because
staging a file that still has markers would commit them — and a test asserts exactly that.

**The rev-list batch closed two more gaps and added only one command**, which is the interesting part. Of
`rev-list.ts`'s six unported exports, exactly one needed git:

- **`getAheadBehind`** is the command. `--left-right --count` does the work, and `null` is an answer rather than
  a failure: a ref in the range no longer exists — usually a deleted upstream — so there is nothing to be ahead
  *of*, and a caller with a blank label to fill should not be handling a rejection.
- **The three range builders** are string concatenation, so they are `src/lib/rev-range.ts`.
- **`getBranchAheadBehind`** is TypeScript too, and that is the call worth explaining: every branch-specific
  decision in it — a remote branch has no upstream of its own, a local one without an upstream has nothing to
  compare against, and the range is two names and three dots — is one the frontend can make from data it
  already holds. Only the counting needs git. So it answers `null` in both those cases **without asking**, and
  a test asserts `invoke` was never called.
- **`doMergeCommitsExistAfterCommit`** has no consumer outside `ui/history/**`, so it lands with those
  components rather than now.

Two details the tests pinned that I would otherwise have got wrong. The **direction** of `--left-right` in a
symmetric difference: for `main...topic`, `ahead` counts what *main* has. And `AheadBehind` already existed in
`status` — the compiler caught the duplicate — because `git status --branch` answers the same question about a
different range, so there is one type rather than two to keep in step with `IAheadBehind`.

**The diff readers closed the last three function-level gaps**, so all eight are now done:
`getBranchMergeBaseDiff`, `getBranchMergeBaseChangedFiles` and `getCommitRangeChangedFiles`. 84 commands, and
`diff.ts` is complete but for `getFilesDiffText`, which stays with its store consumer.

What the two merge-base readers exist for is worth stating, because the name doesn't say it: `--merge-base`
compares a branch against **the point the two branches last shared**, not against the other branch's tip. Diff
the tips directly and every commit the base branch has gained since appears as though the comparison branch
deleted it. A test builds exactly that situation — `main` gains a commit after `topic` branches off — and
asserts only the topic branch's own work is reported.

Two behaviours preserved rather than smoothed over:

- **No common ancestor is `null`, not an error.** Unrelated histories are a real state — there is no point to
  compare from — and a caller rendering a comparison view has nothing to show either way. A test builds an
  orphan branch to reach it.
- **A range starts at the oldest commit's *parent***, so the range includes its own change. For a repository's
  first commit `<sha>^` doesn't resolve, and the retry against git's empty tree is what keeps that range
  readable. Written as a two-iteration loop rather than the original's recursion, the same choice
  `get_commit_range_diff` and `rename_branch` made.

`tsc` also earned its keep on this batch: a test fixture written as `{ kind: 'Modified' }` failed to compile,
because TypeScript string enums are **nominal** — which is precisely the property that makes these fixtures a
check on the wire shape rather than a restatement of it, and precisely why ts-rs was rejected.

**The expose-only batches landed together**: config, `.gitignore`, LFS, worktrees, mergeability, repository
state, operation state, `checkout-index` and trailers. **106 commands at that historical checkpoint**;
the final measured surface is 104 after three consumerless commands were removed and `fetch_refspec` was
added. The Rust side needed no new logic —
every one of them wraps a function that already had tests, which is what "expose-only" was supposed to mean.

Three things still needed deciding rather than typing:

- **`RepositoryType` went to `src/models/repository-type.ts`**, the third type to make that move after
  `IndexStatus` and `GitResetMode`, for the same reason each time: a type that crosses IPC is a domain type. It
  is internally tagged on a **lowercase** `kind` with camelCase fields, which is the spelling the original used
  — so ported code comparing against `'unsafe'` keeps working.
- **`installGlobalLFSFilters` takes no repository**, because the operation isn't about one. It still needs *a*
  working directory that exists, so it runs in the temp directory — the same answer `GlobalConfig` reached,
  where the original used its own install directory.
- **Two state queries resolve the git directory themselves.** `operation_state` takes a git directory rather
  than a repository, deliberately, so `get_status` can resolve it once; a command has no such luxury, so
  `is_cherry_pick_head_found` and `get_rebase_internal_state` call `resolve_git_dir` first. Joining `.git`
  would be wrong exactly where it matters — a linked worktree, where `.git` is a file.

`.gitignore` gets **two** append commands rather than one, which is worth keeping straight: patterns go in as
written, because `*` and `?` are what make a pattern a pattern, while file *names* have their glob characters
escaped — otherwise ignoring `weird[1].txt` would quietly ignore something else.

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

### Phase 4 — Native platform integrations — **COMPLETE — 4a / 4b CLOSED**

Phase 4 owns the **69** channels §7.1 routes to it, plus the `main-process/**` and backend-bound `lib/**`
files §3 and §4 assign to it. (It was 71 until `resolve-proxy` moved to Phase 5 — decision 2 below.) It is
the largest phase in the plan by channel count and the only one where most of the work does **not** land
in Rust.

**Current implementation status:** Linux/macOS editor discovery, validation and launch are complete;
Linux/macOS shell discovery and launch are complete; Windows runtime integration is explicitly Phase 10.
The menu slice has its audited keybinding foundation: all 52 upstream accelerator declarations are
pinned item-for-item, their 50 logical bindings cross as a typed Rust/TypeScript wire shape, and
Rust-owned override persistence plus conflict-checked `get`/`set`/`reset` commands and change events are
implemented. The Electron-free `AppMenu` model, state-derived default/test menu tree and capture-phase
Linux/Windows dispatcher are also implemented; the audit proves every binding ID exists in that tree.
The native macOS mechanism is implemented too: a minimal pre-webview menu reads persisted bindings,
`set_native_menu` replaces it with the canonical renderer tree, native roles stay native/localized, and
selection re-enters the frontend as a structured action. The current React harness now performs that
replacement during macOS startup: it installs the complete default structure with neutral labels,
leaves native roles plus external links, Select All, zoom, reload and one-window quit operational, and
visibly disables actions that still require Phase 7's dispatcher. General and nested contextual menus
are implemented with the upstream index-path return contract. The WebKit spell-check investigation and
Wayland-safe synthetic edit menu now move with their text-input consumers to Phase 7. The old
`select-all-window-contents` round trip is also gone:
`selectAllWindowContents` now executes `document.execCommand('selectAll')` in the renderer.
The macOS default menu has been manually validated in a real `pnpm tauri dev` launch. The Phase 0
container now runs its first real WebDriver specs: application launch plus nested contextual-menu
selection and dismissal across React, Tauri IPC, muda/GTK, Rust and back. macOS native-menu automation
remains outside that Linux-only harness by construction; its structure/action boundary is covered by
unit tests and the real menu bar was manually verified. The first general platform-wrapper group is
also complete: focus, minimize, maximize, restore, close, maximized/focused queries and title updates
call the current Tauri window directly under explicit capabilities. Tauri's single boolean focus event
replaces Electron's separate `focus`/`blur` channels. The surface audit now measures typed subscription
adapters explicitly (and therefore correctly credits the already-landed `menu-event` bridge): **10 of
58** Phase 4 proxy exports and **3 of 15** Phase 4 subscriptions were implemented at that checkpoint.
Window state and zoom are now layered on that foundation: the frontend-owned `WindowState` union keeps
upstream's precedence, resize plus wrapper transitions replace Electron's state channel, and a Rust
per-webview map backs the getter Tauri does not provide while the setter and event share the same owner.
The macOS close path's initial manual follow-up exposed that Tauri's default window capability permits
enumeration but not `hide()`; the explicit hide permission and its regression test now cover the
actual last-window behavior instead of only the mocked frontend call.
The `window-state` plugin saves geometry but skips automatic restore for `main`, because the plugin would
otherwise show it before the renderer is ready. That lifecycle slice is now complete: `main` starts
hidden; Rust records native ready/page-load durations; the renderer sends its elapsed time; and the
one-shot command restores size, position and maximization before showing/focusing the window and
emitting the upstream three-field launch-timing payload. Visibility is deliberately excluded from
plugin restoration because the handshake owns it; fullscreen retains its separate policy. Startup
decorations now come from the Rust-owned `titleBarStyle` read before `main` exists. The adjacent theme
slice is complete too: application-wide light/dark/system selection,
resolved-dark queries, payload-free change notification and native window background color all use
Tauri directly under explicit capabilities. Paths/files/dialogs/trash are now complete as a second
frontend-facing group: typed Tauri path mappings and OS architecture replace Electron queries,
opener handles URLs, file paths and reveal, Rust conservatively classifies macOS application bundles
before opening folder contents, and the `trash` crate performs recoverable deletion in a blocking
task. Open/save dialogs translate the subset of Electron options the real consumers use and return
the same first-path-or-`null` result. App lifetime then reversed three synchronous Electron flags into
one preventable frontend close decision, and the process/log plugins are wired under explicit
capabilities. The application menu now has one frontend owner across all platforms: it executes current
items locally, refreshes the native macOS tree after structure or binding changes, and supplies live
tree/binding state to the Linux/Windows keydown dispatcher. Five Electron proxy shapes and the
`app-menu` subscription therefore disappear. Selected-repository metadata is also implemented as a
window-scoped Rust routing hint, stored verbatim and cleared by `null` or native destruction. The
explicit new-window command creates a fresh webview from the startup template, queues its one-shot
open-repository action until that renderer is ready, and never normalizes the requested path. Closing
one of multiple windows destroys only that window; the last-window hide/quit policy remains unchanged.
The audit is now **39 of 58** proxy exports and **8 of 15** subscriptions implemented: **39 of 39**
Phase 4a wrappers and **8 of 8** Phase 4a subscriptions. The remaining 19 wrappers and 7 subscriptions
belong to 4b; `url-action` moved to Phase 9 with the single-instance/deep-link seam.
Its capability and Linux initialization are covered by the Ubuntu 26.04 container's six real
application-launch, menu, dialog, multi-window and process-lifetime WebDriver specs.

**Closure evaluation (2026-07-30):** `measure-platform-surface.mjs --require-complete` reports
**58/58 wrappers and 15/15 subscriptions**, and the reverse audit reports no unowned command.
The Phase 2 `getGlobalConfigPath` handoff, which sat outside that proxy measurement, is now implemented
and test-first. Config and install-ID persistence are read back through fresh owners, and the updater's
complete lifecycle is fake-backend tested. Phase 4 therefore closes as the Linux/macOS implementation
phase. Native-session evidence is not erased: Phase 8b covers the behavior exposed by 7a–7e on Linux
and macOS, followed by its final local-package pass; Secret Service, packaged-macOS
Keychain/notification/attention/CLI and signed-release checks travel with their post-MVP consumers in
Phase 9 when the MVP does not expose them. Every Windows backend and runtime check is Phase 10. That
ownership split is target structure, not a parity claim.

#### What this phase is, measured

The channel table is a routing decision, not a work list — the same distinction Phase 3 drew. Splitting
the 69 rows by the mechanism each one names:

| Mechanism | Count | Where the code lands |
|---|---|---|
| **No IPC** — a Tauri/plugin API the frontend calls directly | 37 | `src/lib/platform/**` |
| Frontend event or plugin listener | 5 | `src/lib/platform/**` — the three quit channels, `notification-event`, `log` |
| `#[tauri::command]` | 21 | `src-tauri/src/commands/**` + `platform/**` |
| `emit` from Rust | 5 | `src-tauri/src/platform/**` |
| Deleted rather than routed | 1 | `get-config-migration-result` — guiding principle 6 |

Re-derive with:

```sh
awk '/^### 7.1/,/^### 7.2/' MIGRATION_MAP.md | grep '^| ' | grep -v '^| Phase ' | grep '| 4 |'
```

then partition on the mechanism column. **The `grep -v '^| Phase '` is load-bearing**: §7.1 opens with a
per-phase summary table whose own rows end in a phase number, and without excluding them the four phase
totals sum to 85 rather than 82. That is how the first draft of this table published 71/23 — the
miscount was in the measurement, not the map.

**42 of 69 need no Rust at all**, which inverts the intuition this section was originally written with
("each of these is a self-contained swap" — most of them are not swaps, they are deletions). Five more
collapse into one frontend controller: the auto-updater's push channels were separate only because
Squirrel reported progress from another process.

That does not make the 42 free. Each needs the Tauri API **confirmed on WebKitGTK** rather than assumed
from the docs, a capability permission added, and a wrapper under the name upstream used — because §5
already decided rdc keeps a central IPC module, so these are not orphans in the Phase 1 Step 3 sense.
Their consumers are known and counted: 33 upstream files import `ui/main-process-proxy.ts`.

**Upstream code in scope, measured** (~5,400 lines): menus 1,447 (`main-process/menu/**` 8 files, plus
`models/app-menu.ts` at 669 and `lib/menu-item.ts` at 134), editors 1,400 (7 files), shells 1,269
(6 files), `main-process/main.ts` 1,050, `main-process/app-window.ts` 657, `lib/custom-integration.ts`
230, `lib/parse-pac-string.ts` 123, `main-process/notifications.ts` 125, `main-process/migrate-config-dir.ts`
96, `lib/window-state.ts` 64, `lib/stores/token-store.ts` 19 (nineteen lines of keytar calls).
**Of that, 2,487 lines are Windows-only** (`shells/win32.ts` 587, `editors/win32.ts` 631, and the
`registry-js`/WOW64/toast-CLSID paths) and are explicitly not in scope — see below.

#### The work list is `ui/main-process-proxy.ts`

Phase 4 has the same verification problem Phase 3 had: every consumer is unported UI, so "is it done"
cannot be answered from this repo. Phase 3 answered it by measuring against upstream's store imports.
The Phase 4 analogue is better than that, because upstream centralised the whole surface in one file
that declares each channel with its arity:

- **67 entry points** — `main-process-proxy.ts` has 69 exports, two of which (`invokeProxy`, `sendProxy`)
  are the typed proxy factories rather than channels.
- **19 subscriptions** — the distinct channels named by `ipcRenderer.on(...)` across `ui/` and `lib/`.
  The Phase 4 kickoff measurement corrected the planned count of 18: `app-menu` had been omitted from
  the prose even though its route was already present in §7.1.

`scripts/measure-platform-surface.mjs` (new, sibling to `measure-store-surface.mjs`, needs
`../desktop-plus` so it is a local gate rather than CI) parses those 86 names out of upstream and checks
each one in **both directions** against what rdc provides: a registered command, a `src/lib/platform/**`
export, a named later phase, or a recorded "no equivalent" with its consequence. Both directions,
because Phase 3's reverse check is what found three commands nobody asked for.

**Kickoff baseline (measured, not estimated):** all 67 proxy entry points are classified: 58 belong to
Phase 4, 8 to Phases 5/6/9, and `getConfigMigrationResult` is deliberately deleted. Of the 19 subscribed
channels, 15 belong to Phase 4 and 4 to later phases. Phase 4 starts with 0 of its 58 wrappers and 0 of
its 15 subscriptions implemented; the script reports those as pending while failing only on structural
inventory errors until the phase's exit gate is applied.

#### Decisions settled before starting

**1. The menu splits: TypeScript owns the structure, Rust owns the key bindings.**

*Structure → TypeScript.* Upstream's menu lives in the main process because Electron requires it there,
and on Windows and Linux the app then *serialises it back* to the renderer over `get-app-menu`/`app-menu`
so React can draw it — `app-window.ts:88` makes the window frameless when `titleBarStyle === 'custom'`,
and `ui/app-menu/**` renders the menu bar. But the decisive fact is not the frameless window: it is that
**`buildDefaultMenuTemplate` takes 11 app-state fields** (`models/menu-labels.ts` — selected editor,
selected shell, two confirmation preferences, the contribution-target default branch truncated to 25
characters *for display*, force-push state, PR presence, stash visibility, repository type, filter
visibility), and `lib/menu-update.ts` computes a 531-line enablement policy on top. The menu is a
**continuous function of frontend state**, not a static definition that happens to sit in the main
process. Rust owning it means the frontend pushing 11 fields plus an enablement map on every relevant
change so Rust can re-template — which is precisely what upstream does, and precisely because Electron
left it no choice.

So `build-default-menu.ts` ports to a TypeScript module the React menu bar renders directly, and
`models/app-menu.ts` (669 lines) stops being an Electron *adapter* and becomes the menu model proper —
unblocking the Phase 1 deferral recorded in `MIGRATION_MAP.md` §1.

*Bindings → Rust, and this is what makes the split non-obvious.* **macOS requires a native menu bar** —
an application cannot draw one in-window — and Rust builds it before the webview has finished loading.
Anything the menu needs at that moment **cannot live in webview storage**. That is the same argument this
plan already accepts for `titleBarStyle`, which is a Rust-side config read exactly because it decides the
window before the window exists. Independently: a keybinding map is the artifact users hand-edit, diff
and sync between machines, and `localStorage` inside a WebKit data directory is opaque and non-portable.

So `platform/keybindings.rs` owns a `MenuId → binding` map: defaults in Rust, user overrides persisted to
a JSON file in the app config directory, `get`/`set`/`reset` commands, an `emit` when it changes, and
**conflict detection at set time** since that is where the map is authoritative. Both sides key on
`src/models/menu-ids.ts`, already ported in Phase 1 — which is why that small enum matters more than it
looked.

*The enabling change: 52 accelerator declarations come out of the template.* They are inline literals in the
773-line definition today, and **you cannot rebind what is baked into a literal.** Extracting them with
**identical defaults is a data reorganisation, not a behaviour change**, so guiding principle 3 holds —
the rebinding *UI* is the new feature, and it is Phase 7's. Doing the extraction during the port costs
one pass; retrofitting costs a second pass over the same 52 sites. Same call §9 already makes ("bind each
extraction to the phase that ports its consumer") and the same call Phase 3 made on the `Image` model: a
ported type changing while its consumer is still unported is the cheapest moment for it.

The declarations produce **50 logical bindings**, not 52: `preferences` and
`repository-preferences` each occur in both the macOS application menu and the non-macOS File menu with
the same default. `scripts/measure-menu-accelerators.mjs` preserves both invariants separately: its
ordered source audit has 52 entries, while the runtime map has 50 unique menu IDs.

*A binding crosses as structured data, never as a string.* Upstream's `"CmdOrCtrl+Shift+P"` has three
consumers — muda's `Accelerator` for the macOS menu, a `KeyboardEvent` matcher for the Linux/Windows
dispatcher, and `friendlyAcceleratorText` (in `ui/app-menu/menu-list-item.tsx`) for display. Crossing the
string would implement that grammar twice in two languages, which is what `AGENTS.md` rule 2 forbids and
what produced the duplicate-`AppFileStatus` bug. Rust parses once, resolves `CmdOrCtrl` against the real
platform, and crosses `{ modifiers, key }` the frontend matches directly against the event. The `key`
is specifically the physical `KeyboardEvent.code` vocabulary (`KeyP`, `Digit1`, `Comma`), not the
layout-dependent `KeyboardEvent.key`: Tauri 2.11's native menu setter parses through muda's physical
`Accelerator`, so this gives both consumers one representation instead of introducing a second key
translation.

macOS starts with a **minimal Rust bootstrap menu** because the native menu must exist before the webview
loads. It contains only lifecycle-safe items and the Rust-owned bindings; it does not duplicate labels
or enablement policy. After `renderer-ready`, TypeScript pushes the canonical state-derived structure,
labels and enablement to replace that bootstrap menu. Later state changes use the same push path.

*What this costs in channels, stated precisely.* **Three disappear on every platform**
(`get-app-menu`, `app-menu`, `execute-menu-item-by-id`); `update-menu-state` and
`update-preferred-app-menu-item-labels` disappear **on Linux and Windows only** and survive on macOS with
their **direction reversed** — renderer→main, because Rust needs labels and enablement to build the native
menu. `menu-event` narrows to the macOS native menu. An earlier draft of this section claimed five
unconditional deletions; that was wrong, and macOS is why.

*And the genuinely new code:* Electron registers accelerators natively and they fire on Linux with the
menu bar hidden. `models/app-menu.ts` carries `accelerator` and `menu-list-item.tsx` only *renders* it —
verified, nothing upstream dispatches it — so the Linux/Windows dispatcher is a spike, not a port.

**2. Proxy support leaves Phase 4 entirely, and Phase 5 owns it.** `envForProxy` resolves through
Electron's `session.resolveProxy` — the same `session` object as `webRequest`, which is already Phase 5's
subject. Phase 5 also already owns the three other network channels with no Tauri equivalent
(`update-accounts`, `certificate-error`, `show-certificate-trust-dialog`), is already flagged as the
plan's highest architectural risk with explicit design time budgeted, and "needs a redesign, not a port"
describes the proxy exactly. The later MVP reorganization assigns it specifically to Phase 5c, which
inherits `envForProxy`, `getFallbackUrlForProxyResolve`, `resolve-proxy` and
`lib/parse-pac-string.ts` (123 lines, with an upstream test). **The consequence stands: no remote
operation has proxy support today**, and it will not until Phase 5c.

**3. Windows moves to Phase 10**, extending the stance `MIGRATION_MAP.md` §3 already takes for hooks:
`shells/win32.ts`, `editors/win32.ts`, `lib/process/win32.ts`, `registry-js` → `winreg`,
`find-toast-activator-clsid.ts`, WOW64 detection, and the Windows implementation of
`install-windows-cli`/`uninstall-windows-cli` are deferred to one explicit Windows phase. Phase 9 owns
the shared packaging/external-action design; Phase 10 owns the Windows registry, shim and installer
behavior. That is 2,487 of the 5,400 lines before those adjacent runtime seams are counted. Rust
modules and shared domain enums still carry the Windows seam so Phase 10 adds `#[cfg(windows)]` arms
rather than restructuring Linux/macOS code.

**4. The phase splits on what Phase 7 blocks on.** Phase 7 cannot start against a phase that stays open
for the updater, so 4a is everything the UI calls and 4b is everything it does not.

#### Phase 4a — what Phase 7 blocks on

1. **Measure the surface.** `scripts/measure-platform-surface.mjs`, before any code, with every name
   classified and zero uncovered. Phase 3's lesson applied up front: a number nobody can re-derive is a
   claim, not a measurement.
2. **Plugins and capabilities.** **All Phase 4a plugins are wired with window-scoped permissions:**
   `window-state` (persistence, with initial restore inside `renderer-ready`), `os`, `process`, `dialog`,
   `log` and `opener`. The Linux-container application exercises dialog directly, sends a renderer log
   record at startup, and its final lifetime spec exits through the process plugin after a real native
   close request.
3. **`src/lib/platform/**` — the wrapper module.** The 42 frontend/plugin channels, exported under the
   names `main-process-proxy.ts` used, so Phase 7 imports them unchanged. Tested against a mocked
   `@tauri-apps/api`, the way `*-ipc.ts` wrappers already are.
4. **Window lifecycle.** `main.ts` + `app-window.ts` → `lib.rs` and `platform/window.rs`: creation and
   the `titleBarStyle` decision (`native` / `custom` / `native-without-menu-bar`, read from
   `main-process-config` *before* the window exists, which is why it is a command and not frontend
   state), the `renderer-ready` gate on showing the window, zoom factor — Tauri sets it but does not
   report it, so Rust remembers what it set and emits `zoom-factor-changed` — background colour, window
   title, `set-window-selected-repository`, `launch-timing-stats`, and the **quit flow reversing
   direction**: three Electron channels asking the renderer for permission become one preventable
   `onCloseRequested` the frontend answers in place.
   **Implemented:** close is prevented synchronously, repeated requests coalesce while the frontend
   decides `quit` / `hide` / `cancel`, macOS preserves hide-on-close, and explicit quit/restart use the
   process plugin only after frontend policy. Phase 4b's config supplies the optional non-macOS
   `hideWindowOnQuit` value; no Rust-side quitting flags return.
   **`titleBarStyle` is implemented before native creation:** the configured `main` window is a
   `create: false` template; Rust reads `main-process-config.json`, applies upstream's platform matrix
   (macOS native overlay, Windows custom chrome, Linux preference), then constructs the webview.
   Missing or unknown values use `native`, while malformed JSON remains a startup error as upstream's
   synchronous `JSON.parse` was. `native-without-menu-bar` shares native decorations; the menu bridge
   is in place, while suppressing Phase 7's frontend-rendered Linux menu waits for Phase 4b's typed
   config surface rather than a nonexistent window-builder property.
   **Selected-repository metadata is implemented:** the typed frontend setter sends `string | null`;
   Rust scopes the verbatim value to the originating window label and removes it on `null` or native
   destruction. Upstream uses this field only when routing externally supplied CLI/open actions—not
   for the title or jump list.
   **Explicit new-window creation is implemented:** `open-repository-in-new-window` always creates a
   fresh uniquely labelled webview from the same `main` startup template. Rust queues
   `{ kind: 'open-repository', path, persistSelection: false }` by label and returns it exactly once
   from that window's `renderer-ready` handshake, after restore/show/focus, which removes the
   emit-before-listener race without importing Phase 9's external `cli-action` stream. The path crosses
   verbatim. `findWindowForRepositoryPath`, `normalizeRepositoryPath` and most-specific matching belong
   only to Phase 9's single-instance/external-action routing.
   **Multi-window lifetime is implemented:** a close request destroys only the current window while
   another app window exists; the last window still follows the existing macOS hide/non-macOS quit
   policy. Destruction clears both routing metadata and any unclaimed startup action.
5. **Menus and key bindings.** Per decision 1, and the largest slice in 4a. Five pieces:
   - `src/lib/menu/default-menu.ts` — the structure, labels and roles ported from `build-default-menu.ts`
     **without accelerators**, plus `lib/menu-item.ts`; and `src/models/app-menu.ts`, which is the same
     model minus `menuFromElectronMenu`.
   - `src-tauri/src/platform/keybindings.rs` — the `MenuId → { modifiers, key }` map: 52 source
     declarations audited into 50 logical defaults, `CmdOrCtrl` resolved against the real platform,
     user overrides in a JSON file under the app config directory, `get`/`set`/`reset` commands, an
     `emit` on change, and conflict detection at set time. Its tests are pure map logic and need no
     display, which is where the coverage goes.
   - `src-tauri/src/platform/menu.rs` — the macOS native `Menu` built from the pushed structure plus the
     binding map, `on_menu_event` → `emit('menu-event')`, and the reversed label/enablement pushes that
     survive on macOS only.
   - `show-contextual-menu` as a command building and popping a `Menu`. **33 upstream files depend on it**,
     so it is not optional and it is not macOS-only. **Implemented for ordinary, checkbox, separator and
     nested items:** per-popup native IDs map back to the renderer's nested index path, and a main-thread
     marker distinguishes dismissal from Tauri's asynchronously forwarded selection event.
   - The **Linux/Windows accelerator dispatcher** in the frontend, matching `keydown` against the map, plus
     `friendlyAcceleratorText` for display. This is the new code in the slice; spike it before estimating.

   **The ownership bridge is implemented:** `ApplicationMenuController` holds the current immutable
   `AppMenu`, executes an item or ID only after re-resolving it against current enabled/visible state,
   and preserves open-menu IDs when replacing the tree. On macOS it installs the native action listener
   before pushing the tree and rebuilds native state after tree or keybinding changes. On Linux/Windows
   it installs the capture-phase dispatcher against live controller state. Phase 7 replaces the startup
   tree with its state-derived tree and action dispatcher; its enablement policy is not duplicated here.

   Port `app/test/unit/main-process/menu-test.ts` here. `spell-checker-menu-test.ts`, the WebKitGTK
   suggestions investigation and Electron's synthetic `editMenu` placeholder move to Phase 7: both are
   webview text-input behavior, and muda's Linux edit roles currently use X11 key injection with an
   explicit Wayland TODO. The contextual-menu command rejects those two deferred requests instead of
   displaying controls that do nothing on the primary target.

   Explicitly **not** in this slice: the preferences UI for rebinding (Phase 7, and the one place rdc adds
   a capability upstream never had), and `lib/menu-update.ts`'s enablement policy (Phase 7, since it is a
   function of app state).

   **Ordering note: slice 7 comes first.** The menu structure needs `models/menu-labels.ts`, whose
   `selectedShell` field is typed `Shell` from `lib/shells` — so editor and shell discovery has to land
   before the menu can be typed, even though the menu is the larger slice.
6. **Paths, files, shell and trash.** `get-path`/`get-app-path` (frontend `@tauri-apps/api/path`),
   `get-exec-path`, `get-app-architecture`, dialogs, `show-item-in-folder`/`open-external`/
   `unsafe-open-directory` through `tauri-plugin-opener`, and `move-to-trash` as a command over the
   `trash` crate — **Tauri has no trash API, and deleting instead would be a data-loss bug**, which is
   also the protection the `listSubmodules` fix in §8 exists to preserve. `lib/helpers/linux.ts` is
   folded into the editor/shell modules that consume its Flatpak behavior; `lib/shell.ts` and
   `lib/app-shell.ts` become the thin TypeScript facade over opener, system and trash adapters.

   **Implemented on Linux/macOS:** all renderer-consumed path names, resource/executable paths,
   architecture plus Rosetta detection, reveal/open with macOS bundle safety, recoverable trash, and
   the open/save dialog adapters. WOW64 translation detection remains with every Windows runtime arm
   in Phase 10; the two application-folder commands are the separate macOS-only Phase 4b extra.
7. **Editors and shells** (`lib/editors/**`, `lib/shells/**` minus win32, `lib/custom-integration.ts`).
   Discovery and launch are testable without a display — that is where the `#[cfg(test)]` coverage goes.
   Unblocks the two Phase 1 models still held by Node `fs`/`child_process`: `editor-override` and
   `menu-labels` (`MIGRATION_PLAN.md` Phase 1 Step 4).

   **Started:** Linux editor discovery is the first bounded increment. Its Rust tests pin upstream's
   editor ordering, first-existing-path selection, and home-scoped Flatpak/JetBrains/Zed candidates;
   `get_available_editors` crosses through a typed `src/lib/platform/editors.ts` wrapper and its
   `FoundEditor` serializer shape is in the generated wire snapshot. macOS discovery then landed over
   the real Spotlight metadata query (`mdfind`), with tests pinning bundle-ID fallback order and parsing
   independently of the host's installed applications. Normal and custom editor launch then landed:
   arguments cross as arrays into a process API rather than a shell; Flatpak launch uses
   `flatpak-spawn --host`, and macOS application bundles use `/usr/bin/open -a`. The custom parser pins
   quoting, empty arguments, inert shell syntax, unmatched-quote errors and `%TARGET_PATH%` expansion.
   Custom validation then landed over the OS executable-access check (including symlinks) and macOS
   `mdls` bundle metadata, with the result in the generated wire snapshot; whole-integration validation
   also requires a parseable argument string containing `%TARGET_PATH%`. Finally, the one pure
   stored-format migration remains in `src/lib/custom-integration.ts`: its type admits the legacy
   argument array that persisted data can really contain, joins it without mutation, and preserves
   upstream's `null` meaning of “no update needed.”

   Shell discovery then started with the same boundary: Rust owns filesystem and Spotlight access,
   while `src/models/shell.ts` owns the IPC domain shape. Linux checks the exact 20 upstream
   executable paths in preference order; macOS checks 10 shells by bundle ID, including Alacritty's
   fallback ID and the Kitty/Alacritty/Tabby/WezTerm/Warp executable paths inside their bundles.
   Normal and custom launch then landed with each Linux/macOS terminal's exact argument/cwd behavior,
   plus frontend selected-shell fallback. The shared enum and a cross-platform assembly test already
   pin all 11 Windows labels and their upstream ordering, but registry discovery, Windows command-line
   parsing and launch remain Phase 10 work.

#### Phase 4b — independent platform integrations

The measured Phase 4 surface is now complete: **58 of 58 wrappers and 15 of 15 subscriptions**.
Two direct Node imports sit outside that proxy inventory and remain evidence-bearing closure
requirements too: `lib/stores/token-store.ts` (`keytar`) and the macOS `fs-admin` CLI installer.
The slices landed in this order:

**Slice 8 complete:** `MainProcessConfig` now crosses IPC with its exact
camelCase shape, partial updates are serialized and preserve the other field, and the last non-macOS
window consults `hideWindowOnQuit`. Filesystem defaults, malformed JSON, failed writes and concurrent
updates are covered. The rdc-owned `install-id` file preserves the upstream 36-character validation,
trim, generation and process cache behavior, including caching an explicit save before a failed write.
Fresh `MainProcessConfig` reads and fresh `InstallIdState` instances prove both files survive the
owner boundary rather than only returning an in-memory write. The missed Phase 2
`getGlobalConfigPath` handoff is complete too: git itself resolves and creates the global file before
the typed wrapper returns its path.
The surface audit is **47 of 58** Phase 4 wrappers and **8 of 15** subscriptions.

8. **Config and install ID — first vertical slice (4 wrappers).**
   - Extend the existing Rust-owned `MainProcessConfig` with `hideWindowOnQuit`, expose typed
     get/partial-update commands, and feed that value into the already-implemented last-window policy.
     Updates are serialized, preserve the other field, and write rdc's
     `main-process-config.json`; no Desktop Plus config is imported.
   - Add `platform/install_id.rs` for get/save/generate. Preserve upstream's 36-character validity
     contract and caching behavior, but use rdc's own config directory and filename.
   - Port tests first for defaults, malformed JSON, partial updates, concurrent updates, failed writes,
     cached IDs, invalid persisted IDs and exact camelCase wire shapes. This slice is filesystem-only,
     deterministic and unlocks real Phase 7 preferences without adding a plugin.

9. **Keychain — resolve the backend before exposing commands (direct Node blocker).**
   - Replace `keytar` with a Rust credential-store abstraction used by account tokens and
     `copilot/byok.ts`; keep the frontend `TokenStore.setItem/getItem/deleteItem` contract.
   - Use the current [`keyring` mock store](https://docs.rs/keyring/latest/keyring/mock/) behind the
     abstraction in unit tests. Production selects
     Apple Keychain on macOS and **persistent Secret Service on Linux explicitly**; do not inherit
     keyring's newer Linux kernel-keyring default, whose lifetime does not match stored credentials.
     Windows Credential Manager remains Phase 10.
   - Run blocking native-store calls off the async runtime, never log secret values, and test missing
     entries, overwrite, delete, backend failure and isolation between service/login pairs. Add one
     Linux Secret Service smoke test under an isolated D-Bus session if the container spike proves
     stable; otherwise record a manual real-session check rather than weakening the unit contract.

   **Implementation complete; platform evidence open:** `TokenStore` now invokes a Rust abstraction
   backed by pinned `keyring` 3.6.3. Its feature graph explicitly contains `apple-native` and
   `sync-secret-service` and omits `linux-native`/Windows. Blocking calls are serialized off the async
   runtime, and the crate mock covers missing entries, overwrite, delete, backend failure, pair
   isolation and secret-free errors. Phase 7 consumers can keep the existing facade unchanged.
   Ubuntu 26.04 now compiles and runs the mock-backed contract against the Secret Service-linked
   build. Native credential-store evidence follows the feature that consumes it: Phase 8b when exposed
   by the MVP, otherwise Phase 9.

10. **Window attention and macOS extras (4 wrappers plus the direct CLI installer).**
    - `dialog-did-open` becomes a focused-window guard plus Tauri critical
      `request_user_attention`; confirm whether macOS still needs an explicit beep and record any
      presentation difference. Unit-test the decision; manually test the native effect.
    - Read `AppleActionOnDoubleClick` natively and preserve the upstream fallback: `Minimize` and
      `None` are special, every missing/unknown value behaves as `Maximize`.
    - Implement application-folder detection and relocation behind macOS-only commands. Pure bundle
      path/decision logic is unit-tested now; moving a real signed `.app` and relaunching it is a
      Phase 9 release-package validation, not something a dev binary can prove.
    - Replace `fs-admin` with one user-initiated macOS installer command: try ordinary
      unlink/mkdir/symlink first, then an escaped `osascript` elevation request. The installed name is
      rdc-owned. Test command construction and filesystem behavior without elevation; validate the
      authorization prompt with the packaged artifact in Phase 9.

    **Implementation complete; packaged presentation evidence open:** the focused-window adapter now
    preserves both halves of upstream macOS behavior—`NSBeep` and a critical AppKit attention
    request—and uses Tauri's native attention request on other desktop hosts. The double-click
    preference reads the real macOS global default and maps every missing/unknown value to
    `Maximize`. Bundle detection recognizes system and per-user Applications folders; relocation uses
    Finder and relaunches the moved bundle. The rdc-owned `/usr/local/bin/rdc` installer bundles a
    launcher, replaces stale links without elevation first, and falls back to a fully quoted
    `osascript` authorization request. Pure path, preference, filesystem and quoting contracts are
    green. A signed `.app` move/relaunch, visible attention/beep, authorization prompt, and launcher
    argument routing remain Phase 9 evidence; the last item depends on Phase 9 single-instance/CLI
    action delivery.

11. **Notifications (3 wrappers, 1 subscription) — spike identity and ownership first.**
    - Spike [`tauri-plugin-notification`](https://v2.tauri.app/plugin/notification/) before adopting
      it: the desktop implementation must return an actionable handle, preserve a caller-owned ID and
      expose real permission state. Upstream uses the ID to pair clicks, callbacks and
      `DesktopAliveEvent`, so a fire-and-forget display API is insufficient.
    - Own one numeric 32-bit ID allocator and one Rust router. A click first targets the live owner
      window, then the focused window, `main`, and finally a deterministic live-window fallback; it
      must be consumed before emission so multiple webviews cannot execute it.
    - Port the callback cache and unmatched-click fallback tests, permission mappings, object-payload
      validation, listener cleanup and multi-window click ownership. Linux/macOS native display and
      click need real-session manual evidence unless an isolated notification daemon makes the
      container test reliable. Full-process relaunch delivery needs packaged lifecycle evidence in
      Phase 9 rather than a unit-test claim.

    **Implementation complete; packaged/native-session evidence open:** the spike rejected
    `tauri-plugin-notification`: its desktop backend discards the native handle and extra payload,
    reports permission as granted, and documents action callbacks as mobile-only. rdc instead pins
    `notify-rust` 4.18.0 and its preview macOS `UNUserNotificationCenter` backend, retaining the native
    response handle in Rust. The command returns an rdc-owned positive 32-bit ID, accepts only an
    object-shaped `userInfo`, and routes a response exactly once to the owner/focused/main/deterministic
    fallback window. The frontend preserves upstream's bounded 200-callback behavior and forwards an
    unmatched click to the fallback handler. macOS reads and requests real notification authorization;
    Linux and Windows retain upstream's effectively granted permission contract. This also adds Linux
    notifications. A bundled macOS app is required to prove display, permission prompt and click;
    an isolated Linux notification-daemon click and any click after a complete process relaunch remain
    open target evidence: Linux MVP behavior is checked in Phase 8b, packaged macOS release identity
    in Phase 9, and Windows in Phase 10. The measured surface is now **50 of 58** Phase 4 wrappers and **9 of 15**
    subscriptions; all remaining entries belong to the updater slice.

12. **Updater mechanism, not release infrastructure (8 wrappers, 6 subscriptions).**
    - Replace Squirrel's five push events with a frontend `UpdateController` over
      [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/): `check()` drives
      checking/available/not-available/error state, retains
      the returned `Update`, and download progress drives downloaded/installing state. Existing
      subscription-shaped consumers adapt to that one owner rather than recreating Rust events.
    - Keep update/download state in the frontend lifetime decision so closing during installation
      produces the existing “installing update” behavior without a `show-installing-update` Rust emit.
      `quitAndInstallUpdate` operates only on the retained update and relaunches through the process
      plugin after installation.
    - Tests use an injected fake updater backend to pin every transition, repeated-check exclusion,
      progress, errors, close policy and cleanup. Phase 4b installs the plugin and compiles the real
      adapter, but **does not claim a working release channel**: Tauri manifests, the public key,
      endpoint, signed artifacts and the mock-update-server E2E belong to Phase 9.

    **Implementation complete; signed release evidence deferred:** `UpdateController` now owns the
    retained Tauri `Update` resource and the complete checking/available/downloading/not-available/
    ready/installing/error lifecycle. Concurrent checks coalesce, ready updates cannot be replaced,
    failed downloads and disposal close native resources, install failures return to ready for retry,
    and successful installation relaunches through the process plugin. The former five updater pushes
    and installing-update notification are in-process subscriptions over that one owner. Destructive
    close cancels while download/install is active and notifies the existing popup seam; macOS or
    preference-driven hide remains safe and allowed. The official Rust/JavaScript plugin and default
    capability are installed. The legacy URL parameter is intentionally not applied dynamically:
    Phase 9 supplies Tauri's signed endpoint/public key and decides whether its release service needs
    an analogue of Squirrel's install-GUID rollout query. Ten focused controller tests and the close
    policy tests cover the fake-backend lifecycle; live signed-update and mock-server evidence remains
    Phase 9 work.

13. **Phase 4b closed; target evidence transferred, not waived.** Every 4b row in
    `MIGRATION_MAP.md` is routed, the reverse audit names the non-proxy keychain, CLI and updater
    owners, and `measure-platform-surface.mjs --require-complete` reports **58/58 Phase 4 wrappers and
    15/15 subscriptions**. `url-action` remains visibly owned by Phase 9 rather than hidden as pending
    work. Config/install-ID fresh-owner reload tests and the missed `getGlobalConfigPath` handoff close
    the deterministic gaps. The Phase 8b gate covers native behavior used by the MVP; post-MVP Secret
    Service, notification-daemon and packaged-macOS identity/presentation evidence follows its Phase
    9 consumer. Windows backends and runtime behavior gate Phase 10.

#### What Phase 4 does not own

| Left open | Owner | Why it isn't Phase 4 |
|---|---|---|
| `uncaught-exception`, `send-error-report`, `error`, `crash-ready`, `crash-quit`, and where log files go on a crash | Phase 6a / 6b | Phase 4 wires `tauri-plugin-log`; local recovery is an MVP concern and external reporting is not |
| `update-accounts`, `certificate-error`, `show-certificate-trust-dialog` | Phase 5b / 5c | Account-fed media and enterprise certificate recovery have different consumers |
| `resolve-proxy`, `envForProxy`, `getFallbackUrlForProxyResolve`, `lib/parse-pac-string.ts` | Phase 5c | Decision 2 — the same Electron `session` object as `webRequest`, and the same "redesign, not a port" |
| `cli-action`, `url-action`, updater keys/endpoint and cross-platform packaging policy | Phase 9 | External launch routing, signed releases and deep links share the public-release boundary |
| `install-windows-cli`, `uninstall-windows-cli`, Windows protocol/CLI registration and Windows updater application | Phase 10, consuming Phase 9 infrastructure | Registry, PATH, shims, installer format and signed-runtime behavior require a Windows host |
| Menu **enable-state logic** (`lib/menu-update.ts`, 531 lines) | Phase 7 | It is a function of app state; Phase 4 owns the mechanism it drives, not the policy |
| The keybinding **preferences UI** | Phase 7 | 4a lands the map, the persistence and the commands; rebinding is a new feature with no upstream counterpart |
| Hook enable/failure preferences (`lib/hooks/config.ts`) | Phase 7 | `localStorage` preferences state, already routed there |
| Every native Windows arm and Windows runtime validation | Phase 10 | Decision 3 — grouped into a testable target-specific phase; portable UI policy still lands with its owning UI phase |

#### Exit criteria

Written against the Phase 3 closure lesson: **a command counted is not a command that works.** The
surface criteria are necessary and demonstrably insufficient — all four of Phase 3's were green while
`create_merge_commit` was dropping index entries — so the behavioural criteria are listed first.

**4a closes when:**

- Every Rust platform module has `#[cfg(test)]` tests for the logic that is testable without a display:
  editor and shell discovery, custom-integration argument parsing, the menu tree and its IDs, the
  `titleBarStyle` decision, trash and path resolution.
- `app/test/unit/main-process/menu-test.ts` is ported and green, or a named
  blocker is recorded per `AGENTS.md` rule 4.
- **The container E2E harness gets its first real specs.** Phase 4a is the first phase whose output
  cannot be tested any other way — a window, a menu, a theme and a dialog need a webview. This is also
  the first genuine exercise of the Phase 0 harness, and the Phase 3.5 caveat still applies: X11/Xvfb
  validates the plumbing, not native-Wayland rendering. **Done for the first Phase 4 slice:** the
  debug application launches under WebDriver, a nested native contextual-menu selection returns its
  index path and invokes its React callback, Escape returns menu dismissal, and a real native directory
  dialog opens and dismisses through the plugin. A fifth spec opens a second repository window,
  observes the exact one-shot action (including an unnormalized path and `persistSelection: false`),
  and closes only that child. A sixth requests `Window.close()` on the last window, crosses the
  preventable frontend decision and observes the process plugin terminate the real application. The
  macOS application menu is manually validated because the repository's supported driver path is
  Linux-only.
- `measure-platform-surface.mjs --require-phase4a-complete` reports **39 of 39 wrappers and 8 of 8
  subscriptions implemented**, with zero uncovered entries in either direction. The 19 wrappers and
  7 subscriptions left pending are explicitly assigned to 4b; `url-action` is assigned to Phase 9,
  and `--require-complete` remains the whole-Phase-4 closure gate.
- Every 4a row in `MIGRATION_MAP.md` §7.1 has its status flipped, and every deviation from decisions 1–3
  is written into §8 **with its consequence** — the menu inversion, the accelerator dispatcher, and
  anything WebKitGTK turns out not to expose.

- **The keybinding map is pinned on both sides.** It crosses IPC, so it is a wire shape: a snapshot entry
  and a TypeScript fixture checked against `src/models/**`, per `AGENTS.md` rule 3. A test asserts all 52
  source declarations match upstream item for item and that they collapse to exactly 50 logical defaults
  — that is what makes the extraction a reorganisation rather than a rewrite, and the only thing standing
  between "same bindings" and a claim.

**4b closure evaluation — complete:** the same measurement covers all 19 wrappers and 7 subscriptions;
the reverse audit covers the direct keychain and macOS CLI integrations; fresh-owner reads prove config
and install-ID persistence; `getGlobalConfigPath` closes the last Phase 2 handoff; and the updater
controller's complete lifecycle passes against its fake backend.

The original criterion put every native credential-store and notification-click check directly on
4b. Implementation showed that this mixed three different target gates into one phase: Linux requires
a real D-Bus desktop session, macOS notification delivery requires a packaged identity, and Windows
requires backends not yet compiled into rdc. The checks remain mandatory but now follow their consumer:
Phase 8b qualifies native behavior exposed by the macOS/Linux MVP; post-MVP Linux Secret Service,
notification-daemon, packaged-macOS Keychain and notification-identity checks close with Phase 9;
Windows Credential Manager and notification identity/click close in Phase 10. A live update
check/install is Phase 9 evidence because it requires a signed artifact, public key and endpoint.
Phase 4 closes without claiming any of that evidence early.

Three things are **not** 4b criteria: proxy support, which moved to Phase 5 by decision 2;
config-directory migration, which is dropped by principle 6; and deep-link delivery, which moved to
Phase 9 because Tauri requires the single-instance plugin on Linux/Windows and the packaged scheme must
match rdc's registered OAuth callback; this coupling is explicit in
[Tauri's desktop deep-link documentation](https://v2.tauri.app/plugin/deep-linking/).

#### Spikes resolved in Phase 4b, and target evidence they handed forward

Each of these needs an experiment rather than a decision from the plan, and each is a place where
guessing would be cheaper than checking and worse:

- The credential abstraction and persistent backend choice are resolved. Native proof follows the
  first product consumer: Phase 8b if the MVP exposes it, otherwise Phase 9.
- The notification spike found no desktop `onAction` to scope: Tauri's plugin actions are
  mobile-only and its desktop backend is fire-and-forget. The chosen direct `notify-rust` handle feeds
  one Rust global router, whose owner/focused/main fallback and consume-once behavior are unit-tested.
  Native notification evidence is Phase 8b when exposed by the MVP, otherwise Phase 9; Windows is
  Phase 10.
- Before the macOS-extra slice closes, compare Tauri's critical attention request with Electron's
  beep-plus-dock-bounce behavior and test application relocation with a signed `.app` in Phase 9.

### Phase 5 — session-level behaviors, split by product dependency

Electron's `session` APIs have no single Tauri counterpart, but that implementation fact must not make
all four behaviors one product gate.

#### Phase 5a — MVP security baseline — **COMPLETE**

- **Production CSP is explicit and closed.** `default-src 'self'`; scripts remain self-only and gain
  only Tauri's build-time hashes/nonces; `base-uri`, `frame-src` and `object-src` are `none`.
  `rdc-blob:` is present in both `img-src` and `connect-src`, preserving Phase 3's image-diff
  capability. Dynamic React style properties require the one deliberate relaxation,
  `style-src 'unsafe-inline'`; no script eval or remote HTTP(S) source is allowed.
- **Development has a separate policy.** `devCsp` adds only the exact Vite
  `http://localhost:1420` document/module endpoint and `ws://localhost:1420` HMR transport. It does
  not add wildcard HTTP, HTTPS or eval. A real `pnpm tauri dev` WKWebView launch is green.
- **Top-level navigation is a separate boundary.** `security.rs` permits the packaged
  `tauri://localhost` / `http://tauri.localhost` origins, exact Vite development origin and
  `about:blank`; external HTTP(S), file, data, JavaScript and blob-capability documents cannot replace
  the application. External destinations continue through the opener plugin.
- **The native capability is least-privilege for the current frontend.** `core:default` is removed;
  rdc grants the exact app/event/path/resource/window/webview commands it imports and narrows dialog,
  OS and updater defaults to the operations actually used. `freezePrototype` protects the shared
  JavaScript prototype before application code runs.
- Rust config/navigation tests pin the source lists and denied origins. The Linux packaged-app E2E
  proves the production policy is enforced by verifying that an injected inline script cannot run,
  freezes `Object.prototype`, and still completes the existing native/IPC journey.

The MVP performs no authenticated webview HTTP requests, so closing `connect-src` also removes the
redirect/header-leak condition `same-origin-filter.ts` defended. Phase 5b must keep authenticated
fetches in Rust rather than widening this policy to arbitrary HTTPS; Alive websocket origin rewriting
and any future GitHub API transport travel with that post-MVP consumer.

#### Phase 5b — authenticated media (post-MVP, with GitHub collaboration)

- Replace authenticated-image request-header injection with a Rust fetch using the account
  credentials and return an opaque, scoped `rdc-blob`-style capability URL. Do not return a data URL:
  a 4 MB image becomes roughly 5.5 MB of JSON and remains resident in JavaScript.
- Retire `update-accounts` with that consumer rather than creating account state before the GitHub UI.

#### Phase 5c — enterprise networking (post-MVP by default)

- Own `resolve-proxy`, `envForProxy`, `getFallbackUrlForProxyResolve` and
  `lib/parse-pac-string.ts`. Chromium previously resolved OS proxy configuration and PAC scripts;
  there is no equivalent cross-platform crate.
- Investigate `certificate-error` and `show-certificate-trust-dialog`. wry exposes no general
  certificate-error hook, so verify what WebKitGTK and WKWebView actually permit before promising
  parity.
- Until this lands, remote operations have no PAC/custom proxy or application-managed certificate
  trust workflow. The MVP must report that limitation clearly. Promote 5c into the MVP only if
  managed/corporate networks become an initial-user requirement.

Phase 5c remains the highest architectural-risk work in the plan, but it no longer blocks the core UI.

### Phase 6 — resilience first, reporting second

#### Phase 6a — MVP resilience — **COMPLETE**

- **Renderer recovery stays in the trusted application window.** `FatalErrorBoundary` replaces a
  failed React tree with a small local recovery screen containing the error message, Reload and Show
  Logs. `componentDidCatch` records both the JavaScript stack and React component stack. There is no
  second privileged crash document and therefore no `error`, `crash-ready` or `crash-quit` channel.
- **Failures outside React remain diagnosable.** Window `error` and `unhandledrejection` listeners
  append durable records without suppressing the webview's own diagnostics. This replaces the
  renderer-to-main `uncaught-exception` channel; external submission remains absent until Phase 6b
  has consent and privacy policy.
- **Native panic output reaches the same log.** A once-installed Rust panic hook writes the payload
  and source location through the application logger, then invokes the previous hook so stderr and
  the platform's normal panic behavior remain intact.
- **Logs are bounded and reachable.** The native logger rotates at every launch, retains the same
  fourteen-session ceiling as upstream, and caps each file at 10 MiB. Help → Show Logs is enabled in
  the startup menu and opens the guarded application-log directory; the fatal screen exposes the
  same action even when the normal React tree is gone.
- Focused React tests force a render failure and exercise both recovery actions; listener, menu and
  guarded-path tests pin the remaining frontend behavior, and Rust tests pin panic formatting and
  retention.

#### Phase 6b — reporting pipeline (post-MVP)

- Add one consent-aware Sentry-or-equivalent pipeline across Rust and React.
- Decide crash retention, privacy copy and report submission before enabling external telemetry.
- The five old crash-window IPC channels disappear rather than being reproduced.

### Phase 7 — UI migration as vertical macOS/Linux MVP slices

The old Phase 7 grouped roughly 109,938 lines of `ui/**` and 21,995 lines of stores behind one
completion boundary. It is replaced by product slices. Each slice ports its upstream tests first,
adds its own Linux-container E2E journey and is manually exercised on macOS.

The dispatcher/store shape remains the compatibility seam. Port `app-store.ts` incrementally behind
that facade as each slice needs behavior; do not copy its 12,310 lines in one batch and do not redesign
the state architecture merely to make the phases smaller. Consumer-bound portable `lib/**` files land
with the slice that first imports them.

#### Phase 7a — application shell and repository ownership — **MVP IMPLEMENTATION COMPLETE — macOS acceptance pending**

- Replace the current React integration harness with the first real application shell.
- Port the minimum dispatcher, repository store, selected-repository state and persistence.
- Add, open, remove, remember and reopen existing repositories.
- Connect current repository state to the Phase 4 menu tree and startup/open-in-new-window actions.
- E2E: add a repository, restart the app and reopen the same selection.

**Repository-ownership slice complete:** the first incremental `AppStore` and `RepositoriesStore`
persist local repositories in an rdc-owned IndexedDB, deduplicate by canonical top-level working
directory, restore the last selected ID with upstream's first-repository fallback, and publish every
selection to Phase 4's native per-window metadata. The integration harness has been replaced by a
product-facing repository sidebar and selected-repository workspace. The shell lists, adds, selects
and removes existing working repositories, exposes discoverable new-window and contextual actions,
and routes native startup/open-in-new-window actions through the same store. Ported store and React
tests cover add/get/dedup/remove/fresh-store restore, selection policy and every exposed shell action.
The Linux WebDriver journey opens and dismisses the real native chooser, seeds a canonical repository
as an explicit deterministic IndexedDB precondition, observes it in the real shell, closes the native
process under test, releases the WebDriver session, launches a new application process and observes the same
selection restored.

**Repository-menu slice complete:** the Phase 4 tree now follows the incremental `AppStore` on every
selection change. Add Local Repository is backed by the native directory dialog, Repository List is
enabled only when the store is non-empty, and Remove Repository / Show in File Manager plus the
Repository submenu are enabled only while a repository is selected. Commands from later product
slices remain honestly disabled. The same tree drives macOS native menu replacement and
Linux/Windows structured keybindings; the Linux journey opens the add-repository dialog through
Ctrl+O rather than bypassing the menu through an in-window button.

**Remaining Phase 7a acceptance:** manually exercise the harness-free shell on macOS. Dynamic child
windows and native contextual-menu selection are covered at their Rust/TypeScript seams, but the
Linux `tauri-driver` journey no longer drives them: GTK's modal popup input and discovery of a child
webview became unreliable once the diagnostic harness was removed. X11 focus injection after the
native chooser is likewise not used as proof of close-request behavior; its focused frontend tests
and the manual macOS close gesture own that evidence. Keep these automation gaps explicit until a
product-level driver signal replaces timing and X11 input injection.

#### Phase 7b — working tree, diff and commit — **MVP COMPLETE**

- Port the changes list, text diff, selection, stage/unstage, discard confirmation and commit form.
- Consume Phase 3's commit terminal Channel: subscribe before invoking, retain at most 256 KiB,
  replay to late progress-dialog subscribers and clear it when the operation ends.
- Connect hook failure to its abort/ignore response seam.
- Rich xterm presentation and syntax-highlighted diffs are explicitly Phase 7f parity work; the
  bounded textual surfaces are sufficient for the MVP.
- E2E: edit a file, inspect its diff, stage it and commit it.

**Read-only working-tree slice complete:** `WorkingTreeStore` converts Phase 3's raw status facts
into the upstream `WorkingDirectoryFileChange` model, keeping inclusion/partial-diff selection in
TypeScript, honoring `startsUnselected`, and sorting paths case-insensitively. Repository switches
discard stale status responses. The harness-free shell exposes honest loading, empty, error and
changed-file states without stage controls yet; the Linux journey opens a genuinely dirty repository
and observes its untracked file in the Changes surface before proving process-restart persistence.

**Selected-file diff slice complete:** status refresh preserves the selected file and frontend-owned
inclusion selection when its stable file ID remains, otherwise selecting the first sorted file.
Diff loading uses Phase 3's hydrated `getWorkingDirectoryDiff` boundary and rejects a response if
the repository or selected file changed while Git was running. The shell renders text/large-text
content and honest binary/image/submodule/unrenderable placeholders. The same Linux dirty-repository
journey now asserts the untracked file's real unified diff reaches the product surface.

**Whole-file inclusion slice complete:** each changed-file row now exposes the upstream checkbox
semantics. Toggling it changes only frontend `DiffSelection` state—Git's index is deliberately not
mutated eagerly—and recalculates the aggregate include-all value. A subsequent status refresh
preserves that selection by stable file ID. The Linux journey checks the real file begins included
and can be excluded through the product surface; the commit-form slice will translate included files
into Phase 3's `IFileToStage` contract.

**Minimum commit-form slice complete:** the shell accepts a commit message and sends only included
whole files through Phase 3's `createCommit`. The frontend translation preserves rename/copy source
paths and deletion facts; empty messages, empty inclusion, unresolved conflicts and not-yet-exposed
partial selections fail closed. Success reloads status and clears the form. The Linux journey now
configures repository-local identity, excludes and re-includes its real file, creates the repository's
first commit through the product surface, verifies Git's commit subject and observes a clean tree.

**Commit terminal-history slice complete:** `WorkingTreeStore` subscribes a bounded replay buffer to
Phase 3's command-scoped terminal Channel before invoking `createCommit`. It retains the latest 256 KiB
using upstream's JavaScript character-count semantics, streams snapshots to the shell's textual progress
view, replays the current snapshot to late subscribers and clears it when the operation finishes or the
repository is torn down. Full xterm presentation is deferred to Phase 7f.

**Recoverable whole-file discard slice complete:** each changed file exposes an accessible warning
dialog before destructive work begins. The frontend preserves upstream's split: modified, new, untracked,
copy and rename destinations move through the native OS trash command; deleted paths are restored from
Git; rename sources are restored; and submodules are reset without moving their repository directories
to trash. Index inspection limits resets to paths that actually differ from `HEAD`, then the selected
paths are checked out and status is refreshed. A trash failure is surfaced and leaves the confirmation
open—there is deliberately no silent permanent-delete fallback. The Ubuntu 26.04 journey creates and
discards a real untracked file through this product surface and observes the clean tree.

**Trash-failure recovery slice complete:** only a typed trash failure advances the dialog to a second,
explicit irreversible warning; Git/reset errors remain ordinary failures. Confirming that warning uses
a new repository-scoped Rust command for the one case upstream removed with Node's `fs.rm`: a selected
untracked path. The native boundary accepts a repository root and relative path rather than an arbitrary
absolute deletion target, rejects empty/absolute/parent paths and `.git`, and rejects a symlinked parent
that escapes the canonical repository before recursively deleting. Modified tracked files are overwritten
by the subsequent index checkout exactly as upstream did. The IPC measurement is green at 144 registered
commands: 98 store imports, 46 named consumers elsewhere, zero consumerless commands and 144 typed
wrappers.

**Partial-line selection, commit and discard slice complete:** the exact absolute unified-diff indices
from each hydrated text hunk now become the file's selectable-line set. Additions and deletions are
selectable; context and hunk headers are not. A partial commit sends Phase 3's existing
`IFileToStage.partial` shape with the domain status and sorted selected indices, while a partial discard
sends the exact displayed `ITextDiff` with those indices so Git rejects a stale patch instead of
discarding different content. The confirmation request snapshots that displayed diff and its selected
indices before opening the dialog, so an independent status refresh cannot silently replace or clear
the requested selection while the user decides. The shell exposes a minimal accessible unified-line
surface; large-text diffs remain whole-file-only rather than pretending they can be partially selected.
The Ubuntu 26.04 journey commits one selected line from a real two-line untracked file, verifies the
committed blob, explicitly selects and discards the remaining working-tree line through the confirmation
surface, and observes a clean tree.

**Hook-failure decision slice complete:** commits can explicitly opt into Phase 3's login-shell hook
interception through the temporary minimum commit-form checkbox. Progress, terminal output and an
ID-scoped failure prompt cross command Channels; the prompt resolves exactly once through
`resolve_hook_failure`, with Abort and Ignore choices and conservative abort when the callback or
webview disappears. The Ubuntu 26.04 journey installs a real failing `pre-commit` hook, observes its
name and output, ignores the failure, and verifies the intended partial commit. Persisted hook
preferences, shell selection, richer progress presentation and syntax highlighting remain Phase 7f
parity work rather than MVP blockers.

**Closed 2026-07-30:** the Phase 7b MVP workflow is complete: status, selected-file text diff,
whole-file and partial-line inclusion, commit, bounded terminal history, hook-failure resolution,
recoverable/permanent whole-file discard and partial-line discard all run through the product shell.
The real Linux journey covers the complete dirty-repository path and all repository quality gates
remain the closure standard.

#### Phase 7c — history, branches and minimum conflict recovery — **MVP COMPLETE**

- Port commit history, commit details/diffs, branch listing, create and checkout.
- Show merge/conflict state and allow a user-resolved file to be staged. Rebase editing, reorder,
  squash and other advanced history operations remain parity work.
- E2E: create a branch, commit, switch branches and inspect history.

**Read-only history slice complete:** `HistoryStore` loads upstream's first 100 commits reachable
from `HEAD`, most recent first, through Phase 3's hydrated `getCommits` boundary. It preserves a
still-present selected SHA across refreshes, chooses the newest commit otherwise, represents an
unborn branch as an empty history and rejects stale responses after a repository switch. The
product shell now has Changes/History navigation, the native View menu enables and routes both
actions only with a selected repository, and the Ubuntu journey opens History after its real
partial commit and verifies that commit's SHA, summary and author.

**Selected-commit details/diff slice complete:** selecting a commit now loads its hydrated
`CommittedFileChange` changeset, line totals and first changed file through the existing
`getChangedFiles` boundary, then loads that file's first-parent (including root-commit)
`getCommitDiff`. The store independently rejects stale history, details and file-diff responses;
selecting another changed file cannot be overwritten by the previous file's slower diff. The
history surface shows the full SHA, author identity, body, changed-file list and read-only diff,
with explicit loading/error/empty and non-text fallbacks. The Ubuntu journey verifies the real
partial commit's changed file and added line.

**Branch list/create/local-checkout slice complete:** `BranchStore` loads hydrated local and remote
branches together with `getStatus`'s explicit current-branch fact; it never guesses `HEAD` from ref
order. The shell lists both kinds, creates a trimmed user branch from `HEAD`, checks it out as the
same user action, and checks out an existing local branch with native progress surfaced. A
successful move refreshes working-tree and visible-history state, while failures preserve the
loaded branch list. Repository and operation generations reject stale loads/progress. Remote refs
are visible but disabled: `checkoutRemoteBranch` also requires a local-name collision policy, so it
is post-MVP parity rather than silently treating a remote ref as a local branch. The Ubuntu journey
creates and enters `phase-7c-e2e`, returns to the original branch and verifies the created ref.

**Minimum merge-conflict recovery slice complete:** `ConflictStore` retains `mergeHeadFound` and
the conflicted paths from status, separately from working-tree selection state. A general Changes
refresh discovers merges or external edits. Text conflicts remain unstageable while Git reports
any marker lines; after the user resolves the file in an editor and refreshes to a zero count, the
store sends the exact path, `(us, them)` index entries and marker count through the existing
`stageResolvedConflictFiles` boundary, then re-reads status. Branch creation and checkout are
disabled during a merge. In-app ours/theirs choices for manual/binary conflicts, merge completion
and abort controls remain advanced parity; this MVP surface deliberately does not pretend those
operations are available. The Ubuntu journey creates a real divergent content conflict, proves
staging is initially disabled, writes a marker-free resolution, stages it through rdc and verifies
Git has no unmerged index entry.

**Closed 2026-07-30:** the Phase 7c MVP workflow is complete: bounded read-only history,
selected-commit metadata and first-parent/root diffs, local/remote branch visibility,
create-from-HEAD plus local checkout, and safe external-editor merge-conflict staging all run
through the product shell. Pagination, search, commit graph, remote checkout naming and advanced
history/conflict operations remain Phase 7f parity rather than MVP blockers.

#### Phase 7d — remote synchronization without built-in accounts

- Port clone, fetch, pull and push with transfer progress.
- The MVP uses credentials already available to system Git, an SSH agent or the existing
  credential-helper path. It does not include GitHub sign-in, publish, pull requests, checks or issues.
- Authentication, proxy and certificate failures must produce actionable errors rather than a
  generic operation failure.
- E2E uses a local bare remote so it does not depend on the public network or developer credentials.

**Remote discovery and fetch slice complete:** `RemoteStore` loads remotes alongside explicit
branch/HEAD facts and preserves upstream's selection policy: the current branch's tracked remote,
then `origin`, then the first remote. A user fetch serializes against other synchronization work,
fetches the tracked and distinct default remotes in that order, aggregates Channel progress, and
best-effort fast-forwards eligible inactive tracking branches before refreshing remote and branch
state. Repository and operation generations reject stale loads and progress. The shell exposes the
remote and progress, and the native Repository menu enables Fetch only while the selected repository
has a usable remote and no operation is running. Authentication copy points to the system credential
helper or SSH agent; unclassified transport failures retain Git's message and explicitly explain that
application-managed PAC/proxy and certificate trust remain unsupported. The Ubuntu journey creates a
local bare remote, advances it from an independent clone, fetches through rdc and verifies both the
remote-tracking ref and refreshed remote branch.

**Normal push slice complete:** the same operation lock now pushes the explicit current local branch
to its tracked remote/branch, or sends a null remote branch for an unpublished branch so native Git
establishes upstream tracking. Tags and force-with-lease remain unexposed rather than silently
changing the MVP action. Push progress is followed by a fetch of the same remote, inactive-branch
fast-forward and complete fact refresh; branch switches also refresh synchronization policy so a
previous branch's upstream cannot leak into the next action. `PushNotFastForward` receives specific
“fetch and pull” recovery copy without offering destructive force push. The shell and native menu
enable Push only for a selected repository with a remote, an explicit local branch and no active
operation. The Ubuntu bare-remote journey creates a no-upstream local branch, pushes it through rdc,
verifies the remote tip and confirms Git recorded `origin/<branch>` as its upstream.

**Pull slice complete:** Pull is enabled only when the explicit current local branch has an upstream;
detached, unborn and unpublished branches cannot accidentally rely on ambient Git defaults. The
controller passes the chosen remote plus explicit user-initiated/no-verify policy, scales transfer
progress through the same post-operation fetch, inactive-branch fast-forward and fact refresh used
by Push, and retains the single synchronization lock. Merge conflicts and local-change overwrite
failures receive repository-recovery copy rather than the generic unsupported-transport guidance.
The shell refreshes working-tree and conflict state after both successful and failed pull attempts,
so Git leaving a merge in progress immediately enters Phase 7c's supported conflict surface. The
Ubuntu journey advances the pushed branch from the independent clone, pulls through rdc, verifies
the local `HEAD` equals the remote tip and reads the new file from that commit.

**Generic clone slice complete:** `CloneStore` validates and serializes one native clone, surfaces its
Channel progress and the same actionable authentication/transport errors as other remote operations,
and rejects progress from a reset operation. The shell accepts any system-Git URL or local path plus
an explicit destination. Its native chooser preserves the already-recorded platform split: macOS
selects the exact target with a save dialog, while Linux selects a parent and appends the repository
name inferred from the URL. A successful clone is added through `AppStore`, selected immediately and
persisted through the existing repository database; a failed clone never registers its destination.
The Repository menu and empty/sidebar shell expose Clone even when no repository is selected.
Account-aware repository selection, GitHub sign-in and clone options beyond the generic native
command remain Phase 7f. The Ubuntu local-bare-remote journey verifies the cloned `HEAD`, `origin`
URL, automatic selection and selection restoration after the real application process restarts.

**Closed 2026-07-30:** Phase 7d's macOS/Linux MVP workflow is implemented: clone, fetch, normal push
including first publish, and tracked-branch pull run through the product shell with native progress,
serialized operation state, actionable errors and local-bare-remote E2E coverage. Built-in accounts,
force push, tag push, advanced hook preferences and application-managed PAC/proxy or certificate
trust remain explicitly post-MVP.

#### Phase 7e — MVP hardening and presentation (autonomous implementation)

- Port only the preferences needed by exposed behavior: theme, destructive-operation confirmation
  and editor/shell selection.
- Complete accessibility, keyboard navigation and realistic-large-repository performance passes.
- Use `@tanstack/react-virtual` where the realistic-large-repository measurements show that rendering
  the complete list misses the acceptance target. The current MVP shell never imported upstream's
  `react-virtualized`, and History is deliberately bounded to 100 commits, so this is a measured
  performance decision rather than a mechanical dependency replacement. Do not combine it with an
  unrelated component rewrite.
- Hide, disable or clearly mark commands whose feature has not landed; a preview must not imply that
  every upstream menu action works.
- Replace inherited Desktop Plus/GitHub Desktop Help destinations and About text with rdc branding.

**Start audit 2026-07-30:** the native discovery and launch mechanisms for macOS/Linux editors and
shells already exist, as do application-wide native theme control and system-theme notifications.
Their consumers do not: Preferences, Open in Shell and Open in External Editor remain honestly
disabled. CSS follows only `prefers-color-scheme`, repository removal currently has no confirmation,
and discard confirmation is always on. The full menu is already fail-closed for unimplemented menu
events, but its three enabled Help links still lead to Desktop Plus/GitHub Desktop and About remains
disabled. Repository, changed-file and commit lists currently render with direct `map`; History is
bounded to 100 while the other two are not. Basic semantic buttons, labels, alerts and visible focus
styles are present, but dialogs do not yet trap/restore focus or close on Escape, and selectable lists
have no arrow-key navigation.

The three MVP preferences stay in TypeScript persistence. They affect renderer behavior and labels;
none must exist before Rust creates the menu or webview, unlike `titleBarStyle`. Theme selection calls
the existing native adapter but also drives an explicit document theme so Light/Dark overrides do
not depend on how a webview interprets the OS media query. Editor and shell preferences persist the
stable upstream identifiers, then resolve them against native discovery on each launch; an
uninstalled choice falls back visibly rather than persisting a machine-specific executable path.
Custom integrations remain Phase 7f.

Work is split into five independently closable slices:

1. **Preferences and integrations:** a small persisted preferences store/dialog for
   Light/Dark/System, upstream-default confirmation flags for repository removal, recoverable
   discard and permanent discard, plus installed editor/shell selection. Wire preferred
   Open-in-Editor/Open-in-Shell actions and their dynamic native-menu labels. Partial-line discard
   remains confirmation-protected because it cannot use the operating-system trash.
2. **Honest product surface:** replace or visibly mark the inherited Help links, add an rdc About
   surface, and audit every enabled menu/action against an executor. Keep GitHub/account,
   repository-settings, custom-integration and advanced Git commands disabled for Phase 7f rather
   than adding hollow dialogs.
3. **Accessibility and keyboard acceptance:** centralize modal focus entry, trapping, Escape,
   dismissal and focus restoration; add arrow/Home/End selection behavior to repository, changes and
   history lists; verify accessible names, selected/busy/live state, reduced-motion/high-contrast
   behavior and keyboard-only completion of the MVP workflow.
4. **Visual design and product polish:** establish an intentional rdc visual system for typography,
   spacing, color, controls, panels and dialogs; improve hierarchy across the repository sidebar,
   changes/history workspace, commit form and diff presentation; and make empty, loading, progress
   and error states feel like one product. Verify compact-window behavior and both themes without
   changing the already-tested interaction contracts. Keep this as a CSS/component-structure pass,
   not a new feature or a rewrite of the stores beneath the shell. Pair automated component and
   interaction coverage with named macOS/Linux visual acceptance.
5. **Measured large-repository hardening:** establish representative repository/change/history
   fixtures and record load, selection and scroll evidence in the Linux WebKit container. Split list
   rows out of the monolithic shell and add `@tanstack/react-virtual` only to lists whose measured
   rendering requires it, retaining stable selection and screen-reader semantics. Close with the
   complete automated Linux MVP journey and deterministic fixtures/checklists ready for Phase 8b.

**Preferences and integrations slice complete:** `PreferencesStore` owns a validated, versioned
renderer-persistence record for Light/Dark/System, upstream-safe repository-removal, recoverable
discard and permanent-discard confirmation defaults, and stable editor/shell identifiers. Loading
applies the native application theme, resolves System to an explicit document theme, follows later
native system-theme notifications without resetting the native source, and discovers installed
tools through Phase 4's Rust mechanisms. A stored tool that is no longer installed falls back to the
first supported installed choice and persists its identifier, never its machine-specific path.

The native Preferences menu now opens the focused MVP settings surface on every platform. Preferred
Open in Shell and Open in External Editor actions become enabled only after discovery resolves a
usable tool, and their native labels follow the selection. Repository removal and whole-file discard
honor their preferences; partial-line discard remains confirmation-protected because it is
irrecoverable, while a trash failure separately honors the permanent-discard preference. Custom
integrations remain Phase 7f. Unit/React tests cover persistence, malformed-field fallback, dynamic
menu policy, launch routing and confirmation behavior. The Ubuntu native journey opens Preferences
through the real `Ctrl+,` accelerator and verifies a live Dark/System theme transition.

**Overlay-window movement correction:** the Phase 4 startup decision correctly gave macOS
`TitleBarStyle::Overlay`, but the Phase 7 shell initially supplied no webview drag target, leaving the
window immovable. The shell now reserves a sticky, non-interactive top strip that calls the scoped
and rejection-handled native start-dragging API. macOS always receives it, as does the future
frameless Windows shell; Linux retains native decoration without an extra strip unless startup
`titleBarStyle` is explicitly `custom`. Double-click reads macOS's existing
`AppleActionOnDoubleClick` policy and explicitly minimizes, maximizes/restores or does nothing; the
second press no longer enters Tauri's automatic drag listener or leaks its rejected promise. The
strip contains no buttons, so moving the window cannot swallow Preferences/Clone/Add clicks.
Policy, DOM, window-action and capability tests pin all three platform branches. Manual
`pnpm tauri dev` acceptance on macOS verified sticky dragging after scroll and native Maximize
double-click without rejected promises on 2026-07-30.

**Honest product surface slice complete:** the application menu and About surface now identify rdc,
including the installed version, while Help points only to rdc's repository and issue tracker. The
inherited Desktop Plus issue destination and GitHub Desktop guides/shortcut documentation are
removed rather than presenting another product's support material as rdc behavior. About is a real
globally available renderer action on macOS and Linux/Windows menu structures. A recursive
three-platform contract test executes every visible enabled leaf action through the composed
repository/startup dispatchers, so adding an enabled command without an executor fails the suite;
unimplemented Phase 7f commands remain disabled.

**Accessibility and keyboard slice in progress — shared interaction foundation complete:** every
renderer-owned modal now uses one focus contract: focus enters the first available control, Tab and
Shift+Tab remain trapped, safe cancellation uses Escape, and dismissal restores the invoking
control. Decisions that must be resolved explicitly, plus clone/discard while native work is active,
remain intentionally non-dismissible. Repository, changed-file, commit and commit-file lists share
non-wrapping Arrow Up/Down plus Home/End navigation and roving tab stops while preserving their
store-owned selection.

Changes, History, remote synchronization and Clone now expose busy state, operation progress uses
live status semantics, all interactive form controls receive visible keyboard focus, and explicit
reduced-motion and forced-colors rules keep those cues available under OS accessibility modes. Unit
and React integration tests pin focus trapping/restoration and list routing; the Ubuntu WebKit
journey verifies focus entry, both Tab boundaries and Escape through the real native Preferences
accelerator. A second real-app journey creates a change, selects it, toggles inclusion, submits the
commit with the default hook interception, proves the mandatory hook decision ignores Escape, chooses Ignore
and reaches the new History entry using keyboard input only. The automated/coding acceptance for
this slice is complete. Phase 8b retains the corresponding macOS manual checklist: native-menu focus
entry, both modal Tab boundaries and restoration, repository/change/history list navigation,
keyboard commit plus hook resolution, Reduce Motion and increased-contrast presentation.

**Visual-layout decision:** fix information architecture before styling individual controls. The
application frame uses one fully collapsible navigation sidebar whose independently collapsible
section registry names Repositories, Branches, Tags, Stashes, Submodules and Subtrees. A section is
visible only when its real store and actions exist: the MVP renders Repositories and Branches;
Tags/Stashes/Submodules/Subtrees remain registered but hidden until their Phase 7f consumers land.
Flipping visibility without the backing feature is not allowed, preserving the honest-product rule.
The typed registry and its MVP capability contract are pinned in `src/lib/ui/sidebar-sections.ts`;
it contains no placeholder renderers or no-op actions.

The native window title carries the current repository and branch. A toolbar below it consolidates
frequent global/repository actions and compact remote state instead of presenting branch and remote
cards in the document. Below the Changes/History switch, Changes uses a stable file-list column with
the commit form beneath it and a flexible diff pane; History reuses the topology for commit list and
commit details. Conflicts span the workspace as a banner. Implement in this order: typed sidebar
registry and frame, dynamic native title, live Repositories/Branches panels, toolbar consolidation,
Changes/History grids, compact-window behavior, then visual tokens and detailed polish.

**Application-frame foundation complete:** the typed registry now drives an independently
collapsible Repositories and Branches sidebar, and the entire sidebar collapses to a narrow rail.
Deferred Phase 7f sections are absent from the DOM. Live branch checkout/create controls moved out
of the document into their repository-scoped panel without changing store behavior or keyboard
contracts. The native title follows `rdc — repository — branch`, while a full-width toolbar shell
combines repository identity, the new-window shortcut and compact Fetch/Pull/Push state. React tests
pin panel independence, whole-sidebar collapse, hidden deferred sections, branch ownership, native
title text and toolbar composition. The next layout slice replaces the remaining vertically stacked
Changes/History content with the paired list/detail workspace grids and expands the toolbar's MVP
shortcuts.

**Visual-system and workspace slice complete:** Changes now uses the planned file-list/commit column
beside a flexible diff pane; History mirrors it with a bounded commit list beside commit metadata,
changed files and the selected diff. Both collapse to one column below the compact-window breakpoint
without changing their semantic regions, roving list navigation or store ownership. The toolbar now
contains the backed file-manager, preferred editor, preferred terminal and new-window shortcuts plus
the existing remote controls; unavailable integrations remain disabled rather than opening hollow
surfaces. Diff rows carry semantic add/delete/hunk classes in both working-tree and history views.

One shared token layer now owns light/dark canvas, surfaces, borders, text hierarchy, toolbar,
selection, success/danger, warning/error and diff colors, alongside system UI and platform monospace
font stacks and a compact 13px desktop base. Desktop Plus was used as a validation baseline, not a
palette to copy: rdc retains the useful role separation, system typography, compact density,
high-contrast toolbar and semantic diff treatment while keeping its own colors and information
architecture. Measured foreground/background pairs range from 4.98:1 for the light muted text to
16.27:1 for primary light text; toolbar and dark-theme muted pairs exceed 6.7:1. React contracts pin
the paired workspaces, backed toolbar actions and semantic diff classes. The Ubuntu native journey
pins the typography/token application and proves the 52rem layout becomes a single-column shell and
workspace. Named macOS acceptance still requires looking at Changes and History in Light/Dark/System
at normal and compact widths; programmatic screen capture cannot foreground the unsigned debug
window without Accessibility permission, so that visual judgment is not claimed here.

**Human judgment is consolidated in Phase 8b:** this slice deliberately stops at an automated,
test-backed structural and token baseline; it does not claim that detailed visual design is finished.
The macOS/Linux visual review and refinements formerly attached to Phase 7e now run alongside the
other human-only platform checks in one iterative QA phase. Phase 7e can therefore close when its
remaining measured large-repository work and automated gates are green, without pretending that
human visual acceptance happened.

**Measured large-repository slice complete:** the unbounded repository and changed-file lists now
share a focused `@tanstack/react-virtual` adapter and extracted row components. Lists at or below 100
items retain ordinary complete DOM semantics; larger lists render a measured window with stable item
keys, roving tab stops and explicit scroll-before-focus navigation. History remains deliberately
unvirtualized because `HistoryStore` already caps its MVP batch at 100 commits—adding another moving
part there had no supporting measurement.

The Ubuntu 26.04 WebKit journey creates **1,000 untracked files** plus **250 additional repository
records**, requires each rendered list to stay below 40 DOM rows, and sends `End` from the selected
changed file to reveal and select `large-0999.txt` within five seconds. The measured journey stayed
below 300 ms on both closing container runs; the test retains ten-second load and five-second
navigation ceilings to detect regressions without treating one machine's timing as universal.
Small-list React contracts, the 1,000-row DOM bound, TypeScript and the then-complete 13-journey
native suite were green.

**Phase 7e autonomous implementation complete:** human visual refinement, native macOS acceptance
and real-Wayland judgment remain intentionally unclaimed and share the explicit Phase 8b QA/fix
cycle. The next non-human-blocked milestone is Phase 8a automated qualification and QA preparation.

#### Phase 7f — post-MVP UI and upstream parity

- GitHub accounts/collaboration, stashes, tags, worktrees, LFS, submodules, advanced
  preferences, keybinding preferences and other surfaces not required above. **Merge and squash
  are no longer post-MVP** — the merge dialog (and with it branch rename/delete) shipped during
  Phase 8b, and **non-interactive rebase entered MVP scope** by a deliberate reversal of the
  Phase 7f deferral (see `BRANCH_OPERATIONS_PLAN.md` § "Amended scope"). What remains here for
  the merge/rebase family is **interactive rebase** (reorder/reword/edit/drag-to-squash), advanced
  flows and the update-from-default-branch convenience.
- Add syntax-highlighted diffs through the Vite worker and the full xterm hook/operation progress
  presentation; move the temporary commit-form hook toggle into persisted hook preferences.
- Finish webview-native edit context menus and spell checking with their text-input consumers.
  Transient (non-edit) Linux context menus already ship through direct GTK rather than muda — see
  the `MIGRATION_MAP.md` §8 note; this item is the separate text-input `editMenu` replacement and
  its WebKitGTK spelling suggestions, which remain an explicit investigation, not an MVP blocker.
- CodeMirror 5 may move to 6 later, based on its own tests and profiling.

React 19 supports the upstream class components. For every slice, grep for `ReactDOM.render`, string
refs and legacy function-component `defaultProps`; modernize only what React 19 requires.

### Phase 8 — automated qualification, human-assisted QA and final MVP artifacts

Phase 8 is split by evidence type, not by platform. Phase 8a exhausts work that can proceed without
human judgment and prepares reproducible development builds and fixtures for Phase 8b. Final
packaging waits until the human QA/refinement loop has settled the product, avoiding a stream of
throwaway packages while also removing the former acceptance-before-packaging circular dependency.

#### Phase 8a — automated qualification and QA preparation

- Enter only after Phase 7e's autonomous work is complete and the repository has no known automated
  failures. Every Phase 7a–7d slice once owned a Linux-container `tauri-driver` journey; 8a runs the
  complete set rather than beginning product E2E late. The later native-menu pivot (Phase 8b)
  removed the menu-driven subset — those flows are evidenced outside E2E — but the remaining 13-suite
  set is still the complete automatable product journey.
- Run all five repository quality gates, the complete Ubuntu 26.04 container journey and automated
  development-build checks for clean launch, configuration/log locations, repository persistence
  and relaunch. Exercise isolated Secret Service or notification daemons only for behavior the MVP
  exposes; otherwise keep that evidence with its post-MVP consumer.
- Prepare deterministic seeded repositories, normal/compact viewport and theme matrices, the
  macOS checklist, the real-Wayland Linux checklist, the final-package smoke checklist and a common
  evidence/issue template.
  A human should not spend the QA cycle constructing fixtures or rediscovering expected results.
- Audit the packaging inputs—rdc-owned metadata, resources, capabilities and configuration—without
  producing the final packages. Final icon, bundle identifier and presentation choices remain part
  of the 8b human review.

Phase 8a closes only when all automated gates are green and the development builds, fixtures,
packaging inputs and checklists required by 8b are ready. A known automated failure may not be
deferred to human QA.

**Phase 8a complete (2026-07-30):**

- The five repository gates, the Ubuntu 26.04 `tauri-driver` suite (one spec file per product
  slice; (**28 tests across 13 suites** on the current native-menu build, down from 14 suites when
  the menu-driven journeys were removed — see the 8b reconciliation below) and
  `pnpm qualify:phase8a` are green. The container journey now owns isolated XDG config/data roots,
  asserts the exact persisted startup configuration and identifier-scoped log, and retains the
  complete-process repository-persistence check.
- A local macOS `pnpm tauri build --debug --no-bundle` produced the development binary. The Linux
  journey builds and exercises its real no-bundle binary in the container. No final `.app`, Linux
  bundle or installer was produced.
- `scripts/qualify-phase8a.mjs` audits package/Tauri version and identity consistency, Node 24,
  bundle resources/icons, startup-window ownership, hardened security, scoped capabilities and the
  executable CLI resource. CI runs the audit and its fixture-generator contract. `org.rdc` and the
  current icon remain explicitly provisional human decisions for 8b.
- `scripts/create-phase8b-fixture.mjs` creates fresh, local-only and ambient-config-independent named
  scenarios for clean/read-only, branch, discard, hook, conflict, fetch/pull, push, clone, progress
  and unreachable-network checks. Every mutating journey owns a separate working tree; the topology,
  expected bytes, refs, hook failure and delayed bare-remote hook are pinned by an automated test.
- `qa/phase-8b/` contains the entry/cycle instructions, normal/compact and Light/Dark/System visual
  matrix, macOS and real-Wayland checklists, common evidence record and package-last smoke pass.

Phase 8b is therefore the next MVP phase. Its visual and native-platform judgments remain
deliberately human-assisted, and every resulting fix returns through the complete Phase 8a gate.

**Phase 8a pre-QA follow-up complete (2026-07-31):** the completed result above remains the first
historical qualification point. A later scope decision deliberately reopened 8a, made the Node 24
requirement mechanical, split the order-dependent E2E monolith into 14 independently prepared
suites, added the browser bundle-boundary guard, isolated Windows compilation seams, and adopted
blocking oxfmt/Oxlint checks. The coordinated UI slice then added build-time Tailwind and replaced
the 2,166-line application component with a nine-line entry point, an orchestration hook and focused
sidebar, toolbar, Changes, History, conflict, dialog and window-drag components under
`src/lib/ui/app/`. Component-local layout now uses Tailwind while `App.css` retains the shared
tokens, state selectors, platform behavior and cross-component responsive rules.

The forecast that `App.test.tsx` would have to be rewritten with the monolith was wrong: its 32
tests interact through rendered behavior and mocked platform/store boundaries, so all passed
unchanged after the component extraction. It remains the intentionally broad shell-integration
contract; splitting it merely to mirror production filenames would add duplicate mock setup without
improving isolation. Focused component tests can be added where a component develops behavior that
is not already clearer at that boundary.

The refreshed complete gate is green: 939 Vitest and 1,179 Rust tests, TypeScript, oxfmt, Oxlint,
Clippy, rustfmt, isolated-crate and Windows `git-ops --all-targets` compilation, the 22-test/14-suite
Linux WebKit journey (including its computed visual contract), browser-boundary and packaging-input
audits. Fresh no-bundle development builds succeeded on macOS and in the Linux journey; no final
package was produced. Phase 8a is closed again and Phase 8b is next.

One debug-build warning was investigated rather than hidden: with source maps enabled for a Tauri
debug build, Rolldown reports that `@tailwindcss/vite:generate:build` transformed `src/App.css`
without a complete input map. Production builds do not emit the warning; the generated JavaScript
map was traced successfully through `App.tsx` and `use-app-controller.ts`; and enabling Vite's CSS
development maps only moves the warning to the next CSS transform without producing a usable CSS
map. The practical gap is precise CSS source mapping in developer tools, not application behavior or
packaging. It remains visible as upstream Tailwind/Vite/Rolldown debt in `REMAINING.md`, to be
rechecked on dependency upgrades rather than “fixed” by suppressing the warning or disabling the
working JavaScript maps.

#### Phase 8b — human-assisted QA and refinement

Phase 8b is the one consolidated human-blocked pre-MVP phase. It is an **iterative QA cycle that is
expected to reveal defects and require fixes**, not a one-shot approval ceremony:

1. Run the prepared checks against current macOS and real-Wayland Linux development builds and record
   visual, functional, accessibility and platform-integration issues with reproducible evidence.
2. Implement every agreed MVP-blocking fix and add automated regression coverage wherever the
   behavior can be pinned without human judgment.
3. Rerun the complete Phase 8a gate, refresh the development builds and repeat every affected human
   check. Continue this loop until no agreed MVP-blocking issue remains.

The human checks cover:

- Begin with two blocking foundation levels before reviewing themes or workflows. First settle native
  chrome, general sidebar and repository-entry actions in the clean shell through
  `qa/phase-8b/baseline-layout-checklist.md`. Then select the populated fixture and complete Gate A
  (repository/branch context, toolbar and Changes/History navigation), Gate B (expanded left-pane
  design), Gate C (Changes workspace frame), Gate D (History workspace frame and cross-frame
  stability), then Gate E (continuous top-level resizing across the settled frames) in
  `qa/phase-8b/selected-repository-baseline-checklist.md`. Cycle one accepted the macOS shell/empty-
  state level on 2026-07-31 and all five selected-repository gates by 2026-08-01. Those results open
  the macOS visual/functional pass; they deliberately do not transfer acceptance to Linux or Windows.
- Refine hierarchy, proportions, density, alignment, labels, sidebar disclosure, toolbar grouping,
  empty/loading/error states, diff readability and commit/history details on macOS and real Wayland
  Linux at normal, default and compact sizes in Light, Dark and System themes. Validate against
  Desktop Plus's successful visual principles and native platform conventions without copying its
  layout or values.
- Audit the complete application-menu inventory against the MVP before functional journeys. Across
  empty, selected, dirty, History, remote/busy, protected and multi-window states, every visible and
  enabled item must be backed and correctly scoped, every post-MVP item must remain hidden or honestly
  disabled, and labels, accelerators, Help/About destinations and contextual menus must match rdc.
  `qa/phase-8b/menu-mvp-alignment-checklist.md` is the shared macOS/Linux evidence gate; Windows
  repeats it independently in Phase 10.
- Settle the final MVP icon, bundle identifier and preview presentation before packaging. “Preview
  presentation” is a concrete release-identity decision: whether this MVP is labelled Preview/Beta
  in About and package-facing metadata, what exact label is used and how it relates to version 0.1.0;
  it is not a vague extra visual pass.
- Run the complete repository, commit, branch and local-bare-remote journey in both development
  builds. On macOS also exercise the native menu, dialogs, window drag/double-click, close/relaunch,
  editor/shell launch, persisted state and keyboard/accessibility checklist. WKWebView has no
  `tauri-driver` backend, so the recorded checklist is real evidence rather than nominal automation.
- Run the Linux development build in a real Ubuntu 26.04 Wayland session to qualify rendering,
  native dialogs/integrations and the `WEBKIT_DISABLE_COMPOSITING_MODE=1` mitigation outside the
  Xvfb driver harness.
- **Menu-driven journeys are now native-menu evidence, not E2E.** The Phase 8b pivot to a native
  menu on every platform (see `MIGRATION_MAP.md` §8) means GTK's native menus have no
  `tauri-driver` backend, so six formerly-E2E flows — branch rename/delete, discard-all, merge
  initiation, merge-conflict creation and remote management — are no longer automatable through the
  menu. They are evidenced by unit/React tests, the debug-only QA state driver
  (`scripts/qa/qa-linux-matrix.sh` + `qa_driver.rs`), and this human pass. The container suite drops
  to 13 suites as a result; the underlying git operations and their stores remain product-E2E- and
  unit-covered as before.
- **Package last:** only after the development-build QA loop has no agreed blocker, produce the local
  macOS `.app` and installable Linux bundles. Run automated metadata/resource/package smoke checks,
  then a focused installed-artifact pass for clean launch, configuration/log locations, persistence,
  relaunch and platform integration. A packaging-only defect returns through its fix, the complete
  8a gate, repackaging and the affected installed-artifact checks.

**QA reconciliation 2026-08-01:** the accepted macOS foundation exposed two preparation claims that
were stronger than the tooling. The fixture gap is now closed: schema 2 creates independent clean,
populated, branch, line-discard, whole-file-discard, hook-failure, conflict, fetch/pull, push, clone,
delayed-push and unreachable-remote scenarios. The delayed state lives in a local bare-remote hook,
never product code, and the generator test pins every topology and oracle. The remaining package gap
is still explicit in `REMAINING.md`: `qualify:phase8a` intentionally audits packaging inputs and
reports `finalPackagesProduced: false`, so automated produced-package metadata/resource inspection
must be added after final identity and bundle targets are chosen. Neither gap is allowed to turn into
ad hoc human setup or a nominal package check.

**Linux QA cycle 2026-08-01 (Fedora 44 Wayland, WebKitGTK 2.52.5, git 2.55):**

First human QA pass on real Wayland. The in-app menu bar (File/View/Repository/Help) renders as a
2 rem bar above the webview on Linux and Windows; `min_height` is adjusted by 32 px to keep the
content area from shrinking below its own minimum.  The native menu bar remains on macOS.

Light-theme gate round passed (baseline, Gate A minus one context-menu finding, Gate D, Gate E).
Two theme-agnostic UI defects found and fixed:

- **F1 — branch-create form input/button mismatch:** the new-branch `input` had no explicit
  `height`, letting it default to the submit button's content-box height while the cancel button
  inherited a visible 1px border.  Fixed: input forced to 2.25 rem, both buttons borderless with
  `--color-accent` / `--color-accent-soft` hover, matching the filter row's `+` button.
- **F2 — discard-icon reveal on unfocused rows:** the old `li:focus-within` selector revealed the
  trash icon on any focused child, not just the discard button.  Replaced with
  `li:has(.working-tree-file-discard:focus-visible)` so the icon appears only on row hover or when
  the discard button itself has keyboard focus.

Additional fixes in the same pass:

- Left-panel `input:focus-visible` outline was cropped by `overflow: auto`; replaced with an inset
  box-shadow on `.sidebar-panel-content input:focus-visible`.
- `Preferences` `<select>` forced to theme with `appearance: none` plus an inline SVG chevron
  because WebKitGTK draws native-light selects regardless of CSS color.

Context-menu positioning on Wayland, first attempt: `popup_menu` queries the current cursor
position at the time of the IPC round-trip; on Wayland this is stale.  Fixed by capturing the
click coordinates (`pointerdown` listener + `getBoundingClientRect` of the trigger element) and
passing them through to a new `popup_menu_at` call, with a `47 px` CSD titlebar offset converting
webview-viewport coordinates to GTK-window coordinates.  The trigger's CSS `:hover` tooltip is
dismissed via `blur()` before the native menu opens so it does not linger behind the popup.
**This positioning fix later turned out to freeze the app; superseded below.**

**Linux native-menu migration (`6eef6b6`/`17df5bf`).** The in-window DOM menu bar
(`src/lib/ui/app/menu-bar.tsx`) is replaced by Tauri's native menu on **every** platform, not only
macOS — Linux and Windows now render the same native menu macOS always required, dispatched
through the same `MenuEvent`/`repository-menu.ts` executor either way. This deletes the in-window
bar, its 22-test regression file, and six menu-driven E2E specs
(`branch-lifecycle`/`discard-all`/`merge`/`merge-conflicts`/`remote-manage`.test.mjs): native GTK
menus have no `tauri-driver`/WebDriver backend, so those journeys stop being automatable on Linux
the same way they already weren't on macOS. Automated proof of menu wiring narrows to unit tests
(`repository-menu.test.ts`'s capability-parity assertion) plus a human native-dispatch checklist —
now needed on both platforms, not macOS alone. See `BRANCH_OPERATIONS_PLAN.md` for the concrete
residual checklist item this leaves.

**Linux context-menu freeze, found and fixed (`3c8b1dd` → `26535e4`).** The CSD-offset positioning
fix above (re-landed once directly, once as a literal port of Beaver-Notes' equivalent
`show_edit_context_menu` fix, at the user's explicit request, to settle by hardware test rather
than inference whether a different Tauri entry point behaved differently — it didn't) turned out
to freeze the whole app on real GNOME/Wayland: open a context menu, switch focus to another
window, and rdc stops responding until the OS kills it. Root cause, confirmed by reading
`muda-0.19.3`'s GTK backend directly: `show_context_menu` raises the popup and then blocks in a
hand-rolled `loop { gtk::main_iteration() }` fed only by `connect_cancel`/`connect_selection_done`,
with no `grab-broken` handler and no timeout. Passing an explicit position anchors the popup to
the real toplevel window, so Wayland treats it as a genuine child surface and **withdraws it on
focus loss** without firing either signal — the loop never returns, and the main thread is stuck
in a nested GTK main loop (the app still repaints, so nothing kills it immediately, but no later
popup, menu action or window-close request ever completes). Omitting the position escaped this
only by anchoring to the root window instead — not a real child popup, hence the original
mis-placement bug this was fixing in the first place. Both the original rdc code and Beaver-Notes'
independently-written fix funnel into the exact same muda call regardless of entry point
(`Window::popup_menu_at`/JS `Menu.popup()` both resolve to `Menu::popup_inner`), so this was never
an rdc-specific mistake to begin with — it's a real gap in muda's GTK backend.

**Fix (`26535e4`):** stop calling muda's popup on Linux. `src-tauri/src/platform/context_menu.rs`
builds a `gtk::Menu` directly and pops it up **non-blocking** — nothing waits on a signal, so
compositor withdrawal is just the menu going away. macOS/Windows keep muda's popup (a single
native call each, no polling loop to wedge). This also retired the tuned `47 px` CSD-offset
constant: with `gtk` now a direct Linux dependency, the webview-to-window offset is measured at
popup time from the real webview widget (`default_vbox`'s non-menubar child,
`translate_coordinates` into the `gtk::Window`), exact on any desktop environment or theme rather
than a GNOME-tuned guess.

All seven gates green after each change: 952 Vitest, tsc, oxfmt, oxlint, 884 Rust, clippy, rustfmt.

**Linux visual-matrix automation.** Because input injection and screen capture are impossible from
inside the Fedora-44-on-Bluefin toolbox (device-cgroup blocks `/dev/uinput` to root; GNOME offers no
wlr-screencopy; the Shell screenshot DBus method is denied for container peers), the matrix is driven
by a **debug-only** Rust state driver polled from a script, with the host capturing via PrtScn into
the shared `~/Pictures/Screenshots`. Full mechanics and the environment constraints are recorded in
`MIGRATION_MAP.md` §8 (Debug-only QA state driver); the driver is `scripts/qa/qa-linux-matrix.sh`
and the reviewing instructions are `scripts/qa/qa-linux-visual-matrix-runbook.md`.

**Native window title on Linux — deferred to the tao 0.36 upgrade.** The title fails to update
on Linux/Wayland because `tao` (≤ 0.35) forces a custom `HeaderBar` whose title is fixed at
window creation. The fix is upstream in tao v0.36.0 (tao#1218) but tauri stable still pins
`^0.35`, so it cannot be taken yet. **Decision: wait for the next tauri stable** (a plain
`cargo update` pulls it in; no code change makes it work earlier). Full root cause, reading of the
fix, and the to-do list (confirm the title updates, verify startup maximize/window-state restore
and the frameless Custom style) are recorded in `MIGRATION_MAP.md` §8 — that list no longer
includes re-measuring the context-menu CSD offset, since the Linux context-menu path (see above)
no longer uses a tuned constant at all.

**Component/dialog migration (recorded 2026-08-08).** Phase 8b's component-migration process
(`COMPONENT_MIGRATION_PROCESS.md`) ran its three-way review — rdc / desktop-plus / shadcn — through
ten dialogs: hook failure, About, discard file, discard all, delete branch (+ the "cannot delete"
notice), remove repository, manage remotes, add remote, rename branch and merge. Remaining in the
queue: **preferences**. Rebase, Clone and Merge are migrated and consume the shared blocking progress
dialog. The process promoted
the four conventions that are now the strongest layout rules the migration produced:

- **Convention 12** — all of a dialog's messages share one height-holding slot, so a message that
  appears as the user types cannot move the confirm button out from under their cursor.
- **Convention 13** — a control in two halves shares one enabled state; a lit caret cannot sit
  beside a greyed confirm.
- **Convention 14** — a dialog must fit the viewport in both axes; this was the third geometry bug
  of one family, so the discard E2E asserts lower bounds as well as upper ones.
- **Convention 15** — a list is unambiguous before it is pretty; remotes keep their `origin/`
  prefix.

Two branch dialogs finished here. **Rename branch**
(`src/lib/ui/dialogs/rename-branch-dialog.tsx`) was extracted from `app-dialogs.tsx`, closed the
`MESSAGE_SYSTEM_PLAN` Slice 1 bug where a rejected rename showed no reason, and added the
validation that was missing — a space, a tilde or a taken name used to reach git and fail after
the fact.
`sanitizedRefName` gained its first caller, collisions are caught before git sees them, and a
failure/busy message fills the shared slot while every dismissal is blocked. `DialogActions`
centralises Convention 2's platform ordering for ordinary form dialogs. **Merge**
(`src/lib/ui/dialogs/merge-branch-dialog.tsx` + `strategy-actions.tsx`) replaces the abandoned WIP
— four features were written and commented out, which read to a user as a broken feature, not
unfinished work. It covers merge and squash as two strategies from a split button whose label names
the whole sentence ("Merge into main"), matches on **SHA as well as ref** so one `git branch
--merged` call also accounts for remote branches, allows a conflicting merge as an outcome rather
than a refusal, and blocks while loading. It is reachable either from a real repository
(`Repository → Merge…`) or from `Help → Show Dialog`, whose stub branches now carry canned previews
reaching every state the dialog renders; `inject-test-state.test.ts` asserts that coverage so the
preview cannot quietly stop exercising a state, and the `mergeStates` QA fixture reproduces the
same
outcomes from real ancestry.

The branch picker underneath is now a proper keyboard surface: rows stay individually focusable so
Tab steps through them, arrows move focus by ref paired with
`scrollIntoView({ block: "nearest" })`,
and each row's tooltip carries the full name and an absolute last-modified time — the two facts the
row itself cannot show. A `formatTimestamp` helper moved out of the row so the sidebar and picker
cannot drift into two formats. The recorded lesson: a keyboard test that asserts only the selection
callback proves nothing; both failing arrow-navigation attempts passed such tests, and only
asserting `document.activeElement` caught it.

Squash cost no backend work (`MergeOptions { squash }` and its `git commit --no-edit` follow-up were
already complete; `branch-store` was dropping the option), and the default strategy is now a
persisted preference (`defaultMergeStrategy`) — the same per-team-convention preference a Phase 7f
item was blocked on.

**Scope decision recorded 2026-08-07 — rebase enters the MVP.** This deliberately reverses the
Phase 7f deferral of `update-from-default-branch` ("reverse this only deliberately"), but narrower:
it adds rebase as a branch operation, not the update convenience. Rebase gets its own dialog because
it inverts the direction — the picked branch is the *base*, not the *source*. Interactive rebase
stays out, and rebase-conflict recovery is not optional because `conflict-store` tracks only
`mergeInProgress`: a `.git/rebase-merge/` conflict would otherwise strand the user with no in-app
way out. Full boundaries are in `BRANCH_OPERATIONS_PLAN.md` § "Amended scope".

**Code organization, scheduled after the dialog migration** (`CODE_ORGANIZATION_PLAN.md`,
recorded 2026-08-07): dialogs previously sat in four places by accident of chronology, and `src/lib/`
is a 110-file flat drawer mixing pure helpers, IPC wrappers, domain logic and desktop-plus's GitHub
service code beside properly grouped subdirectories — the repository demonstrates two conventions
and follows neither. Measured: **95 of 237 non-test modules are unreachable from `src/main.tsx`**, of
which the 30 directly under `src/lib/` are genuinely unreferenced (`refs.ts`, `create-branch.ts`,
`rebase.ts` have no non-test importer); the `src/models/` share is largely a type-only false
positive. The document holds the inventory and the questions and deliberately decides nothing yet;
it runs after the dialog migration so it moves settled code, and `ARCHITECTURE.md` depends on it.

Record before/after evidence, accepted non-blocking deviations and the final results for both
platforms. Phase 8b closes only after the last fix has passed 8a again, its affected human checks
have been repeated, and the final packages pass their focused acceptance pass. Signing,
notarization and public release credentials remain post-MVP Phase 9 work.

### Phase 9 — public release engineering (post-MVP)

- Produce signed/notarized Tauri bundles and update metadata; configure the updater public key and
  endpoint and decide whether the release service needs an install-ID rollout equivalent.
- Port the updater mock-server lifecycle E2E, including download progress, close prevention, install
  and relaunch.
- Land single-instance startup/second-instance routing, `cli-action`, registered deep links and the
  final rdc OAuth callback scheme. Keep most-specific repository matching platform-neutral so Phase 10
  adds Windows case-insensitivity without duplicating routing policy.
- Qualify packaged macOS Keychain and notification behavior, attention presentation,
  Applications-folder relocation and the authorization-backed `/usr/local/bin/rdc` installer when
  their consumers are release features.
- Port `app/src/cli/**` last or independently as a thin standalone Node/Rust binary.

#### macOS/Linux MVP exit criteria

The milestone closes only when both target platforms expose the same supported workflow:

1. A clean artifact launches, adds an existing repository, persists it and reopens the selection.
2. The user can inspect status and text diffs; stage, unstage and discard — individual files, a
   selected range, or the whole tree; and create a commit.
3. The user can inspect history; create, check out, rename and delete a branch; initiate a merge or
   squash-merge; and recover from the minimum supported merge-conflict state without being stranded
   (including aborting a merge in progress). Non-interactive rebase is in MVP scope per the
   cross-branch-operation scope decision of 2026-08-07 (`BRANCH_OPERATIONS_PLAN.md`).
4. Clone, fetch, pull and push work with a local bare remote and with credentials already available to
   system Git/SSH. Unsupported account, PAC/proxy or certificate-trust cases fail with actionable copy.
5. Menus, dialogs, close/relaunch, editor/shell launch and MVP preferences operate on both platforms;
   unimplemented parity actions are not presented as working.
6. Phase 5a's CSP/capability audit and Phase 6a's recovery path are complete.
7. All repository quality gates pass, the Linux E2E journey (13 suites) is green in the container,
   Phase 8a's automated-qualification gate is green, and Phase 8b's iterative QA cycle and final
   packaging pass are closed with recorded packaged-macOS and real-Wayland Linux results. The
   menu-driven flows that native GTK menus make unautomatable (branch rename/delete, discard-all,
   merge initiation, remote management) are evidenced by unit/React tests, the debug-only QA state
   driver and the Phase 8b human pass rather than product E2E.

Signing, notarization, automatic updates, GitHub accounts/collaboration, enterprise proxy/certificate
management, telemetry, the standalone CLI, complete upstream UI parity and Windows are explicitly not
part of this milestone.

### Phase 10 — Windows platform support

Windows is a named phase rather than an indefinite deferral. It owns the 2,487 Windows-only lines
removed from Phase 4's critical path: `shells/win32.ts`, `editors/win32.ts`,
`lib/process/win32.ts`, registry access (`registry-js` → `winreg`), toast activation/WOW64 handling,
and the Windows arms of custom integrations and hooks. The Phase 4 reevaluation adds the adjacent
target seams that the line count did not: Credential Manager, notification identity/clicks,
trampoline/askpass packaging, native-plugin runtime qualification, Windows CLI/protocol registration,
and signed installer/updater behavior. Phase 9 still owns the cross-platform release,
single-instance/deep-link and signing design; Phase 10 makes those designs work on Windows.

Shell support begins from the contract already pinned in Phase 4: Command Prompt, PowerShell,
PowerShell Core, Hyper, Git Bash, Cygwin, Warp, WSL, Alacritty, Windows Terminal and Fluent Terminal,
in upstream order.

The work is grouped so a feature cannot disappear behind “Windows later”:

1. **Windows build and CI baseline.** Add an actual Windows runner for frontend tests, the Rust
   workspace, clippy/fmt where supported, and a packaged smoke launch on WebView2. Pin the supported
   Windows and Git-for-Windows versions, verify `git.exe`/`ssh.exe` discovery (or make an explicit
   bundling decision), and test paths with spaces, non-ASCII characters, UNC prefixes and long-path
   forms. Cross-compiling elsewhere is not evidence.
2. **Git credentials, trampoline and hooks.** Implement cryptographic token generation through
   `BCryptGenRandom`; build/package the `.exe` askpass, credential-helper and hook-proxy sidecars;
   validate loopback transport, cancellation and cleanup; preserve the copy fallback where symlinks
   require privilege; and port Git Bash discovery plus MSYS2, PowerShell and `cmd.exe` quoting.
   Exercise Git for Windows and Windows OpenSSH, including `/c/...` key-path conversion and the
   existing `useWindowsOpenSSH` preference seam. `GlobalConfig::path` must also be proven with
   `HOME`/`USERPROFILE`/`GIT_CONFIG_GLOBAL` on Git for Windows.
3. **Editors, shells and process/registry access.** Port `editors/win32.ts`,
   `shells/win32.ts` and the surviving `process/win32.ts` responsibilities over native registry and
   process APIs. Tests cover registry fixtures, PATH/environment fallbacks, installed-WSL detection,
   Windows command-line parsing, `cmd.exe / START` quoting, custom-integration placeholder expansion,
   working directories, exit/error capture and discovery/launch smoke tests.
4. **Credential storage and notifications.** Enable keyring's Windows Credential Manager backend and
   prove missing/overwrite/delete/persistence without exposing secrets. Qualify `notify-rust` under a
   packaged AppUserModelID: display, click, consume-once routing, relaunch fallback and permission
   semantics. Decide from evidence whether Tauri packaging supplies the toast activator identity or
   whether an explicit CLSID/shortcut registration replaces `find-toast-activator-clsid.ts`.
5. **Window, menu and native-plugin behavior.** Run the already-shared custom title bar,
   Linux/Windows menu dispatcher, contextual menus, keybindings, zoom/state restore, focus/close,
   dialogs, opener/reveal, recoverable Recycle Bin trash, log path and process relaunch on WebView2.
   Repeat both Phase 8b foundation checklists: the shell/empty-state baseline at 800×600 in expanded
   and collapsed states, then the selected-repository context/toolbar/navigation and workspace-frame
   gates at normal, default and compact widths. macOS/Linux results are design references, not
   Windows acceptance evidence.
   Add WOW64/ARM64 translation detection and preserve the unsafe-directory trailing-backslash guard
   that prevents `C:\\path\\foo.exe` being opened when the caller intended `C:\\path\\foo`.
6. **Packaging, CLI, protocols and updater.** Against Phase 9's shared controller, choose and sign the
   supported Tauri Windows bundle target(s); implement rdc-owned `.bat` and POSIX/WSL CLI shims in a
   stable per-user location; update the user PATH without losing value type/order; uninstall only
   rdc-owned entries; register deep-link protocols with the required launcher argument; and verify
   first/second-instance routing, case-insensitive repository matching, install/update/uninstall,
   signed update application, close prevention and relaunch.

Phase 10 closes only when those six groups are green on a Windows host and every Windows-specific row
in `MIGRATION_MAP.md` points to an implementation or an explicit, evidenced deviation. Portable
Windows UI presentation—labels, focus workarounds and preference controls—still lands with Phase 7;
Phase 10 supplies and qualifies the native behavior it calls.

## Sequencing recommendation

Phases 0–4, 5a and 6a are closed. The shortest path to the agreed macOS/Linux MVP is:

```text
7a repository shell
             ↓
7b changes and commit
             ↓
7c history and branches
             ↓
7d remote synchronization
             ↓
7e autonomous hardening
             ↓
8a automated qualification + QA preparation
             ↓
8b human-assisted QA and fix cycles
             ↓
final packaging + focused artifact acceptance
             ↓
macOS/Linux MVP
```

The Linux E2E for each slice lands with that slice; Phase 8a runs the complete automated set and
prepares the development builds before Phase 8b spends human attention on them. Packaging happens
only after that QA loop settles, followed by a focused artifact pass. Phase 5b
joins the post-MVP GitHub-collaboration work. Phase 5c can be prototyped independently because it is
still the highest architectural risk, but proxy/PAC and application-managed certificate trust do not
block the MVP unless the initial-user profile changes. Phases 6b and 9 follow the MVP. Phase 7f is the
remaining UI/parity backlog. Phase 10 owns the complete Windows target and consumes shared public-release
infrastructure from Phase 9 where appropriate.

Phase 8b is running the component/dialog migration in parallel with its QA/fix cycle (ten
dialogs done, three left: rebase, clone, preferences — `COMPONENT_MIGRATION_PROCESS.md`); the
code-organization pass (`CODE_ORGANIZATION_PLAN.md`) is scheduled immediately after so it moves
settled code rather than code in flight.

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
| WebKitGTK native-Wayland rendering (new, not in the old app) | Unresolved upstream crash/render bugs on the only session type the primary target now has | Force `WEBKIT_DISABLE_COMPOSITING_MODE=1` on Linux (see Phase 3.5); no automated CI coverage yet, qualify it explicitly in the Phase 8b real-Wayland QA cycle |
| **`lib/api.ts` imports a React UI component** (found in Phase 1) | A lib module importing `ui/secret-scanning/bypass-push-protection-dialog` for one type; transitively pulled the whole UI tree into the API client and its tests | **Fixed**: type moved to `models/secret-scanning.ts` |
| **`lib/http.ts` reaches Electron for a build constant** (found in Phase 1) | `ui/lib/app-proxy` → `ui/main-process-proxy` → `lib/ipc-renderer` → `electron`, all to read `__APP_VERSION__` | **Fixed**: uses the `__APP_VERSION__` define directly |
| **`ui/lib/round.ts` misfiled** (found in Phase 1) | Dependency-free pure math helper under `ui/`, imported by `lib/format-number.ts` | **Fixed**: moved to `lib/round.ts` |
| **Legacy `url.parse()` — security-relevant** (found in Phase 1) | 8 call sites across `api.ts`, `find-account.ts`, `parse-app-url.ts`, `repository-matching.ts`. Node emits DEP0169: behavior "is not standardized and prone to errors that have security implications. CVEs are not issued for `url.parse()` vulnerabilities." Also won't bundle for a webview without a Node polyfill. | Migrate to the WHATWG `URL` API. **Not** done during the port: `url.parse()` is lenient where `new URL()` is strict, so this is a behavior change that needs its own change with the ported tests as the guard. Tracked in `MIGRATION_MAP.md`. |
| `models/repository.ts` imports the whole `lib/git` barrel (hub #2) | A domain model depending on the entire git layer; blocks ~15 tests from porting | Break the barrel dependency — models should be leaf types |
| `models/popup.ts` imports UI dialog components (hub #2) | Popups typed by their dialog props, inverting the model→UI direction | Decouple popup payload types from component props |
