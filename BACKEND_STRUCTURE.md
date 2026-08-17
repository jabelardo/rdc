# Backend structure — the layout, and the rule that keeps it

**Status:** applied and enforced, 2026-08-17. Every phase landed and `src-tauri/tests/structure.rs`
fails the build on a violation. `commands/` went from 23 modules on four grouping axes to `git/`,
`platform/` and the two that are neither.

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
| `desktop-plus/app/src/lib/git/**` | `crates/git-ops/` mirrors it **file for file**: 54 of its 63 modules carry the upstream module's name. AGENTS.md already states the rule; this document records what depends on it and freezes it | Not for `src-tauri/src/`. desktop-plus's IPC was a single flat `ipc-main.ts` plus `ipc-shared.ts` — a channel list, not a layout. There was nothing there to mirror, which is exactly why `commands/` drifted |
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
3. **`commands/` holds no reusable git or OS domain logic.** A command translates arguments, adapts
   errors, and composes Tauri inputs with app-owned state and the lower layers. Command-specific
   orchestration — operation locks, cancellation, recovery, channels and credential sessions — may
   live here and may need tests. Logic that can be expressed without the IPC boundary belongs in a
   crate or app service, where it can be tested without a Tauri app. The old `commands/git.rs`
   claimed a stricter version in its doc comment, but its own recovery tests already disproved that
   wording; the split made the actual boundary visible.

### And the rule `commands/` was missing

The layer rule above says what `commands/` may *depend on*. It says nothing about how the 153
commands are distributed across modules, and that absence is the whole defect this document was
written to fix.

> **A command module is named for the frontend capability that calls it.**

Not for the git subcommand it runs — that is `git-ops`' axis, and reusing it here would give two
modules the same name and different contents. Not for how many lines it takes, not for whether it
needs credentials. Start with the vocabulary in `src/features/`; smaller IPC-only capabilities such
as `gitignore`, `lfs`, `tags` and `trailers` keep their established frontend vocabulary rather than
being forced into an unrelated top-level feature. A command exists to serve a frontend capability,
so "which file is this command in" should have the same answer as "which part of the UI calls it".

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

Measured 2026-08-17: **243 call sites use the module path, 138 use the facade** — so this codifies
what the code already mostly does rather than imposing something new. The 138 are not worth a sweep;
the pervasive error types (`git_ops::GitError`, `git_ops::TerminationReason`) read better flat
anyway, and everything else can convert as it is touched.

### Tests live inside the file they test

The frontend puts `validate-branch-name.test.ts` beside `validate-branch-name.ts`. Rust puts
`#[cfg(test)] mod tests` at the bottom of the module, because that is what gives tests access to
private items — a sibling file would be a separate crate-external integration test and could only
reach the public API.

The consequence to expect, since it distorts every measurement of this codebase: **45% of the Rust
is tests** — 28,813 lines of 62,753, measured 2026-08-17.
`git-ops/src/diff.rs` is 2,807 lines and 1,331 of them are tests;
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
│   ├── branches.rs   changes.rs      conflicts.rs   history.rs
│   ├── remotes.rs    repositories.rs stash.rs       worktree.rs
│   ├── diffs.rs      gitignore.rs    hooks.rs       lfs.rs
│   ├── submodules.rs tags.rs         trailers.rs
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

54 of its 63 top-level modules carry the name of the desktop-plus module they port:

| | Count |
|---|---|
| Mirrors `desktop-plus/app/src/lib/git/*.ts` | 51 |
| Mirrors `desktop-plus/app/src/lib/*.ts` one level up (`diff-parser`, `status-parser`, `patch-formatter`) | 3 |
| rdc's own, with no upstream counterpart | 9 |

Measured 2026-08-17, plus the `hooks/` subfolder.

Three things depend on that mirror. AGENTS.md rule 4 makes the original's `app/test/unit/git/**` the
specification, `MIGRATION_MAP.md` tracks the port module by module against it, and the workflow is
to open the two files side by side. Renaming `status.rs` or filing it under `queries/` costs the
reader the ability to find `status.ts`, and costs the map its keys.

**So the rule for `crates/git-ops/` is: mirror the upstream module name.** New modules with no
upstream counterpart are named for the git subcommand they wrap. Do not introduce subfolders.

