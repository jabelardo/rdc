# Backend structure — the layout, and the rule that keeps it

**Status:** written 2026-08-17. The guideline is settled; the `commands/` reorganization it
prescribes is in progress, phase by phase, at the end of this document.

**Read this before adding a Rust file.** [Where does this file go?](#where-does-this-file-go)
answers it in one pass; [The rule](#the-rule) is the one idea everything else follows from.

**Applies to:** `src-tauri/` — the app crate, `crates/git-ops/` and `crates/trampoline/`.
`src/` (the renderer) has its own guideline in
[`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md), and the two documents deliberately disagree in
four places — see [Where the frontend guideline does not
transfer](#where-the-frontend-guideline-does-not-transfer).

Two audiences, one document:

- **Writing new code** — [Where does this file go?](#where-does-this-file-go) answers it in one
  pass, and [Enforcement](#enforcement) fails the build when it is answered wrong.
- **Reorganizing today's code** — [The move](#the-move) sequences the work and says what is
  deliberately left alone.

---

## Where this came from

Three sources, and they do not agree. Recording which was followed where, because a later reader
will otherwise assume the disagreements were oversights.

| Source | Followed | Departed, and why |
|---|---|---|
| [`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md) | The **method**: name one rule, derive everything from it, enforce the direction with a check that fails the build, move in mechanical commits, and record the reasoning rather than only the outcome | Most of its **content** does not transfer. Rust gets no `models/`, keeps its facades, and puts tests inside the file being tested — each for a reason specific to the language or to this repo. All four are itemised [below](#where-the-frontend-guideline-does-not-transfer) |
| `desktop-plus/app/src/lib/git/**` | `crates/git-ops/` mirrors it **file for file**: 53 of its 63 modules carry the upstream module's name. AGENTS.md already states the rule; this document records what depends on it and freezes it | Not for `src-tauri/src/`. desktop-plus's IPC was a single flat `ipc-main.ts` plus `ipc-shared.ts` — a channel list, not a layout. There was nothing there to mirror, which is exactly why `commands/` drifted |
| The `tauri-setup` skill | `commands/` as the IPC surface, `#[tauri::command]`, managed state, `Result<T, E: Serialize>` | Its **prescribed tree** — `db/`, `git/`, `types.rs`, `error.rs` at the crate root — describes an app that never existed here. rdc has no database, and its git layer is a separate crate an order of magnitude larger than the app. That stub was this file's entire previous contents |

**The one thing all three agree on:** the layer that talks to the outside world must hold no logic
of its own, and the layers underneath it must not know that layer exists.

---

## The rule

> **Dependencies point one way: `crates/` → app services → `commands/` → Tauri.**

Three consequences, and they are the whole guideline:

1. **A crate knows nothing about Tauri.** Neither `git-ops` nor `trampoline` names `tauri` in its
   manifest or its sources, and neither may start. This is not a stylistic preference — it is what
   buys three things the project already depends on: `cargo test -p git-ops` runs the bulk of the
   test suite with no app and no display server; `cargo check -p git-ops --target
   x86_64-pc-windows-msvc` is green today even though the app crate cannot compile for Windows until
   Phase 10; and the two hostile-environment CI jobs can build `git-ops` alone without webkit or gtk.
2. **The two crates may not depend on each other.** They do not, and the app is what composes them
   — `git_ops::authentication` defines the *shape* of the environment git needs, and the app is what
   fills it in from a `trampoline::Session`. This is the same rule as the frontend's "a feature may
   not import another feature", holding one level up, at the crate boundary.
3. **`commands/` holds no logic.** A command translates arguments, adapts errors, and drives the
   operation registry. Anything worth testing on its own belongs in a crate, where it can be tested
   without a Tauri app. `commands/git.rs` already says this in its doc comment; this makes it the
   rule rather than one module's aspiration.

### And the rule `commands/` was missing

The layer rule above says what `commands/` may *depend on*. It says nothing about how the 152
commands are distributed across modules, and that absence is the whole defect this document was
written to fix.

> **A command module is named for the frontend feature that calls it.**

Not for the git subcommand it runs — that is `git-ops`' axis, and reusing it here would give two
modules the same name and different contents. Not for how many lines it takes, not for whether it
needs credentials. The frontend's `src/features/` vocabulary is the vocabulary, because a command
exists precisely to serve one of those features, and "which file is this command in" should have the
same answer as "which part of the UI calls it".

---

## Where the frontend guideline does not transfer

Four rules from `PROJECT_STRUCTURE.md` are inverted here. Each inversion is deliberate, and each has
a reason specific to Rust or to this repo — not one of them is drift.

### There is no `models/`, and adding one has a cost the frontend's does not

The frontend needs `src/models/` because in TypeScript **nothing marks a type as crossing the IPC
boundary**. A `Branch` interface and a renderer-only `BranchPickerState` are indistinguishable at a
glance, so the boundary is expressed as a directory.

Rust marks it in the type itself. `#[derive(Serialize)]` *is* the annotation, and
`crates/git-ops/tests/wire_contract.rs` pins every shape it produces against
`src/lib/__generated__/wire-snapshot.json`. The contract has a checker, so it does not need an
address.

It also could not have one at an acceptable cost. The wire types are produced in four places —
`git_ops::Diff` and `git_ops::Commit`, `crate::operation::OperationEvent`,
`platform::menu_model::MenuModel`, `crate::config::MainProcessConfig` — and the git half is the
largest of them. Gathering it into a directory means renaming the modules that
[the mirror](#git-ops-is-frozen-and-why) depends on.

**So: define a serialized type where the data is produced.** What proves it has not drifted is the
snapshot test, and changing a shape means regenerating it:

```sh
UPDATE_WIRE_SNAPSHOT=1 cargo test -p git-ops --test wire_contract
```

### Facades are right here and wrong there

`src/` forbids `index.ts` barrels for a reason specific to this repo:
`scripts/check-bundle-boundary.mjs` walks the real import graph to prove no Node builtin reaches the
webview, and a barrel makes every consumer of one symbol look like a consumer of all of them.

Rust has no bundle and no such analysis, and `pub use` in `lib.rs` is how a crate states its public
API. `git-ops`' 140-line facade stays.

**But import through the module path, not the facade** — `git_ops::branch::create_branch`, not
`git_ops::create_branch`. The reason is the mirror again: the module segment tells a reader that the
upstream file is `lib/git/branch.ts` and the acceptance spec is `test/unit/git/branch-test.ts`,
which is the exact information the port is organized around. The flat re-export erases it.

Measured 2026-08-17: **249 call sites use the module path, 150 use the facade** — so this codifies
what the code already mostly does rather than imposing something new. The 150 are not worth a sweep;
the pervasive error types (`git_ops::GitError`, `git_ops::TerminationReason`) read better flat
anyway, and everything else can convert as it is touched.

### Tests live inside the file they test

The frontend puts `validate-branch-name.test.ts` beside `validate-branch-name.ts`. Rust puts
`#[cfg(test)] mod tests` at the bottom of the module, because that is what gives tests access to
private items — a sibling file would be a separate crate-external integration test and could only
reach the public API.

The consequence to expect, since it distorts every measurement of this codebase: **roughly 45% of
the Rust is tests.** `git-ops/src/diff.rs` is 2,807 lines and 1,331 of them are tests;
`operation_registry.rs` is 1,305 and 796 are. Never judge a module's size from `wc -l` — the
`#[cfg(test)]` block is usually the larger half.

`tests/` at a crate root is for what genuinely must run from outside: `wire_contract.rs`,
`hook_proxy_end_to_end.rs`, `handlers_end_to_end.rs`.

### `platform/` splits its wire types out; the frontend's does not

Six pairs in `src/platform/` — `menu_model.rs`/`menu.rs`, `window_model.rs`/`window.rs`,
`editor_model.rs`/`editors.rs`, `shell_model.rs`/`shells.rs`,
`keybinding_model.rs`/`keybindings.rs`, `custom_integration_model.rs`/`custom_integration.rs`.

The convention is uniform and it is about `#[cfg]`, not about tidiness. **Every `*_model.rs`
contains zero `cfg` attributes**; its partner is `cfg`-gated throughout, because discovering an
editor means reading `/usr/bin` on Linux and querying bundle identifiers on macOS. Without the
split, `FoundEditor` — a type the frontend receives on every platform — would only exist on the
targets whose discovery code compiled.

**Keep the split, and keep models `cfg`-free.** A `#[cfg]` inside a `*_model.rs` is the bug this
shape exists to prevent.

---

## The shape

```
src-tauri/
├── Cargo.toml                  # workspace root *and* the app package
├── build.rs, tauri.conf.json, capabilities/
├── src/                        # the Tauri app: IPC, OS adapters, app-owned state
│   ├── main.rs                 # 6 lines; calls lib::run()
│   ├── lib.rs                  # composition root: plugins, managed state, the handler list
│   ├── commands/               # the IPC surface — see below
│   ├── platform/               # the OS adapter boundary; *_model.rs / impl pairs
│   ├── operation.rs            # operation wire types
│   ├── operation_registry.rs   # operation metadata and per-repository write locks
│   ├── hook_state.rs           # the app's half of git hook interception
│   ├── trampoline_state.rs     # lazy-start credential server and sessions
│   ├── blob_protocol.rs        # the rdc-blob:// scheme
│   ├── config.rs               # main-process config
│   ├── resilience.rs           # panic logging
│   ├── security.rs             # navigation policy
│   └── qa_driver.rs            # debug-only; #[cfg(debug_assertions)]
└── crates/
    ├── git-ops/                # 63 modules mirroring desktop-plus lib/git/** — FROZEN, see below
    │   ├── src/hooks/          # the one subfolder: hook discovery, protocol, runner, server
    │   ├── src/bin/            # rdc-hook-proxy, rdc-printenvz
    │   └── tests/              # wire_contract.rs and the hook end-to-end suites
    └── trampoline/             # the GIT_ASKPASS/SSH_ASKPASS credential bridge
        └── src/bin/            # rdc-trampoline
```

### `commands/` anatomy

Two subfolders and two loose modules. The split is by **what the command reaches for**, and it is
[checked](#enforcement):

```
src/commands/
├── mod.rs                      # the module list and the IPC conventions
├── error.rs                    # CommandError — the error contract
├── operations.rs               # the operation registry's own commands
├── git/                        # may use git_ops; may not use crate::platform
│   ├── branches.rs   changes.rs   conflicts.rs   history.rs
│   ├── remotes.rs    repositories.rs   stash.rs   worktree.rs
│   ├── submodules.rs   tags.rs   lfs.rs   trailers.rs   hooks.rs
│   └── operation_lifecycle.rs  # start/finish/recover against the registry, shared
└── platform/                   # may use crate::platform; may not use git_ops
    └── one module per src/platform/ module it adapts
```

`error.rs` and `operations.rs` stay at the top level rather than acquiring a folder, following the
frontend's rule that **a subfolder names a unit whose parts are used together, and a single module
stays where it is.**

---

## git-ops is frozen, and why

A first read of `crates/git-ops/src/` shows 63 modules flat in one directory and suggests the same
reorganization the frontend just went through. The measurement below is the reason not to.

53 of those 63 modules carry the name of the desktop-plus module they port:

| | Count |
|---|---|
| Mirrors `desktop-plus/app/src/lib/git/*.ts` | 50 |
| Mirrors `desktop-plus/app/src/lib/*.ts` one level up (`diff-parser`, `status-parser`, `patch-formatter`) | 3 |
| rdc's own, with no upstream counterpart | 10 |

Three things depend on that mirror. AGENTS.md rule 4 makes the original's `app/test/unit/git/**` the
specification, `MIGRATION_MAP.md` tracks the port module by module against it, and the workflow is
to open the two files side by side. Renaming `status.rs` or filing it under `queries/` costs the
reader the ability to find `status.ts`, and costs the map its keys.

**So the rule for `crates/git-ops/` is: mirror the upstream module name.** New modules with no
upstream counterpart are named for the git subcommand they wrap. Do not introduce subfolders.

The ten rdc-invented modules are the substrate dugite provided and the port had to write: `exec` and
`error` (replacing `core.ts`, `spawn.ts`, `environment.ts`), `git_error_kind`, `progress` (which
collapses desktop-plus's 10-file `lib/progress/` folder), `remote_progress`, `terminal_output`,
`operation_identity`, `operation_state`, and `test_support`.

`hooks/` is the one subfolder and earns it: eight modules implementing a single subsystem — discover
which hooks exist, run them with a login-shell environment, talk to the `rdc-hook-proxy` binary over
loopback TCP, stream the output back. Nothing outside it reaches past `runner` and `with_env`.

**Revisit this only when the port is verified complete**, not before. Until then the flat list is
the map.

---

## Where does this file go?

Answer in order; the first match wins.

1. **Does it run `git`?** → `crates/git-ops/`, in the module named after the desktop-plus file it
   ports, or after the git subcommand if there is none. Never a new subfolder.
2. **Does it answer a credential or host-key prompt that git made?** → `crates/trampoline/`.
3. **Does it talk to the OS** — windows, native menus, notifications, the trash, editors, shells,
   keybindings, the keychain? → `src/platform/`, and its serialized types go in the `*_model.rs`
   half so they compile on every target.
4. **Is it long-lived state the app `.manage()`s?** → a named module at `src/`. There are five
   today and they are enough of a set to recognize: `operation_registry`, `hook_state`,
   `trampoline_state`, `blob_protocol`, and the `*State` types that live beside their commands.
5. **Is it a `#[tauri::command]`?** → `src/commands/git/<feature>.rs` if it reaches for `git_ops`,
   `src/commands/platform/<adaptee>.rs` if it reaches for `crate::platform`. The feature name comes
   from `src/features/`, not from the git subcommand.
6. **Does it wire the application together** — a plugin, managed state, the handler list, a URI
   scheme, a window event? → `src/lib.rs`, which is the composition root and the only place that
   knows all of the above.

> **"It calls git *and* it touches the OS."** Then it is two things and belongs in two places. The
> worked example is remote operations: `git_ops::push` runs git, `trampoline` answers the prompt git
> makes, and `commands/git/remotes.rs` is the only place those two meet. A command is allowed to
> compose; a crate is not.

---

## Directory reference

| Directory | Holds | Explicitly not |
|---|---|---|
| `crates/git-ops/` | Everything that runs `git`, plus the parsers for what it prints | Anything that knows Tauri exists, or a subfolder that breaks the mirror |
| `crates/trampoline/` | The askpass/credential bridge, both ends of it | Policy about *which* account applies — that is the app's, injected through `CredentialProvider` |
| `src/commands/` | Argument translation, error adaptation, operation-registry lifecycle | Logic. If it is worth a unit test of its own, it is in the wrong layer |
| `src/platform/` | The OS adapter surface, and the `cfg`-free wire types for it | Git domain logic. "It's an OS call" is the test, not "it's not git" |
| `src/*.rs` (root) | Named app-wide subsystems: the operation registry, hook and trampoline state, the blob scheme, config, panic logging, navigation policy | A drawer. Nine named modules is a set; if it reaches twenty, revisit |
| `src/lib.rs` | The composition root | Domain logic of any kind |

---

## Conventions

### Naming

| Kind | Convention | Example |
|---|---|---|
| Modules and files | `snake_case.rs` | `operation_registry.rs`, `blob_protocol.rs` |
| A `git-ops` module | The upstream desktop-plus file name, or the git subcommand | `for_each_ref.rs`, `rev_parse.rs` |
| A `commands/git` module | The **plural** frontend feature name | `branches.rs`, `remotes.rs`, `repositories.rs` |
| A `commands/platform` module | The `src/platform/` module it adapts | `commands/platform/window.rs` → `platform/window.rs` |
| Platform wire types | `<thing>_model.rs`, and no `cfg` inside | `menu_model.rs` |

### The error contract

**Every command returns `Result<T, CommandError>`. Never `Result<T, String>`, and never
`.map_err(|e| e.to_string())`** — that discards the `GitErrorKind` classification and leaves the
frontend pattern-matching on English prose. `CommandError` carries a developer-facing `message`, the
machine-readable `kind`, and `is_auth_failure` derived from it because auth is the case the UI
almost always special-cases. Both halves of that rule are [checked](#enforcement).

A panic must never cross the IPC boundary.

### Arguments arrive camelCase

Tauri converts by default, so a Rust `repository_path` parameter is sent as `repositoryPath`. A
command's parameter list **is** its wire API: `#[allow(clippy::too_many_arguments)]` is the right
answer when the lint fires, because grouping the parameters to satisfy it would change what the
frontend sends. `commands/remote.rs`'s `pull` carries that allow with the reason written next to it.

### Declare the Cargo features you use

`cargo check --workspace` unifies features across the graph, so a crate can use an API whose feature
it never declared and compile anyway because a sibling enabled it. That is not hypothetical:
`trampoline` used `tokio::process` without declaring `process`, and every gate stayed green while
`cargo check -p trampoline` alone was broken. CI now checks each crate in isolation for exactly this.

### Types the frontend already knows

**If a type exists in `src/models/**`, the IPC layer serializes to it — never redeclare it.**
Breaking that caused a real bug: a second `AppFileStatus` in `git-ipc.ts` diverged from the ported
one, and every test passed because they all agreed with each other and not with the domain model.

---

## Enforcement

`commands/` accumulated four grouping axes over the course of the port with no check that could
fire on any of them. These are the assertions that can be made mechanical.

The checks live in **`src-tauri/tests/structure.rs`**, a Rust integration test. Deliberately not a
Node script in `scripts/` beside the frontend's checkers: this runs under `cargo test --workspace`,
which is already a CI gate and already the command a Rust change runs locally, so it needs no new
wiring and cannot be forgotten.

It asserts:

1. **Every `#[tauri::command]` in `src/commands/**` appears in `generate_handler!`, and every entry
   in `generate_handler!` resolves to one.** An unregistered command compiles silently and is dead
   from the frontend's point of view — the failure mode with the least evidence at the crash site.
2. **No module under `commands/platform/` names `git_ops`.**
3. **No module under `commands/git/` names `crate::platform`.**
4. **Neither crate manifest names `tauri`** — consequence 1 of [the rule](#the-rule), which is true
   today and has nothing keeping it true.
5. **No `Result<_, String>` and no `map_err(|e| e.to_string())` under `commands/`.**

Each assertion was verified by planting a violation and watching it fail. A violation is a build
failure, not a review comment.

**What no check can defend**, and so has to be held by whoever writes the code: rule 3 of
[the rule](#the-rule) — that `commands/` holds no logic. A helper function in a command module
breaks nothing mechanical. The frontend guideline records the same limit about single-consumer
modules in shared layers, and it is worth repeating here: *the checker enforces direction, not
cohesion.*

---

## The move

One mechanical commit per phase, **no behaviour change in any of them**, the full Rust gate set
between each:

```sh
cd src-tauri
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check -p git-ops --lib && cargo check -p trampoline --lib
cargo check -p git-ops --all-targets --target x86_64-pc-windows-msvc
```

Splitting a reorganization across feature work is how it ends up half-applied, which is the state
being fixed.

### What is deliberately not in the move

Named up front so nobody reads the omission as an oversight:

- **`crates/git-ops/`** — frozen, [for the reasons above](#git-ops-is-frozen-and-why).
- **`crates/trampoline/`** — 7 modules, a facade documented in its crate doc comment, and its two
  injection points (`CredentialProvider`, `AskpassResponder`) named there. It already satisfies
  every rule in this document.
- **`src/platform/`** — the `*_model.rs` convention holds across all six pairs, with zero `cfg`
  attributes in any model file. Measured 2026-08-17.
- **The nine root modules of `src/`** — each is a named subsystem. The defect
  `PROJECT_STRUCTURE.md` was fixing was 72 loose modules in `src/lib/` mixing pure helpers, IPC
  wrappers, domain logic and dead code; nine named subsystems is a different measurement, not a
  smaller instance of the same one. `operation.rs` and `operation_registry.rs` could become an
  `operation/` folder; that would change no import outside the two files.

### Phase 1 — lift `commands/platform/`

Move the 13 OS-facing command modules into `src/commands/platform/`. Pure file moves plus the paths
in `lib.rs` and `commands/mod.rs`; no function moves, no command changes address in
`generate_handler!` beyond its module prefix.

### Phase 2 — lift `commands/git/`

The same for the git-facing modules. `error.rs` and the operation commands stay at the top level.

### Phase 3 — dissolve `misc.rs`

29 commands across ten domains, grouped by nothing but each being small. They go to `tags`,
`trailers`, `lfs`, `repositories`, `history` and `branches`. The module ceases to exist.

### Phase 4 — split `git.rs` by domain

33 commands across seven domains — the largest single piece, and **the one phase that is not pure
motion.** The module's ~14 operation-lifecycle helpers (`start_*_operation`, `finish_*_mutation`,
`recover_*_termination`, `*_termination_details`) are shared across the boundaries the split
introduces: the checkout family is called by branches, history *and* changes. They go to
`commands/git/operation_lifecycle.rs` rather than travelling with any one domain, and their
visibility widens from private to `pub(super)`.

### Phase 5 — split `stash.rs`, rename the rest

`stash.rs` holds stash, cherry-pick, squash, reorder and submodules — five things, on the stated
grounds that none of them needs a credential session. Cherry-pick, squash and reorder are history
rewriting and go to `history.rs`; submodules get their own module. `remote.rs` → `remotes.rs` and
`operation.rs` → `operations.rs`, for the plural feature vocabulary.

### Phase 6 — turn the checks on

`src-tauri/tests/structure.rs`, with each assertion verified by planting a violation.
