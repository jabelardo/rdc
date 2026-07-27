# Development

`rdc` is a Tauri 2.0 + React 19 rewrite of [`desktop-plus`](../desktop-plus), migrated
according to [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) (phases and decisions) and
[`MIGRATION_MAP.md`](./MIGRATION_MAP.md) (old path → new path, per module). Read those first
for *why* things are structured this way; this document is just *how* to work in the repo
day to day.

## Prerequisites

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
docker compose -f docker-compose.e2e.yml run --rm e2e
```

This builds `Dockerfile.e2e` (Ubuntu 26.04 + Rust + `tauri-driver` + WebKitWebDriver + a
headless Xvfb display) and runs [`e2e/run.sh`](./e2e/run.sh) inside it. As of this writing
there's no application-level E2E spec suite yet (see `MIGRATION_PLAN.md` Phase 8) — the script
currently just verifies the harness itself (Xvfb + `tauri-driver`) starts correctly.

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

## Migration workflow

If you're porting a module from `desktop-plus`:

1. Find its row in `MIGRATION_MAP.md` (or add one if missing) for the target path.
2. Port the corresponding test(s) from `desktop-plus/app/test/unit/**` first — get them
   compiling and red before writing the implementation.
3. Port the implementation until the tests are green.
4. Flip the row's status in `MIGRATION_MAP.md` to `done` (or `skipped`, with a reason).

# Issues to solve
- Text blur after window resize on Wayland with gaps/positioning: https://github.com/tauri-apps/wry/issues/1727