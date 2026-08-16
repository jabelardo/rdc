# AGENTS.md

Instructions for AI agents working in this repository. Humans want
[DEVELOPMENT.md](./DEVELOPMENT.md); this file is the short version plus the things that are easy to
get wrong.

## What this project is

`rdc` is a port of [`desktop-plus`](../desktop-plus) — a GitHub-Desktop-derived Electron app — to
Tauri 2. The frontend stays React (upgraded to 19); the Electron main process is being rewritten in
Rust. It is a **port, not a rewrite**: fidelity to the original's behaviour is the default, and every
intentional departure is recorded in [MIGRATION_MAP.md](./MIGRATION_MAP.md) §8.

Two documents are the source of truth for the work, and both are kept current as it proceeds:

- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) — the phased plan, with what's done and what was learned.
- [MIGRATION_MAP.md](./MIGRATION_MAP.md) — old path → new path, deliberate deviations, deferred work.

Read the relevant section before starting; they will usually answer "has this already been decided?"

## Setup

**Node 24, via nvm.** Not 22, not 26.

```sh
nvm use            # reads .nvmrc
```

Node 26 provides a global `localStorage` that shadows jsdom's, which silently breaks 17 frontend
tests. This is pinned in `.nvmrc`, `engines`, and CI — don't unpin it to make something work.

## Commands

```sh
pnpm test                    # Vitest (frontend)
pnpm exec tsc --noEmit       # typecheck
pnpm format:check            # oxfmt
pnpm lint                    # oxlint correctness + React hooks + import form
pnpm check:module-boundaries # shared -> features -> app; no barrels; one dialog per module
pnpm check:bundle-boundary   # no Node builtin reaches the webview
pnpm test:e2e                # E2E — always inside the Linux container
```

```sh
cd src-tauri
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

**Run all seven before committing.** CI enforces exactly these, and `clippy -D warnings` has caught
real bugs a passing test missed (an octal-looking `\0` escape, for one).

```sh
node scripts/measure-store-surface.mjs   # IPC coverage; needs ../desktop-plus, so not in CI
```

Not a per-commit gate — run it when closing a slice that adds or removes commands. It measures what
`MIGRATION_PLAN.md`'s Phase 3 exit criteria assert, in both directions: a store import with no command,
and a command no consumer asks for. Fix the numbers in the plan from its output, never by hand.

## Layout

```
src/                      frontend
  app/                    composition root — shell, dialog host, controller, menu/, sidebar/
  features/<name>/        one domain slice: stores, components, hooks, domain logic
  components/             shared components; components/ui/ is vendored shadcn, CLI-owned
  lib/                    named subsystems: ipc/, operations/, messages/, diff/, resilience/, …
  models/                 types Rust also knows — the wire contract
  platform/               the Tauri/OS adapter boundary
  utils/                  pure helpers
  testing/                test helpers and the debug state injectors
  lib/__generated__/      emitted by Rust tests; do not hand-edit
src-tauri/
  src/commands/           #[tauri::command] entry points
  crates/git-ops/         git plumbing (the bulk of the Rust)
  crates/trampoline/      credential bridge (GIT_ASKPASS/SSH_ASKPASS)
e2e/                      tauri-driver suite, container-only
```

Rust module names mirror the original TypeScript file names (`lib/git/status.ts` →
`crates/git-ops/src/status.rs`) so the two trees can be read side by side.

**Read [`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md) before adding a file.** It answers "where
does this go" in one pass, and the answer is enforced: dependencies run shared → features → app,
imports are `./sibling` or `@/`, and `pnpm check:module-boundaries` plus two oxlint rules fail the
build on a violation. The rule the checker cannot enforce is the one worth remembering — a module
with a single consumer parked in a shared layer breaks nothing and is still wrong.

## Rules that are easy to get wrong

**1. If it ran on Node, it probably belongs in Rust — not in ported TypeScript.**
Guiding principle 5 in MIGRATION_PLAN.md. Of the original's blocking files, only 67 of 374 were
actually Node-bound; porting those to Rust unblocked the other 307. Reach for Rust before reaching
for a Node shim.

