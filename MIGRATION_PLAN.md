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
`pull/` and `rebase/`); see the exit criteria below. Phase 3 work can continue, starting with the
§7 IPC channel-table pass in `MIGRATION_MAP.md`, while the remaining exported-behavior deferrals
listed there are implemented by their named owners.
Nine of the 15 tests re-scoped in Step 4 were subsequently recovered through the
`Repository.url` redesign, trailer/regex extraction, and app-state decomposition. The remaining
five are assigned to Phases 3, 5, and 7 in `MIGRATION_MAP.md` §6.

### Phase 2 — Git backend (`git-ops` crate) — **COMPLETE — EXPORT-AUDITED**

**Minimum git.** rdc runs the **system** git, where upstream bundled its own — so an option newer than a
supported distro's git is a real failure, not a hypothetical one. Two are shimmed rather than assumed
(`cherry-pick --empty`, `hook run --to-stdin`), and CI holds the line with a job on git 2.39. Ubuntu 22.04
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
| Hook output, terminal capture and the failure prompt for commit/merge/rebase/push/pull | Phase 3 | The backend is complete; what's missing is commands passing a `HookInterception` and putting its callbacks on Channels. The enable setting behind it is Phase 7 state. |
| Image diffs, and commands for `get_blob_contents`/`get_partial_blob_contents` | Phase 3 | Both wait on one decision — how raw bytes cross IPC — which is the IPC surface's to make, not the git layer's. |
| `envForProxy`, `getGlobalConfigPath` | Phase 4 | Electron's `session.resolveProxy` and the `git config --edit` editor trick are platform integrations. **No remote operation has proxy support today**; that is a known gap, not an oversight. |
| `getFilesDiffText`, the remaining rev-list queries, `getConfigValueWithOrigin` and its formatters, accounts/keychain, SSH env | Phase 7 | Each lands with its consumer, and the config formatters emit UI strings. |

What Phase 2 does **not** own, and never did: deciding *whether* to intercept hooks, how bytes reach the
webview, or where a proxy comes from. Those are the three places this phase stops.

The implementation gates and the 60-file counterpart count are green. Every deferred export in
the checklist now has an explicit Phase 3, 4, or 7 owner, so formal closure does not depend on
implementing those later-phase features.

| | |
|---|---|
| `lib/git` files covered by a Rust concern | **60 of 60**. There are 59 filename-level counterparts; `environment.ts` is intentionally split between `authentication.rs` and Phase 4 proxy integration — see below |
| `lib/diff-parser.ts` | ported to Rust, TypeScript version deleted |
| `lib/git/log.ts` | ported to Rust |
| `lib/git/show.ts`, `lib/git/diff-index.ts` | ported to Rust |
| `lib/git/diff.ts` | text and conflict-resolution diff paths ported; image path deferred |
| `lib/trampoline/**`, `lib/git/credential.ts` | handlers ported; accounts/UI behind traits |
| `lib/git/{push,fetch,pull}.ts`, `lib/progress/**` | ported to Rust; hooks deferred |
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
  is **Rust-internal with no command**. Sending raw bytes over IPC needs a representation decision —
  base64, a byte array, a custom protocol response — and the consumers that would force that choice
  are the deferred image paths. Deciding it now would be guessing.
- `getPartialBlobContents` **has since landed** — see the `git_capped` slice note below. It has no
  command either, for the same reason as `get_blob_contents`: its consumer is
  `ui/diff/syntax-highlighting/index.ts` (Phase 7), and raw bytes over IPC still needs the
  representation decision.
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

**Deferred, with the reason:** image diffs need the blob-bytes-over-IPC decision from `show`, so a
binary image currently reports `Binary` and an SVG reports plain text — the original wrapped the SVG's
text diff inside an image diff, so the text half is intact and only the second view mode is missing.
`getFilesDiffText` remains with its store consumer. `getResolutionDiff` now has its own backend-local
temp-file path. The shared LFS command and progress layer is also ported; image previews remain
blocked on the raw-bytes-over-IPC decision.

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

What is left is outside this crate. Whether to intercept at all is frontend state, and the four commands
that name hook deferrals have to pass a `HookInterception` and put its progress and failure callbacks on
Tauri Channels — Phase 3 work with a Phase 7 decision behind it.

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
one additional Rust test pins the RAII ownership behavior. Per-command capture and Tauri Channel
adaptation remain Phase 3 work.

**What remains, by what blocks it:**

- **Filename-level whole-file counterparts:** **59 of 60; export coverage is 60 of 60 by concern.**
  `environment.ts` is the split exception: `envForAuthentication` is `authentication.rs`, but
  `envForProxy` resolves a proxy through Electron's
  `session.resolveProxy`, which has no Tauri counterpart — it needs reading the OS proxy configuration
  natively, so it belongs with Phase 4's platform integrations. **No remote operation has proxy
  support today**, not just the deferred ones; that gap is wider than the branch-deletion note below
  implied and is recorded here rather than inside one module.
