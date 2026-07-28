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

### Phase 2 — Git backend (`git-ops` crate) — **IN PROGRESS (~half)**

**Current state, measured.** `lib/git` is 60 files / 9,485 lines. `git-ops` is 29 modules /
10,934 lines with 324 Rust tests, `fmt`/`clippy -D warnings`/`test` green.

| | |
|---|---|
| `lib/git` files with a Rust counterpart | **24 of 60** (5 of them explicitly partial) |
| `lib/diff-parser.ts` | ported to Rust, TypeScript version deleted |
| `lib/git/log.ts` | ported to Rust |
| `lib/git/show.ts`, `lib/git/diff-index.ts` | ported to Rust |
| `lib/git/diff.ts` | text diff path ported; image/LFS deferred |
| `lib/trampoline/**`, `lib/git/credential.ts` | handlers ported; accounts/UI behind traits |
| `lib/git/{push,fetch,pull}.ts`, `lib/progress/**` | ported to Rust; hooks deferred |
| `lib/git/{clone,remote}.ts` | ported to Rust |
| Original `app/test/unit/git/**` files migrated | **16 of 45** |

**Ported:** `exec`+`error`+`git_error_kind` (`core.ts`, less the frontend error copy), `status`,
`status_parser`, `rebase` (non-interactive), `checkout`, `branch`, `commit`, `config`, `rev_parse`,
`update_index`, `interpret_trailers`, `terminal_output`, `git_delimiter_parser`, `operation_state`,
`merge`, `stage`, `rev_list` (partial), `reset` (`unstageAll`), `update_ref` (`deleteRef`), `add`,
`diff_check`, `refs`, `init`, `rm`, `diff` (**`getBinaryPaths` only — 1 of 12 functions**).

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
- `getPartialBlobContents` is **deferred**: its only consumer is
  `ui/diff/syntax-highlighting/index.ts` (Phase 7). It was built on Node's `maxBuffer`, which
  *errors* past the limit so the caller recovers partial output from the rejection. Reproducing that
  needs a capped-read primitive in `exec` that stops reading and kills the child, and killing
  mid-read has to avoid deadlocking against an undrained stderr pipe. A bounded-memory-but-unbounded-I/O
  stand-in would quietly lose the property the function exists for. When it lands, note
  `git cat-file -s <rev>:<path>` answers "how big is this blob?" without reading it.
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
`getFilesDiffText`, `getResolutionDiff` and LFS need temp-file plumbing or their own modules.

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

**`clone` and `remote` finished the network group** apart from LFS. 35 commands.

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

**The percentage flatters it.** Everything above is the *write* path. The *read* path a user
actually looks at is the gap: `diff.ts` is the largest file in the git layer at 1,032 lines with
1 of 12 functions ported, and `log.ts` (376) has none. Phase 7 cannot show a change or a history
without them, so they are the critical path, not `push`/`pull`.

**What remains, by what blocks it:**

- **Blocked on the trampoline handlers** (transport done; handlers need account state): `push`,
  `pull`, `fetch`, `clone`, `remote`, `credential`, `environment`, `lfs` — ~900 lines.
- **Unblocked, purely local:** `diff` (1,032), `cherry-pick` (499), `stash` (390), `log` (376),
  `submodule` (212), `squash` (173), `worktree` (166), `gitignore` (157), `reorder` (153),
  `tag` (134), `reflog` (127), `apply` (120), `diff-index` (116), `revert`, `show`, `var`,
  `merge-tree`, `checkout-index`.
- **Deferred inside ported modules**, each with a named prerequisite: partial per-line staging
  (needs `patch-formatter`), hook + terminal output for commit/merge/rebase (Channels — the
  streaming runner now exists, so this is cheaper than it was), checkout submodule updates,
  interactive rebase (needs `reorder`/`squash`).

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
  `addSafeDirectory`, and `getConfigValueWithOrigin` + its four display formatters, which emit
  strings like `"global, via [includeIf]"` and so belong in the frontend.

`getDefaultBranch` is now unblocked by `GlobalConfig`, but its `"main"` fallback is app policy —
wire it up above `git-ops`, not inside it.

**Also landed (fifth slice, 118 Rust tests): `branch` and its helpers.**
- `branch.rs` — create/rename/delete/list, `get_branches_pointed_at`, `get_merged_branches`.
  `deleteRemoteBranch` is **deferred**: it pushes a deletion, so it needs `envForRemoteOperation`
  (trampoline credentials + proxy), both outstanding.
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

<details><summary>original phase description</summary>
- Port `app/test/unit/git/**` (45 files, largest single test category) as the acceptance spec for `crates/git-ops`.
- **Keep shelling out to the system `git` binary** (Rust `tokio::process::Command`), do **not** switch to `git2`/libgit2. This mirrors dugite's own deliberate choice — libgit2 has known gaps with LFS, credential helpers, partial clone, and hook execution that real desktop Git clients depend on. Reimplementing dugite's spawn/parse logic in Rust is more work than a libgit2 rewrite would save, and avoids a category of subtle correctness bugs.
- Each `dugite`-based file in `app/src/lib/git/` maps to one Rust module in `crates/git-ops/src/`; port the parsing/formatting logic test-by-test.
- `trampoline/` (10 files) + `ssh/` (4 files) → `crates/trampoline`, compiled as a small Rust sidecar binary bundled via Tauri's sidecar mechanism, replacing the vendored `desktop-trampoline` native binary. This is a real improvement: one Rust toolchain instead of a separately-maintained vendored binary per platform.

</details>

### Phase 3 — IPC surface → Tauri commands — **first vertical slice DONE**

The first command is wired end to end: `get_status` runs git in Rust and renders in React.

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

- **Partial (per-line) staging** needs `lib/patch-formatter.ts` ported — the original built a patch
  from the UI's `DiffSelection` and piped it to `git apply --cached`. Whole-file staging works.
- **Checkout progress** is now a `Channel`, not a callback (see the streaming note above).
  **Submodule updates** still need `lib/git/submodule.ts`.
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

One scope boundary remains explicit: interactive rebase waits for `reorder`/`squash` and the
generated todo-list flow. It is not needed for the ordinary branch-on-branch rebase now exposed.

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

Until submodule updates land, checkout emits an explicit `value: 1` after git succeeds. The original
reserved the final 10% for submodules; preserving that weighting before the submodule step exists
would leave every checkout apparently stuck at 90%.

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

**Current command count: 15. Next in this phase:** the remaining `ipc-shared.ts` channel inventory,
merge/rebase hook and terminal output, and the trampoline handlers (the transport is done; the
handlers need account state).

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