**2. IPC is native Tauri, and domain types belong to TypeScript.**
`#[tauri::command]` + `invoke` + Channels. No binding generator — this was evaluated (ts-rs was
prototyped) and rejected; see MIGRATION_MAP.md §8 for why, so it doesn't get re-litigated.

> **If a type already exists in `src/models/**`, the IPC layer imports it. Never redeclare it.**

Breaking that rule caused a real bug: a second `AppFileStatus` in `git-ipc.ts` diverged from the
ported one, and every test passed because they all agreed with each other and not with the domain
model. Commands return `CommandError`, never `String` — `.map_err(|e| e.to_string())` throws away
the `GitErrorKind` classification.

**3. Changing a wire shape means regenerating the snapshot.**

```sh
UPDATE_WIRE_SNAPSHOT=1 cargo test -p git-ops --test wire_contract
```

`src/lib/__generated__/wire-snapshot.json` is Rust's real serializer output; `src/lib/ipc/git-ipc.test.ts`
compares it against fixtures that `tsc` checks against `src/models/**`. Both sides must be updated
together — that pairing is what makes drift impossible.

**4. Port the tests first.**
The original's `app/test/unit/**` is the specification. Translate the test, watch it fail, then
implement. Tests that can't be ported yet are listed as deferred in MIGRATION_MAP.md §9 with the
blocker named — don't silently skip one.

**5. Never edit `src-tauri/crates/git-ops/tests/fixtures/**`.**
These are real git repositories with `_git` directories. Their bytes are load-bearing: a global
find-and-replace once rewrote `HEAD` to point at a branch that didn't exist. `.gitattributes` marks
them `-text -diff`.