- **Not a `lib/git` file, but adjacent:** `app/src/lib/hooks/**` (7 files, 863 lines). Discovery, shell
  selection, login-shell environment loading **and the proxy transport** have landed; `config.ts` is
  `localStorage`, so it belongs to Phase 7. Discovery, the shell environment, the transport, the runner
  and `withHooksEnv` have **all** landed — see the slice notes below. What remains is not in this crate:
  the four commands have to *ask* for interception and put its callbacks on Channels, which is Phase 3.
- **Deferred inside ported modules:** hook output and per-command terminal capture/Channel wiring for
  commit/merge/rebase/push/pull, image diffs, `getFilesDiffText`, and the remaining config/proxy
  helpers. Each has a named later consumer or platform prerequisite.

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
- Deferred from `config.ts` (all recorded in `MIGRATION_MAP.md`): `getGlobalConfigPath`,
  and `getConfigValueWithOrigin` + its four display formatters, which emit strings like
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

**Remaining 5:** `ipc-contract` and `format-commit-message` (Phase 3, IPC), `popup-manager`
(Phase 5/7), `stats-store` and `app-store-test-harness` (Phase 7).

**Next:** the rest of `lib/git/**` —
commit/checkout/merge/rebase/stash/push/pull/fetch/log/remote/tag. The remote ones
(push/pull/fetch/clone, and `deleteRemoteBranch`) can now use the trampoline for credentials, though
they need the handlers to be wired up in Phase 3 before they work end to end.

**Note for Phase 3:** the status types carry no `serde`/`specta` derives yet. They will need them
to cross IPC, but the representation is an IPC decision, so it belongs with the binding-generation
work rather than being guessed at now.

**Next:** step 2, then step 3.

<details><summary>original phase description (count corrected after recursive audit)</summary>
- Port `app/test/unit/git/**` (51 files recursively, largest single test category) as the acceptance spec for `crates/git-ops`.
- **Keep shelling out to the system `git` binary** (Rust `tokio::process::Command`), do **not** switch to `git2`/libgit2. This mirrors dugite's own deliberate choice — libgit2 has known gaps with LFS, credential helpers, partial clone, and hook execution that real desktop Git clients depend on. Reimplementing dugite's spawn/parse logic in Rust is more work than a libgit2 rewrite would save, and avoids a category of subtle correctness bugs.
- Each `dugite`-based file in `app/src/lib/git/` maps to one Rust module in `crates/git-ops/src/`; port the parsing/formatting logic test-by-test.
- `trampoline/` (10 files) + `ssh/` (4 files) → `crates/trampoline`, compiled as a small Rust sidecar binary bundled via Tauri's sidecar mechanism, replacing the vendored `desktop-trampoline` native binary. This is a real improvement: one Rust toolchain instead of a separately-maintained vendored binary per platform.

</details>

### Phase 3 — IPC surface → Tauri commands — **IN PROGRESS — 106 COMMANDS**

The phase started with `get_status` wired end to end from Rust to React. The same command pattern now
covers 67 registered commands.

#### What this phase is, measured

**The 77 channels in `ipc-shared.ts` are almost entirely not git.** They are menus, window state, crash
reporting, the auto-updater, notifications, dialogs, theme, URL and CLI actions, accounts and
`resolve-proxy` — which route to Phases 4, 6, 7 and 9, not here. Git never crossed IPC in Electron at all:
the renderer called dugite in-process. That is why every git row in `MIGRATION_MAP.md` §7 reads "no direct
equivalent — new", and why the channel inventory is a *routing* exercise rather than a work list.

The work list is the **store layer's call surface**, which is knowable now: upstream's `lib/stores/**`
imports **104 distinct functions** from `lib/git`. Every one has a proven consumer, which is the bar a new
command has to meet.

| | Count | What it needs |
|---|---|---|
| A command already exists | 58 | — |
| Ported in `git-ops`, no command | 33 | command + typed wrapper + snapshot case |
| **Not ported at all** | 8 | port first, then expose |
| Owned by a later phase | 4 | `envForRemoteOperation`, `getGlobalConfigPath` (Phase 4); `getConfigValueWithOrigin`, `getFilesDiffText` (Phase 7) |

Two caveats on the 33: a couple are existing commands under a different name (`merge` → `merge_branch`,
`rebase` → `rebase_branch`), and one or two are **pure string helpers** — `formatAsLocalRef`, and
`revRange`/`revSymmetricDifference` alongside them — which belong in `src/lib/**` as TypeScript rather than
as a round trip to Rust. A command that computes a string from a string is a command that shouldn't exist.

The 8 genuine gaps are **function-level holes that the file-level count hid**, all inside modules the map
already marks "partially done" — the same lesson as the `for-each-ref` recount, one level down:

- `rev-list.ts` — `getAheadBehind`, `getBranchAheadBehind` (2 of its 8 functions are ported)
- `reset.ts` — `reset`, `resetPaths` (1 of 3)
- `stage.ts` — `stageResolvedConflictFiles` (1 of 2)
- `diff.ts` — `getBranchMergeBaseDiff`, `getBranchMergeBaseChangedFiles`, `getCommitRangeChangedFiles`

Nothing was mis-recorded, but the plan had never named them. Count functions, not files.

