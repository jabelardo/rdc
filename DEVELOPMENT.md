# Development

`rdc` is a Tauri 2.0 + React 19 rewrite of [`desktop-plus`](../desktop-plus), migrated
according to [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) (phases and decisions) and
[`MIGRATION_MAP.md`](./MIGRATION_MAP.md) (old path → new path, per module). Read those first
for *why* things are structured this way; this document is just *how* to work in the repo
day to day.

## Prerequisites

- **Node 24** — pinned, not a suggestion. Run `nvm use` (the repo has a `.nvmrc`), and
  `package.json` declares `engines.node: ">=24 <25"`. **Do not use Node 26**: it ships an
  experimental built-in `localStorage` global that is `undefined` unless `--localstorage-file`
  is passed, and it shadows jsdom's implementation — silently breaking every web-storage
  test with a confusing `Cannot read properties of undefined`. Keep `@types/node` on the v24
  line too, or the types will declare globals the runtime doesn't have.
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable), with the `rustfmt` and `clippy`
  components: `rustup component add rustfmt clippy`
- [Tauri's platform-specific system dependencies](https://v2.tauri.app/start/prerequisites/)
  — on Linux this means `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`, `patchelf`, `libxdo-dev`, `libssl-dev`, `build-essential`, etc. (see
  `.github/workflows/ci.yml` for the exact apt package list on Ubuntu 26.04)
- **Docker Desktop (or an equivalent Linux container runtime)** — required to run E2E tests
  at all, including on macOS. This isn't optional tooling; see [E2E tests](#e2e-tests) below.

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the app in dev mode (Vite + Tauri) |
| `pnpm build` | Typecheck and build the frontend |
| `pnpm test` | Run the Vitest suite (frontend unit/component tests) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:e2e` | Run the E2E suite — always inside the Linux container, see below |
| `pnpm qualify:phase8a` | Audit MVP build/package inputs and exercise the deterministic Phase 8b fixture generator |
| `pnpm fixture:phase8b -- <new-directory>` | Create fresh local/remote Git repositories for the human QA cycle |
| `pnpm tauri <cmd>` | Passthrough to the Tauri CLI |

Rust-side, from `src-tauri/`:

| Command | What it does |
|---|---|
| `cargo test` | Run Rust unit/integration tests |
| `cargo clippy --all-targets -- -D warnings` | Lint (same gate CI enforces) |
| `cargo fmt --check` | Formatting check (same gate CI enforces) |

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR. Run them locally
before pushing — there's no reason to let CI be the first place a formatting or lint issue
shows up.

## E2E tests

E2E uses [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/), which only supports
Linux and Windows — there's no macOS WebDriver backend for Tauri's WKWebView. Since the
project's primary target is Linux for both development and end-user usage anyway, **E2E runs
exclusively inside a Linux container, on every host, including Linux dev machines** — there is
no supported way to run the underlying tools directly on bare metal. This keeps CI and every
developer's local run on the identical environment.

```sh
pnpm test:e2e
# equivalent to:
docker compose -f docker-compose.e2e.yml run --rm --build e2e
```

This builds `Dockerfile.e2e` (Ubuntu 26.04 + Rust + `tauri-driver` + WebKitWebDriver + a
headless Xvfb display), builds the real debug Tauri binary, and runs the Node WebDriver specs
under `e2e/*.test.mjs`. The suite covers application and native-window lifecycle, native menus and
dialogs, configuration/log locations, persistence across a process restart, repository workflows,
keyboard navigation and large-list behavior. `--build` is intentional; without it, Compose silently
reuses an image containing an older source tree.

The harness sets isolated `XDG_CONFIG_HOME` and `XDG_DATA_HOME` roots. Its native journey writes
`main-process-config.json`, observes the startup log under the identifier-scoped log directory,
persists repository selection across a complete process restart, and proves the production binary
never falls back to the container user's ambient configuration or data directories.

**Known limitation**: this harness runs entirely over X11 (Xvfb). It does not exercise
native-Wayland WebKitGTK rendering, which is the only rendering path real users hit by
default (GNOME and KDE have both dropped native X11 sessions in 2026). See
`MIGRATION_PLAN.md` Phase 3.5 for why there's no automated coverage for that yet, and what
compensates for it (manual testing on a real Wayland session before releases).

## Linux Wayland note

`src-tauri/src/lib.rs` unconditionally forces `WEBKIT_DISABLE_COMPOSITING_MODE=1` on Linux
before the webview starts, to avoid known unresolved native-Wayland WebKitGTK rendering bugs
(startup crashes, resize/repaint artifacts). This trades some GPU-accelerated rendering
performance for stability. Don't remove it without first checking whether upstream
WebKitGTK/Tauri has actually fixed the underlying issue (`MIGRATION_PLAN.md` Phase 3.5 has the
tracking context).

## Dependency policy

**Utility functions: native JavaScript first, then Radash, and Lodash only as a last resort.**

1. **Native** is the default — zero bundle cost, maintained by browser vendors/the spec.
   Common replacements: `_.uniq` → `[...new Set(arr)]`, `_.cloneDeep` → `structuredClone`,
   `_.groupBy` → `Object.groupBy`, shallow `_.merge` → `{ ...a, ...b }`.
2. **[Radash](https://radash-docs.vercel.app/)** when native genuinely has no equivalent —
   async utilities (`parallel`, `retry`, `mapLimit`, `tryit`) and better TypeScript inference
   for `pick`/`omit`. Actively maintained, zero dependencies.
3. **Lodash** only if 1 and 2 don't cover it. `debounce`, `memoize` and `isEqual` have no
   native equivalent, so they're the realistic cases. If you must add it, pin **>= 4.18.1**
   for security. Lodash v4 dates from 2016 with v5 perpetually unreleased, so the real risk is
   response time if a vulnerability lands.

`desktop-plus` has 13 lodash importers, so this will come up repeatedly while porting — check
each call site against the list above rather than reflexively adding the dependency. Phase 1's
only lodash usage was a single `uniq()` on a `string[]`, replaced with a native `Set`.

## Git test fixtures (do not edit)

`src-tauri/crates/git-ops/tests/fixtures/` holds **byte-exact snapshots of git repositories**
vendored from `desktop-plus`, stored with `_git` instead of `.git` and materialized into a temp
directory at test time.

They are git internals stored as plain files, so they must be excluded from any project-wide
search/replace. This already bit once: renaming the default branch `master` → `main` rewrote a
fixture's `_git/HEAD` while its actual ref stayed `refs/heads/master`, leaving HEAD dangling
(`fatal: ambiguous argument 'HEAD'`). A fixture's internal branch name is part of the snapshot,
not a project convention — ported tests refer to `master` inside them.

`.gitattributes` marks the directory `-text -diff` so git never applies line-ending
normalization, and `.gitignore`'s `logs` entry is anchored to `/logs` so it can't swallow the
fixtures' `_git/logs/` reflogs. See `crates/git-ops/tests/fixtures/README.md`.

## Migration workflow

If you're porting a module from `desktop-plus`:

1. **Resolve the transitive import closure before you size the batch.** This is the hard-won
   lesson from Phase 1: a set of tests that looked like pure `models/`+`lib/` work actually
   pulled in 455 files (120 of them `ui/`) through a handful of bad import edges. Trace what a
   module *actually* drags in first — a file that looks like a leaf often isn't.
2. **Import analysis alone is not enough — also grep for ambient global namespaces.**
   Import-graph analysis is blind to `declare`d globals, which is how `models/app-menu.ts`
   looked portable right up until `tsc` rejected `Electron.MenuItem`. Before porting, run
   `grep -rn '\bElectron\.[A-Z]' <files>` (Electron coupling with no import) and
   `grep -rn '[^.]\bJSX\.[A-Z]' <files>` (the global `JSX` namespace React 19 removed —
   fix by adding `import type { JSX } from 'react'`).
3. Find its row in `MIGRATION_MAP.md` (or add one if missing) for the target path.
4. Port the corresponding test(s) from `desktop-plus/app/test/unit/**` first — get them
   compiling and red before writing the implementation. See `MIGRATION_PLAN.md` Phase 1 for
   the `node:test` → Vitest conversion recipe; keep assertions verbatim so the test stays a
   parity check rather than becoming a rewrite.
5. Port the implementation until the tests are green.
6. Flip the row's status in `MIGRATION_MAP.md` to `done` (or `skipped`, with a reason), and
   record any deliberate deviation from a verbatim port in its §8 table.

# Issues to solve
- Text blur after window resize on Wayland with gaps/positioning: https://github.com/tauri-apps/wry/issues/1727
