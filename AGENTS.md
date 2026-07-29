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
pnpm test:e2e                # E2E — always inside the Linux container
```

```sh
cd src-tauri
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

**Run all five before committing.** CI enforces exactly these, and `clippy -D warnings` has caught
real bugs a passing test missed (an octal-looking `\0` escape, for one).

```sh
node scripts/measure-store-surface.mjs   # IPC coverage; needs ../desktop-plus, so not in CI
```

Not a per-commit gate — run it when closing a slice that adds or removes commands. It measures what
`MIGRATION_PLAN.md`'s Phase 3 exit criteria assert, in both directions: a store import with no command,
and a command no consumer asks for. Fix the numbers in the plan from its output, never by hand.

## Layout

```
src/                      frontend — mirrors desktop-plus/app/src/
  models/                 ported domain types (TypeScript owns these — see below)
  lib/                    ported portable logic
  lib/git-ipc.ts          typed `invoke` wrappers
  lib/__generated__/      emitted by Rust tests; do not hand-edit
src-tauri/
  src/commands/           #[tauri::command] entry points
  crates/git-ops/         git plumbing (the bulk of the Rust)
  crates/trampoline/      credential bridge (GIT_ASKPASS/SSH_ASKPASS)
e2e/                      tauri-driver suite, container-only
```

Rust module names mirror the original TypeScript file names (`lib/git/status.ts` →
`crates/git-ops/src/status.rs`) so the two trees can be read side by side.

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

`src/lib/__generated__/wire-snapshot.json` is Rust's real serializer output; `src/lib/git-ipc.test.ts`
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
outside the container harness.

## Conventions

- **Rust**: `thiserror` for errors; no `unwrap()` outside tests; comments explain *why*, and any
  non-obvious git behaviour gets a note about how it was verified.
- **TypeScript**: follow the original's style where it's reasonable, and flag genuine weak points
  rather than porting them silently — improvements go in MIGRATION_MAP.md §8.
- **Commits**: explain the reasoning and any surprise, not just the change. Existing history is the
  model. Default branch is `main`; this repo pushes as the `jabelardo` identity.