#### Decisions settled before starting

**Raw bytes cross IPC as a custom URI protocol, not in a command response.** An `rdc-blob://` scheme
handler in Rust serves blob contents, so `<img src>` and CSS reach them directly and the bytes never enter
JSON. base64 in a response was the alternative and is rejected for the consumer that forced the question:
a 4 MB PNG becomes ~5.5 MB of JSON string, copied twice, living in JS memory for as long as the diff is
open. **The handler needs scoping** — a page must not be able to read an arbitrary path off disk by
constructing a URL — so it validates against the repositories the app has open, in the spirit of the
trampoline's per-operation token. That scoping is the design work in the slice; serving bytes is not.

**Order: Phase 2's handovers first, then the command surface.** The hook and byte-representation work is
what other phases are blocked on, and the hooks half is freshest now.

#### Slices, in order

1. ~~**Hook interception, wired.**~~ **Done** — see the slice note below. Note the plan overstated the
   scope: upstream intercepts in **four** modules, not five. `rebase.ts` passes no `interceptHooks` at all,
   which a grep confirmed before any code was written.
2. ~~**`rdc-blob://` plus image diffs.**~~ **Done** — see the slice note below. The protocol handler and its scoping, then `getBlobImage`/
   `getWorkingDirectoryImage` and the `DiffType::Image` arm, then commands for the two blob readers.
   Closes `diff.rs`'s image deferral and `show.rs`'s lack of commands. Checked before starting:

   - **`DiffType.Image` already exists** in the ported enum at discriminant **1**, so the Rust arm slots
     into the existing numeric contract without touching it.
   - **The `Image` domain model changes** from `{ rawContents, contents, mediaType, bytes }` to
     `{ url, mediaType, bytes }`. Its only consumer is one component — `ImageContainer.loadImage` — which
     builds a `data:` URI for everything except DirectDraw Surface textures, where it converts
     `rawContents` in JS. A URL makes the first case simpler than it is today and the second a `fetch`
     away, with no base64 inflation and nothing large in JSON. It is a **ported type changing while its
     consumer is unported**, which is the cheapest moment for it: Phase 7 writes against the new shape
     from the start.
   - **`getMediaType` is not ported** and belongs in Rust now, because the protocol handler is what sets
     `Content-Type`. Note upstream answers `image/jpg` for `.jpg`, which is not a registered media type
     (`image/jpeg` is) — verify against a real webview before copying it.
   - **CSP is currently `null`.** When Phase 5 adds one it must allow `rdc-blob:` in `img-src` and
     `connect-src`; recorded there rather than guessed at here.
   - **URL construction goes through a helper**, since Tauri serves custom schemes through different URL
     forms per platform. Verified in the Linux container before anything is built on top of it.
3. **Command batches, by domain**, porting the 8 gaps as their domain comes up: branch operations →
   reset/stage → rev-list ahead/behind → the three diff functions → config → worktrees → gitignore → LFS
   → mergeability and repository state → trailers. Each batch is a full vertical slice: command, typed
   wrapper, both halves of the wire contract, tests.
4. **The routing table** (`MIGRATION_MAP.md` §7): one row per upstream channel, its direction, and the
   phase that owns it. Documentation only, and cheap — its value is that no channel gets ported twice or
   forgotten.

#### Exit criteria

- Every function `lib/stores/**` imports from `lib/git` either **has a command** or **names the phase that
  owns it** — the same rule Phase 2 closed on.
- **No command without a consumer.** The store list is the evidence; a command that exists because it
  might be useful is speculative surface with a wire contract to maintain.
- Every shape that crosses is in the snapshot, with a TypeScript fixture annotated against `src/models/**`.
- The 77 channels are each routed, so Phase 4/6/7/9 inherit a list rather than a search.

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
  high-throughput data. So the original's `processCallback`/`onTerminalOutputAvailable` — git progress
  and terminal output during push/pull/fetch — maps to a `Channel`, not `app.emit`. Worth knowing
  before those commands are written.

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
- **Hook output** (`interceptHooks`, `onHookProgress`) is also a Channel. Hooks still *run* — git runs
  them regardless; what's missing is showing their output.

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

**Current command count: 67. Next in this phase:** complete the literal `ipc-shared.ts` channel
inventory, then use it to drive the remaining hook/terminal Channels, raw-byte blob commands,
configuration/reset surfaces, and trampoline handlers that need account state.

Note the sequencing argument here competes with Phase 2's: the channel inventory produces a *queue*,
whereas `diff` removes the thing that makes the app unusable. `diff` first, then the inventory.

<details><summary>original phase description</summary>
- `app/src/lib/ipc-shared.ts` declares 77 channels — treat this as the literal spec. Build a table (in `MIGRATION_MAP.md`) of channel → Tauri command/event, and knock them out systematically rather than ad hoc as UI needs them.
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
state, operation state, `checkout-index` and trailers. **106 commands**, and the Rust side needed no new logic —
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
- Keep the Phase 0 decision: use `tauri-driver` through the Linux-only Compose harness. Choose the
  WebDriver client library when the real specs land; that does not reopen the driver/backend decision.
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
