# Project structure — the layout, and the rule that keeps it

**Status:** proposed. Answers the questions `CODE_ORGANIZATION_PLAN.md` deliberately left open.
**Applies to:** `src/` (the renderer). `src-tauri/` has its own settled layout and is out of scope.

Two audiences, one document:

- **Refactoring today's code** — [The move](#the-move) maps every current directory to its new home
  and sequences the work.
- **Writing new code** — [Where does this file go?](#where-does-this-file-go) answers it in one
  pass, and [Enforcement](#enforcement) fails the build when it is answered wrong.

If you read one section, read [The rule](#the-rule). Everything else follows from it.

---

## Where this came from

Three sources, and they do not agree. Recording which was followed where, because a later reader
will otherwise assume the disagreements were oversights.

| Source | Followed | Departed, and why |
|---|---|---|
| [bulletproof-react](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) | The whole architecture: `app / components / features / hooks / lib / utils`, feature folders owning their own slice, and above all the unidirectional rule and its enforcement | Its enforcement uses ESLint's `import/no-restricted-paths`. **oxlint does not implement that rule** (checked against its schema: it has `import/no-cycle` and `import/no-relative-parent-imports`, and neither expresses a zone). rdc gets a check script instead — see [Enforcement](#enforcement) |
| `../agents/skills/tauri-setup/rules/` | The Tauri shape: a real `platform/` boundary, typed `invoke` wrappers as the data-access layer, event-listener cleanup as a lifecycle concern | **Naming**: the skill says `PascalCase.tsx` and folder-per-component with an `index.ts`. rdc is uniformly kebab-case and so is shadcn's CLI output — renaming ~200 files to adopt a convention that fights the vendored tree is cost without benefit. **Barrels**: the skill recommends them, bulletproof-react forbids them; rdc forbids them, for a reason specific to this repo ([below](#no-barrel-files)) |
| rdc as it stands | Everything already grouped — `stores/`, `platform/`, `menu/`, `logging/`, `resilience/` — keeps its grouping, just moves | The flat drawer does not survive: 72 non-test modules sit directly in `src/lib/` mixing pure helpers, IPC wrappers, domain logic and dead GitHub-service code |

**The one thing all three agree on**, and the reason this document is short: organize by feature,
not by file type, and let the dependency direction be the thing you enforce.

---

## The rule

> **Dependencies point one way: shared → features → app.**

Three consequences, and they are the whole guideline:

1. **A feature may not import another feature.** Not `../branches/`, not deeply, not for one type.
2. **Shared code may not import a feature, or the app.** `utils/`, `models/`, `lib/`, `platform/`,
   `components/` and `hooks/` know nothing about what is built on them.
3. **The app layer composes.** It is the only place that may reach into features, and the only place
   two features meet.

### When two features need the same thing

This is the case the rule seems to forbid and does not. **Anything more than one feature needs is
shared by definition — promote it, do not import sideways.** A thing used by branches and remotes
belongs in `lib/`, `components/` or `models/`, and the act of promoting it forces the question of
what it actually is.

The tie-break, for when promotion feels wrong: *if promoting it would move most of a feature, the
feature boundary is wrong.* Fix the boundary rather than the import.

rdc's worked example is **operations**. Every feature starts one — fetch, commit, merge, checkout —
so "operations" looks like a feature and must not be one, or nine features would import it. It is a
shared capability: the registry client in `lib/operations/`, the shared progress body in
`components/operations/`. Nothing imports sideways to reach it.

---

## The shape

```
src/
├── main.tsx                  # entry point; mounts app/
├── app/                      # composition root — the only layer that may import features
│   ├── app-shell.tsx
│   ├── app-dialogs.tsx
│   ├── providers.tsx
│   └── use-app-controller.ts
├── components/               # shared components, used by two or more features
│   ├── ui/                   # VENDORED shadcn — CLI-owned, do not hand-edit
│   └── operations/           # authored shared components, grouped by what they are
├── features/                 # one folder per domain slice; see anatomy below
│   ├── branches/
│   ├── changes/
│   ├── conflicts/
│   ├── diff/
│   ├── history/
│   ├── messages/
│   ├── preferences/
│   ├── remotes/
│   └── repositories/
├── hooks/                    # shared hooks, used by two or more features
├── lib/                      # cross-cutting infrastructure and configured libraries
│   ├── ipc/                  # the invoke/Channel/event plumbing itself
│   ├── logging/
│   ├── menu/
│   ├── operations/
│   └── resilience/
├── models/                   # the wire contract with Rust — types serde also knows
├── platform/                 # the Tauri/OS adapter boundary
├── testing/                  # test helpers, fixtures, and the debug state injectors
├── utils/                    # pure, dependency-free helpers
└── styles/                   # global CSS and tokens
```

### Feature anatomy

A feature owns its whole vertical slice. **Create only the parts you need** — an empty `hooks/`
folder is noise, and a feature with one file needs no subfolders at all.

```
src/features/branches/
├── api/                # typed invoke wrappers and event subscriptions for this feature
├── components/         # UI belonging to this feature, dialogs included
├── hooks/              # feature-scoped hooks
├── stores/             # feature state
├── types/              # types the renderer alone knows about
└── <domain>.ts         # pure feature logic: validate-branch-name.ts, delete-branch-refusal.ts
```

Two things that are *not* in the list, on purpose:

- **No `index.ts`.** See [below](#no-barrel-files).
- **No `assets/`** until something needs one. rdc has a single SVG.

---

## Where does this file go?

Answer in order; the first match wins.

1. **Does Rust also know this type?** → `src/models/`. If it crosses the IPC boundary, its shape is
   a contract, not a preference, and the wire snapshot pins it. Renderer-only types live with their
   feature.
2. **Is it vendored?** → `src/components/ui/`, untouched. Whatever the shadcn CLI writes stays where
   the CLI writes it, or `shadcn add` stops producing a reviewable diff.
3. **Does it talk to the OS through Tauri** — windows, native menus, the filesystem, notifications,
   keybindings, the shell? → `src/platform/`.
4. **Is it pure — no imports, no I/O, no React?** → `src/utils/`.
5. **Does exactly one feature use it?** → that feature. This is the common case and the default;
   prefer it whenever you are unsure, because moving one file up later is trivial and untangling a
   premature shared module is not.
6. **Do two or more features use it?** → promote by kind: a component to `src/components/`, a hook
   to `src/hooks/`, infrastructure to `src/lib/`.
7. **Does it exist to wire features together?** → `src/app/`.

> **"I'm not sure whether it's shared yet."** Put it in the feature. Sharing is discovered, not
> predicted, and the second caller is what proves it — at which point the move is one commit.

---

## Directory reference

| Directory | Holds | Explicitly not |
|---|---|---|
| `app/` | The shell, the provider stack, the dialog host, the top-level controller. The composition root | Domain logic. If it can be stated without naming two features, it belongs in one of them |
| `components/ui/` | Vendored shadcn primitives | Anything authored. A hand-edit here is invisible until the next `shadcn add` overwrites it |
| `components/` | Authored components two or more features use | A component with one caller — that is feature-local until proven otherwise |
| `features/*/` | A domain slice, whole: state, IPC, components, logic | Imports of another feature |
| `hooks/` | Shared React hooks | Hooks with one caller |
| `lib/` | Cross-cutting infrastructure: the IPC plumbing, logging, resilience, the menu system, the operation registry client | A drawer. Every direct child of `lib/` is a named subsystem folder, never a loose helper |
| `models/` | Types that cross the Rust boundary, plus the generated wire snapshot | Renderer-only types |
| `platform/` | The Tauri/OS adapter surface | Git domain logic. "It calls `invoke`" is not the test — *what it invokes* is |
| `testing/` | Test helpers, builders, mock IPC, and the debug state injectors that back Help → Show Dialog | Production code paths |
| `utils/` | Pure functions: `clamp`, `compare`, `round`, `format-*`, `truncate-with-ellipsis` | Anything importing React, Tauri, or a model |
| `styles/` | Global CSS, tokens, resets | Component styles — those are Tailwind classes at the point of use |

---

## Tauri-specific adaptations

bulletproof-react describes a web app talking to an HTTP API. Four places where that maps onto
something different here, and getting them wrong is what makes a Tauri codebase drift.

### `api/` means IPC, and it is still the data-access layer

A feature's `api/` folder holds typed `invoke` wrappers and event subscriptions instead of HTTP
calls. The slot is the same and the discipline is the same: **components never call `invoke`
directly.** They call a wrapper, which owns the command name, the argument shape and the return
type. One place to change when the Rust signature changes, and one place a test can substitute.

```
features/remotes/api/
├── fetch.ts        # invoke("fetch_workflow", …) and its Channel wiring
└── push.ts
```

The generic plumbing — creating Channels, subscribing to operation events, error translation — is
`lib/ipc/`, not per feature.

### `models/` is a contract, not a convenience

In a web app, types are feature-local and duplicating one costs little. Here, a renderer type that
crosses IPC has a serde counterpart in Rust, and the pair is pinned by
`src/lib/__generated__/wire-snapshot.json`. Scattering those types into features hides the contract
surface and makes drift a thing you find at runtime.

**So the split is by who knows the type, not by who uses it.** Rust knows it → `models/`. Only the
renderer knows it → the feature. This is the one place rdc keeps a type-first directory on purpose.

### `platform/` is a real boundary and deserves a top level

A web app has no equivalent: the browser *is* the platform. Here, native menus, window management,
the trash, notifications, keybindings and shell integration are a substitutable layer with
per-OS behaviour and per-OS bugs — including the ones this project has already been bitten by
(WebKitGTK compositing, muda's blocking popup on Wayland). Burying that in `lib/` understates it.

The test for membership is **what it invokes, not that it invokes**: `platform/window.ts` is
platform, `features/branches/api/rename.ts` is not, though both call `invoke`.

### Dependency injection is how features stay testable — and it defeats reachability analysis

rdc's stores take their IPC functions as injected dependencies with real defaults. Keep that: it is
what lets a store test run without Tauri. But know the cost, because this project has already paid
it once — **a module reached only through an injected default looks unimported.** `fetch_workflow`
was reported as dead on exactly that basis and is in fact the transport behind the Fetch button.

Before deleting anything on the strength of a reachability measurement, grep for the bare symbol.

---

## Conventions

### Naming

| Kind | Convention | Example |
|---|---|---|
| Every file and folder | `kebab-case` | `rename-branch-dialog.tsx`, `working-tree-store.ts` |
| Components | Named export, PascalCase identifier, kebab-case file | `export function RenameBranchDialog` in `rename-branch-dialog.tsx` |
| Hooks | `use-` prefix | `use-app-controller.ts` |
| Tests | Beside the source | `validate-branch-name.test.ts` |

Deliberately unlike the `tauri-setup` skill, which specifies `PascalCase.tsx` and a folder per
component. rdc is already uniformly kebab-case, shadcn's CLI writes kebab-case, and one convention
consistently applied beats a better one applied to two thirds of the tree.

### No barrel files

**Do not add `index.ts` re-export files.** bulletproof-react forbids them for tree-shaking; rdc has a
sharper reason: `scripts/check-bundle-boundary.mjs` proves no Node builtin reaches the webview by
walking the real import graph, and a barrel makes every consumer of one symbol look like a consumer
of all of them. The check that keeps `url.parse()` out of the bundle gets less precise with every
barrel added.

Two exist today — `src/lib/stores/index.ts` and `src/models/diff/index.ts` — and both are removed by
the refactor.

### Imports

**A relative import may not escape its own top-level directory** — `src/features/<name>/` for a
feature, `src/<name>/` for everything else. Anything further uses `@/`. (This is option A′ of the
open decision below; if A or B is chosen instead, this section is the only one that changes.)

```ts
// inside features/branches/components/rename-branch-dialog.tsx
import { validateBranchName } from "../validate-branch-name";   // same feature: relative
import { Button } from "@/components/ui/button";                 // crossing a boundary: alias
import type { Branch } from "@/models/branch";
```

This makes a boundary crossing *visible in the import line*, which is the point — `../../../../lib/`
tells a reader nothing about which layer they just left. It also means a violation can be caught by
reading the diff, before the checker runs.

**This reverses a recorded decision.** `tsconfig.json` currently scopes `@/` to `src/components/ui/**`
with the note "not a general-purpose alias to adopt elsewhere", because at the time it existed only
to keep vendored shadcn files diffable. Widening it is deliberate and this paragraph is the record.

### Styles

Tailwind utilities at the point of use. `src/styles/` holds global CSS, tokens and resets only.
No CSS modules — the `tauri-setup` skill assumes them, rdc uses Tailwind, and mixing the two gives
two places to look for one rule.

---

## Enforcement

A convention no check defends decays. This repository has watched it happen twice — two token
vocabularies, and the lucide/FontAwesome split that was the rule for about an hour.

oxlint cannot express the zone rule, so the boundary check is a script, modelled on
`scripts/check-bundle-boundary.mjs` (same TypeScript-AST traversal, same "fails the build" contract):

**`scripts/check-module-boundaries.mjs`** asserts:

1. No import from `features/<a>/` into `features/<b>/`.
2. No import from `app/` into anything under `features/` or the shared layers.
3. No import from `features/` into `app/`.
4. No import from `components/ui/` into `features/` or `app/` — vendored code stays vendored.
5. No re-export-only `index.ts` outside `components/ui/`.

Add `import/no-cycle` to `.oxlintrc.json`, which oxlint *does* implement, and which catches the
class of tangle that survives every path rule.

Both run in the existing gate set. A violation is a build failure, not a review comment.

---

## The move

One mechanical commit per phase, **no behaviour change in any of them**, full gate set between each.
The diff must be reviewable as pure motion — if a phase contains a logic change, split it out first.

Splitting a reorganization across feature work is how it ends up half-applied, which is the state
being fixed.

### Phase 0 — decide the dead third, before moving it

`CODE_ORGANIZATION_PLAN.md` measured 30 genuinely unreferenced modules directly under `src/lib/`.
Moving dead code is wasted motion and makes the diff harder to read, so settle it first.

| Group | Examples | Disposition |
|---|---|---|
| GitHub-service and Electron-era | `api.ts`, `http.ts`, `find-account.ts`, `parse-app-url.ts`, `squirrel-error-parser.ts` | **Delete — decided 2026-08-16.** Recoverable from git; a post-MVP GitHub feature will want a fresh design against Tauri anyway, not a port of Electron's client. Deleting these also removes the two `.oxlintrc.json` overrides that exist only for `api.ts` and `http.ts` |
| Ported ahead of a planned feature | `create-branch.ts`, `rebase.ts`, `refs.ts`, `multi-commit-operation.ts`, `conventional-commits.ts` | **Move to the feature that will use it**, where being unused is legible. A file in `features/branches/` with no caller is a to-do; the same file in a flat drawer is litter |
| Utilities with no caller | `clamp.ts`, `offset-from.ts`, `promise.ts` | **Delete** unless a named, scheduled consumer exists |

Re-measure first, and **grep each candidate for its bare symbol before deleting** — see the
dependency-injection note above for why the measurement alone is not sufficient evidence.

### Phase 1 — lift the layers that already exist

Pure renames, no file splitting.

| From | To |
|---|---|
| `src/lib/platform/` | `src/platform/` |
| `src/lib/logging/`, `src/lib/resilience/`, `src/lib/menu/` | `src/lib/` (unchanged — already correct) |
| `src/lib/debug/`, `src/test-helpers/` | `src/testing/` |
| `src/App.css` | `src/styles/` |
| `src/lib/ui/theme-provider.tsx`, `tooltip.tsx`, `virtual-list.tsx`, `external-link.tsx`, `horizontal-resizer.tsx`, `terminal-output.tsx` | `src/components/` |
| `src/lib/ui/list-navigation.ts`, `sidebar-sections.ts` | `src/hooks/` or `src/utils/` by the decision tree |

### Phase 2 — create the features and move the vertical slices

For each feature: its store, its IPC wrapper, its components and dialogs, its domain logic.

| Feature | Store | IPC | Representative components and logic |
|---|---|---|---|
| `branches` | `branch-store` | `branch-ipc` | `branch-picker`, `rename-branch-dialog`, `merge-branch-dialog`, `rebase-branch-dialog`, `validate-branch-name`, `delete-branch-refusal`, `sanitize-ref-name` |
| `changes` | `working-tree-store` | — | `changes-workspace`, `discard-file-list`, `discard-changes`, `wrap-rich-text-commit-message` |
| `history` | `history-store` | `rev-list-ipc` | `history-workspace`, `history-operation-selection` |
| `diff` | — | `diff-ipc` | `diff-hunks`, `models/diff` consumers |
| `remotes` | `remote-store`, `clone-store` | `remote-ipc` | `manage-remotes-dialog`, `clone-repository-dialog`, `remote-enablement`, `remote-parsing`, `trusted-remote-host` |
| `conflicts` | `conflict-store` | — | `merge-conflicts` |
| `repositories` | `repositories-store` | `misc-ipc` | `repository-sidebar`, `repository-availability` |
| `preferences` | `preferences-store` | — | `preferences-dialog`, `custom-integration` |
| `messages` | `message-store` | — | `message-toasts`, `format-error` |

Shared, and deliberately not features: `operation-store` / `operation-ipc` / `operation-presentation`
→ `lib/operations/`; `operation-progress-dialog` and its shared body → `components/operations/`;
`confirm-dialog`, `notice-dialog`, `dialog-failure`, `dialog-message`, `dialog-actions` →
`components/dialogs/`, since they are the shape every feature's dialogs are built from.

### Phase 3 — the app layer, and the controller

`app-shell.tsx`, `app-dialogs.tsx` and `use-app-controller.ts` move to `src/app/`.

Expect this phase to surface that **`use-app-controller.ts` is doing several features' work in one
file.** Splitting it into per-feature hooks composed at the app layer is the natural follow-on and
is *not* part of the mechanical move — it is a behaviour-preserving refactor with its own risk, and
it needs its own commit and its own review.

### Phase 4 — widen the alias, then turn the checker on

Rewrite cross-boundary imports to `@/`, widen the `tsconfig.json` scope, add
`scripts/check-module-boundaries.mjs` and `import/no-cycle`, and wire both into the gate set.

The checker goes last on purpose: turning it on before the moves are done produces a wall of
violations that says nothing, and turning it on after means the very next commit cannot regress.

---

## Open decisions

One. Import style — see [Imports](#imports), where the recommended option is written up as if
settled; if the other is chosen, that section changes and nothing else does.

**Decided 2026-08-16: the GitHub-service cluster is deleted, not quarantined.** ~16 modules, most
with tests, none reachable. Recoverable from git history if a post-MVP GitHub feature wants them,
and a Tauri GitHub client will not want Electron's HTTP layer regardless.

### Import style — three options, measured

Facts first, because two of them were assumptions worth checking:

- **`@/` already resolves from anywhere.** `tsconfig.json` maps `@/*` → `./src/*` globally and Vite
  aliases `@` → `src` globally. Verified by compiling an `@/lib/clamp` import from inside
  `src/lib/` — clean. The "scoped to `src/components/ui/**`" note is a *convention*, enforced by
  nothing. Widening it costs no configuration.
- **oxlint can enforce "no parent imports".** `import/no-relative-parent-imports` is implemented and
  works — verified against `remote-store.ts` (flags all 9 `../` imports) and
  `manage-remotes-dialog.tsx` (flags the 4 `../`, ignores the bare `lucide-react` import). It does
  not distinguish a parent import that stays inside your slice from one that leaves it.
- **Scale:** 431 upward (`../`) imports in non-test modules — 277 one level, 205 two, 82 three.

| | A. Alias above the current directory | B. Relative everywhere | **A′. Alias when leaving your directory** |
|---|---|---|---|
| Rewrite cost | All 431 upward imports | None | The subset that crosses a top-level boundary |
| Enforced by | Stock `import/no-relative-parent-imports` | The checker, which exists anyway | The checker, one extra rule |
| A cross-boundary import is | Visible | Invisible — count the `../` and guess | Visible |
| Renaming a feature | Rewrites its internal imports too | Free | Free |
| Rules to learn | One | One | Two |

**A′ is recommended**, and the tiebreak is not aesthetics: *it makes the architecture legible in
ordinary code*. Under A′ an `@/` in an import line means exactly one thing — this line leaves my
slice — which is the concept the whole structure is built on, taught to a reader on every file they
open. Under A the alias is everywhere and signals nothing; under B nothing signals anything.

The apparent advantage of A, that stock lint enforces it, is worth less than it looks: the boundary
checker has to exist for the cross-feature rule regardless, and it already resolves every import to
a path. "Did this `../` escape your top-level directory" is a comparison it can make in one line.

The precise rule under A′, stated so the checker can assert it verbatim:

> A relative import may not escape its own top-level directory — `src/features/<name>/` for a
> feature, `src/<name>/` for everything else. Anything further uses `@/`.