The nine rdc-invented modules are the substrate dugite provided and the port had to write: `exec`
and `error` (replacing `core.ts`, `spawn.ts`, `environment.ts`), `git_error_kind`, `progress` (which
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

1. **Does it implement a git invocation or parse git's output?** → `crates/git-ops/`, in the module
   named after the desktop-plus file it ports, or after the git subcommand if there is none. Never a
   new subfolder. An IPC adapter that calls this API continues to step 5.
2. **Does it answer a credential or host-key prompt that git made?** → `crates/trampoline/`.
3. **Does it talk to the OS** — windows, native menus, notifications, the trash, editors, shells,
   keybindings, the keychain? → `src/platform/`, and its serialized types go in the `*_model.rs`
   half so they compile on every target.
4. **Is it long-lived state the app `.manage()`s?** → a named module at `src/`. There are five
   today and they are enough of a set to recognize: `operation_registry`, `hook_state`,
   `trampoline_state`, `blob_protocol`, and the `*State` types that live beside their commands.
5. **Is it a `#[tauri::command]`?** → `src/commands/git/<capability>.rs` if it reaches for
   `git_ops`, `src/commands/platform/<adaptee>.rs` if it reaches for `crate::platform`. Start with
   the `src/features/` vocabulary; use the narrower established frontend capability when there is
   no top-level feature for it.
6. **Does it wire the application together** — a plugin, managed state, the handler list, a URI
   scheme, a window event? → `src/lib.rs`, which is the composition root and the only place that
   knows all of the above.

> **"It calls git *and* needs an app-owned service."** A command is allowed to compose them; a crate
> is not. Remote operations are the worked example: `git_ops::push` runs git, `trampoline` answers
> the prompt git makes, and `commands/git/remotes.rs` is the only place those two meet. Direct use of
> both `git_ops` and the OS adapter is instead split at an app-service seam, preserving the checked
> boundary between `commands/git/` and `commands/platform/`.

---

## Directory reference

| Directory | Holds | Explicitly not |
|---|---|---|
| `crates/git-ops/` | Everything that runs `git`, plus the parsers for what it prints | Anything that knows Tauri exists, or a subfolder that breaks the mirror |
| `crates/trampoline/` | The askpass/credential bridge, both ends of it | Policy about *which* account applies — that is the app's, injected through `CredentialProvider` |
| `src/commands/` | Argument translation, error adaptation, and IPC-specific orchestration | Reusable git or OS domain logic that can be expressed below the IPC boundary |
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
| A `commands/git` module | The frontend capability name, plural where that is its established vocabulary | `branches.rs`, `gitignore.rs`, `lfs.rs` |
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
frontend sends. `commands/git/remotes.rs`'s `pull` carries that allow with the reason written next
to it.

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

1. **Every `#[tauri::command]` in `src/commands/**` appears exactly once in `generate_handler!`,
   every entry resolves to one, and command wire names are unique.** An unregistered command
   compiles silently and is dead from the frontend's point of view — the failure mode with the least
   evidence at the crash site.
2. **No module under `commands/platform/` names `git_ops`.**
3. **No module under `commands/git/` names `crate::platform`.**
4. **Neither crate manifest nor any of its Rust targets names `tauri`** — consequence 1 of [the
   rule](#the-rule), which is true today and otherwise had nothing keeping it true.
5. **Neither workspace crate depends on the other.**
6. **Every command returns `Result<_, CommandError>`, including multiline signatures.**
7. **Every platform `*_model.rs` stays free of `#[cfg]`.**

The original five assertions were verified by planting a violation and watching it fail. The review
checks were added from concrete blind spots in those assertions; the complete return-signature check
immediately found and fixed two bare-`bool` commands. A violation is a build failure, not a review
comment.

**What no check can defend**, and so has to be held by whoever writes the code: rule 3 of
[the rule](#the-rule) — the distinction between IPC-specific orchestration and reusable domain
logic. A reusable helper in a command module breaks nothing mechanical. The frontend guideline
records the same limit about single-consumer modules in shared layers, and it is worth repeating
here: *the checker enforces direction, not cohesion.*

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

### Phase 1 — lift `commands/platform/` — **done 2026-08-17**

Move the 13 OS-facing command modules into `src/commands/platform/`. Pure file moves plus the paths
in `lib.rs` and `commands/mod.rs`; no function moves, no command changes address in
`generate_handler!` beyond its module prefix.

### Phase 2 — split `git.rs` by domain — **done 2026-08-17**

**The phase order changed here, and the original would not have compiled.** Lifting `commands/git/`
second, as first planned, meant moving `git.rs` into a folder of the same name. Splitting first and
lifting last costs nothing and avoids the collision entirely — so the split moved to Phase 2 and the
lift to Phase 5.

33 commands across seven domains, plus `branch.rs` and `log.rs` merged in. Item boundaries came from
a brace-matching parse rather than line ranges, so an item moved with its doc comment, attributes and
body or not at all.

### Phase 3 — dissolve `misc.rs` — **done 2026-08-17**

29 commands across ten domains, grouped by nothing but each being small. Four new modules — `tags`,
`gitignore`, `lfs`, `trailers` — and 16 commands appended to existing ones.

**Dissolving it surfaced a duplicate the old grouping had hidden.** `start_misc_operation` /
`finish_misc_mutation` and `branch.rs`'s `start_branch_operation` / `finish_branch_mutation` were
byte-identical apart from their names, and Phase 4 found a third copy in `stash.rs`. Three copies of
"take the repository write lock for a short mutation, then release it", written because the modules
were grouped by axes that put the same job in three places. They are one `start_short_mutation` /
`finish_short_mutation` now.

Two things about that pair are worth knowing and were deliberately not changed in a motion phase: it
labels its work `GitOperationKind::Checkout` whatever the command actually does, and it reports every
failure as `recoverable: true`.

### Phase 4 — split `stash.rs`, rename the rest — **done 2026-08-17**

`stash.rs` held stash, cherry-pick, squash, reorder and submodules, grouped on the stated grounds
that none of them needs a credential session — true of most of the surface, so it grouped nothing.
Cherry-pick, squash and reorder are history rewriting and joined `history`; submodules got their own
module; stash kept its eight and went from 961 lines to 162. `remote.rs` → `remotes.rs` and
`operation.rs` → `operations.rs`.

**The measurement that came out of this phase is the one worth keeping.** The three largest modules
created by the split — branches 688, history 552, changes 539 — have no test blocks of their own;
their shared recovery machinery and most of its tests moved to `operation_lifecycle.rs`. Existing
IPC-orchestration tests also remain in `remotes.rs`, `worktree.rs`, `repositories.rs`,
`operations.rs`, and platform `config.rs`. That is the actual boundary: git and OS domain logic
belongs below commands, while operation locks, recovery, Tauri state and channels are app-owned
orchestration and stay at the IPC layer.

### Phase 5 — lift `commands/git/` — **done 2026-08-17**

Pure motion, done last so no module was named `git` when the folder appeared. 16 modules changed
directory, 4 rewrote one import line.

The boundary was verified before the folder existed rather than asserted after: no git module named
`crate::platform`, and nothing under `commands/platform/` named `git_ops`. Both already held. The
split records a boundary the code had kept without being asked, which is what makes it cheap to
check from here on.

### Phase 6 — turn the checks on — **done 2026-08-17**

`src-tauri/tests/structure.rs`, initially five assertions, each verified by planting a violation.
Review added duplicate-aware command registration plus checks for crate independence, complete
command return signatures, and cfg-free platform models.

**Two of the five needed a more careful violation than the obvious one, and that is the finding.**
Registering a command that does not exist turns out to be a *compile* error — `generate_handler!`
expands to a reference to `tags::__cmd__invent_a_tag` — so rustc owns that direction and the
assertion only states the intent. And the error-contract check does not fire on a return type
changed to `String` in isolation, because the body then fails to compile; it fires on a command
written self-consistently stringly-typed, which is the realistic way the mistake gets made.

A check that passes because the thing it looks for cannot be expressed is indistinguishable from a
check that works. This repo has already been bitten once — `check-bundle-boundary.mjs` went from 163
reachable modules to 2 and kept reporting clean. Plant the violation.