**6. Verify upstream behaviour against real git before "fixing" it.**
The original has genuine bugs, and three have been found and corrected so far (a regex that dropped
renamed binary paths, a fire-and-forget getter, a SHA parser that returns `"(root-commit)"` for a
repository's first commit). It has also been *right* in surprising ways. Run the command and look
before deciding which case you're in, then record the outcome in MIGRATION_MAP.md §8.

**7. A test must not depend on the machine's own git configuration.**
Two tests passed locally and failed only in CI, both because they asked what git does when the
*repository's* config has no answer — which is the one situation where the ambient global and system
config decide the outcome. Concretely:

- A **system-wide `safe.directory = *`** (CI images set one) suppresses git's dubious-ownership check
  entirely. A test asserting that check needs a stub config with an empty `safe.directory`, which resets
  the list.
- **Identity fallback** depends on a global `user.name`/`user.email` existing, and on a hostname carrying
  a domain for git to synthesise an email from. A fresh Linux runner has neither.

Pin the config instead of hoping: pass `GIT_CONFIG_GLOBAL` (and `GIT_CONFIG_NOSYSTEM` where the system
layer matters) per invocation via a `*_with_env` sibling — `rev_parse::get_repository_type_with_env` and
`var::get_author_identity_with_env` are the pattern. **`HOME` alone is not enough**: `GIT_CONFIG_GLOBAL`
outranks it, which once meant `GlobalConfig::with_home` could be silently redirected at the developer's
real `~/.gitconfig`. Never mutate the process environment to do this — see MIGRATION_MAP.md §8.

To check a test locally the way CI would see it:

```sh
SYS=$(mktemp); GLOB=$(mktemp)
printf '[safe]\n\tdirectory = *\n' > "$SYS"      # what CI images set
GIT_CONFIG_SYSTEM="$SYS" GIT_CONFIG_GLOBAL="$GLOB" cargo test -p git-ops
```

**8. Verify Linux behaviour on a Linux that matches the target.**
Ubuntu 26.04 is the primary target (git 2.53); CI runs `ubuntu-latest`. A quick container check catches what
a macOS dev machine cannot — two real bugs were found this way — but **pick the image to match the
question**: use Trixie for primary-target investigation, and Bookworm for compatibility with Debian 12's
system Git. Bookworm remains in rdc's support surface through its LTS end on **June 30, 2028**, and CI has
a dedicated old-Git job for it.

```sh
docker run --rm -v "$PWD:/src:ro" -e CARGO_TARGET_DIR=/tmp/target -w /src/src-tauri \
  rust:1-slim-trixie bash -c 'apt-get update -qq && apt-get install -y -qq git && cargo test -p git-ops'
```

Two Linux-specific traps already found, both documented in MIGRATION_MAP.md §8: **`ETXTBSY`** — running an
executable that was just written races with `fork` in another thread, so link or interpret rather than copy
and exec — and **git version drift**, since rdc runs the *system* git where upstream bundled its own.

**9. Utilities: native JavaScript first, then Radash, and Lodash only as a last resort** — and if
Lodash is unavoidable it must be ≥ 4.18.1 for security reasons.

**10. E2E runs only in the Linux container**, on every host including Linux. Linux is the primary
target; current desktop environments are Wayland-only, so don't add X11-dependent assumptions
outside the container harness. **One spec file per product slice, and no cross-file ordering** —
each file builds its own fixture, starts its own application session and establishes its own
preconditions by CLI. The suite was once a single file where each test inherited the previous
test's state, so one early failure erased the signal from every test after it. `run.sh` passes
`--test-concurrency=1`; that is load-bearing, not tidiness (single `tauri-driver` port, plus a
process-wide `pkill -x rdc` in the restart spec). The webview's IndexedDB survives restarts and is
shared by every file, so specs asserting on repository state call `resetRepositoryFixtures` first.

**11. Platform-specific imports never sit at the scope of a portable module.**
`std::os::unix`, `std::os::windows` and `libc::` belong inside a `#[cfg]`-gated inner module (or a
per-OS file), which exports a **platform-neutral signature** so callers never know. Pure logic is
never gated at all.

This is about keeping Phase 10 additive. `platform/custom_integration.rs` is the worked example: of
260 lines exactly 10 are unix-specific (`has_execute_access`, deliberately using `libc::access` to
keep upstream's ACL-aware check), and its `use std::os::unix::ffi::OsStrExt` used to sit at *file
scope*, so those 10 lines made 250 lines of portable logic uncompilable on Windows. They now live in
a `#[cfg]`-gated inner `executable` module exporting a platform-neutral signature; Phase 10 adds an
arm there instead of restructuring anything. Copy that shape.

Two follow-on rules the same exercise produced:

- **Never `#[cfg(any(target_os = "…", test))]` on something whose body makes OS calls.** The `test`
  arm compiles it on *every* platform's test profile — which is how `platform::cli_installer`'s
  inline `std::os::unix::fs::symlink` broke a Windows `--all-targets` check for a macOS-only
  feature. Gate the call (`cli_installer`'s `link` module), not the module.
- **Every arm of a seam must have the same signature, and be compiled by something.** An arm nobody
  builds is not a fallback, it is unreviewed code: `rdc-printenvz`'s Windows `as_bytes` returned
  `Cow<[u8]>` where the Unix arm returned `&[u8]`, and the resulting `write_all` type error sat
  undiscovered because no gate ever compiled it.
- Where the platform answer is a *behavioural* choice rather than a translation, don't guess — leave
  a `compile_error!` naming the decision. "Executable" on Windows means `PATHEXT` membership or a
  DACL `AccessCheck`, not a mode bit; picking one is Phase 10's job. A file symlink, by contrast,
  maps exactly (`symlink_file`), so `cli_installer` implements both arms.

Measured, so the scale is not guessed: **`git-ops` compiles cleanly for `x86_64-pc-windows-msvc`
with `--all-targets`** — library, binaries and tests — and CI keeps it that way. See DEVELOPMENT.md
for the local one-liner.

## Conventions

- **Rust**: `thiserror` for errors; no `unwrap()` outside tests; comments explain *why*, and any
  non-obvious git behaviour gets a note about how it was verified.
- **TypeScript**: follow the original's style where it's reasonable, and flag genuine weak points
  rather than porting them silently — improvements go in MIGRATION_MAP.md §8.
- **Commits**: explain the reasoning and any surprise, not just the change. Existing history is the
  model. Default branch is `main`; this repo pushes as the `jabelardo` identity.
