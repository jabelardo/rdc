# Migration Map: desktop-plus → rdc

Living document. This is the single source of truth for "where did old file X end up" —
keep it more current than `MIGRATION_PLAN.md`. Update the **Status** column as work lands;
don't let this drift.

**Status legend**: `not-started` | `in-progress` | `done` | `skipped` (with a reason)

**Target confidence**: most rows below are directory-level (accurate). Rows marked
**(tentative)** are individual files where the right Rust module wasn't obvious from an
import scan alone — confirm placement when you actually port that file, and update the row
rather than trusting this doc blindly.

---

## 1. Models — `app/src/models/**` → `rdc/src/models/**`

**Ported (Phase 1, tests green):** `account.ts`, `cloning-repository.ts`, `commit-identity.ts`,
`diff/{diff-data,diff-line,diff-selection,image,image-diff,index,raw-diff}.ts`,
`equality-hash.ts`, `formatting-preferences.ts`, `github-repository.ts`,
`manual-conflict-resolution.ts`, `owner.ts`, `remote.ts`, `status.ts` — 17 files, 1:1 paths.

**New file (not a 1:1 port):** `rdc/src/models/secret-scanning.ts` holds `BypassReason` /
`BypassReasonType`, extracted out of `ui/secret-scanning/bypass-push-protection-dialog.tsx`.
When that dialog is ported in Phase 7 it must import from here, and `ISecretScanResult`
(currently also in a dialog file) should move here too.

| Old path | Count | New path | Status |
|---|---|---|---|
| the 17 files listed above | 17 | `rdc/src/models/**` (1:1 filename) | **done** |
| **Step 1 batch** (30 models): `accessible-message`, `author`, `branch-preset`, `branch-sort-order`, `branches-tab`, `clone-options`, `clone-repository-tab`, `commit-message`, `computed-action`, `copy-path-normalization`, `diff-font`, `dot-com-bots`, `fetch`, `git-account`, `git-author`, `last-thank-you`, `menu-ids`, `merge`, `preferences`, `progress`, `publish-settings`, `pull-request`, `release-notes`, `repo-rules`, `show-branch-name-in-repo-list`, `stash-entry`, `submodule`, `tutorial-step`, `uncommitted-changes-strategy`, `workflow-preferences` | 30 | `rdc/src/models/**` (1:1) | **done** |
| supporting `lib/` files pulled in by the Step 1 closure: `lib/fonts/installed-fonts.ts`, `lib/fonts/monospace-font-filter.ts`, `lib/update-branch-strategy.ts` | 3 | `rdc/src/lib/**` (1:1) | **done** |
| `app/src/models/app-menu.ts` | 1 | `src-tauri/src/platform/menu/**` adapter (Tauri `Menu`), **not** `src/models/` | **deferred → Phase 4** — it's an Electron adapter (`menuFromElectronMenu`, `Electron.MenuItem`), not a domain model |
| `app/src/models/repository.ts` | 1 | `rdc/src/models/repository.ts` — also needs its Node `path` import replaced with a local pure-string helper | **blocked (hub #2)** — imports the whole `lib/git` barrel |
| `app/src/models/worktree.ts` | 1 | same treatment | **blocked (hub #2)** |
| `app/src/models/popup.ts` | 1 | `rdc/src/models/popup.ts` | **blocked (hub #2)** — imports UI dialog components |
| remaining `app/src/models/**` | ~43 | `rdc/src/models/**` | not-started (not yet required by any ported test) |

Phase: 1.

### Hub #2 — the blocking dependency knot

Two edges keep ~15 otherwise-simple tests out of Phase 1. Both are real design problems, and
neither is a one-line fix (unlike the three inversions already fixed — see §8):

1. **`models/repository.ts` → `lib/git` (barrel) → `git/core.ts` → `ui/lib/git-perf.ts`.**
   A domain model pulls in the entire git layer (57 files) and, through it, UI. Fix direction:
   models should be leaf types with no git dependency; whatever `repository.ts` needs from git
   should be inverted or moved.
2. **`models/popup.ts` → UI dialog components.** GitHub Desktop types each popup by its
   dialog's props, so the popup *model* imports React components. Fix direction: popup payload
   types should stand alone, with the components consuming them rather than defining them.

A third, smaller one: **`lib/rebase.ts` → `lib/app-state.ts` → `ui/lib/application-theme.ts`**
(`app-state.ts` is a large state-type module that reaches into UI).

### Analysis blind spot: ambient global namespaces

Import-graph analysis cannot see `declare`d globals, so a file can look like a portable leaf and
still fail `tsc`. Full inventory across `models/` + `lib/` (grep, not import analysis):

- **Ambient `Electron.*` (Electron-coupled with no import):** `models/app-menu.ts` (deferred to
  Phase 4), `models/popup.ts` (hub #2), `lib/ipc-shared.ts` (Phase 3), `lib/menu-item.ts` and
  `lib/window-state.ts` (both Phase 4). Nothing outside those five.
- **Bare `JSX.*` (global namespace removed in React 19):** `models/accessible-message.ts`
  (fixed) and `models/banner.ts` (hub #2). Fix is `import type { JSX } from 'react'`.

---

## 2. `lib/` — portable (stays TypeScript) → `rdc/src/lib/**`

Everything under `app/src/lib/**` **except** the backend-bound list in §3. 1:1 path mirroring.
Directory-level breakdown (file counts exclude `*-test.ts`):

| Old dir | Count | Notes | New path | Status |
|---|---|---|---|---|
| `lib/actions-log-parser/` | 4 | pure parser | `rdc/src/lib/actions-log-parser/` | not-started |
| `lib/ci-checks/` | 1 | | `rdc/src/lib/ci-checks/` | not-started |
| `lib/copilot/` | 2 | minus `byok.ts` (§3) | `rdc/src/lib/copilot/` | not-started |
| `lib/databases/` | 6 | Dexie/IndexedDB — works fine in a Tauri webview as-is | `rdc/src/lib/databases/` | not-started |
| `lib/fonts/` | 2 | | `rdc/src/lib/fonts/` | not-started |
| `lib/helpers/` | 8 | minus `linux.ts` (§3 — spawns `xdg-*` helpers) | `rdc/src/lib/helpers/` | not-started |
| `lib/highlighter/` | 2 | becomes a Vite `?worker` import target, see Phase 9 | `rdc/src/lib/highlighter/` | not-started |
| `lib/hooks/` | 7 | minus 4 files in §3 (only 3 stay: check each — likely thin wrappers) | `rdc/src/lib/hooks/` | not-started |
| `lib/logging/` | 6 | minus `get-log-path.ts` (§3) | `rdc/src/lib/logging/` | not-started |
| `lib/markdown-filters/` | 14 | minus `emoji-filter.ts` (§3, but see improvement note) | `rdc/src/lib/markdown-filters/` | not-started |
| `lib/notifications/` | 2 | pure formatting; actual OS notification call is Phase 4 | `rdc/src/lib/notifications/` | not-started |
| `lib/process/` | 1 | `win32.ts` — entirely backend, see §3 | — | n/a, moved to §3 |
| `lib/progress/` | 10 | minus `from-process.ts`, `lfs.ts` (§3) | `rdc/src/lib/progress/` | not-started |
| `lib/shells/` | 6 | **all** backend (external process launch) — see §3 | — | n/a, moved to §3 |
| `lib/squash/` | 1 | | `rdc/src/lib/squash/` | not-started |
| `lib/ssh/` | 4 | process-spawning (ssh-keygen etc.) — see §3/Phase 2 | — | n/a, moved to §3 |
| `lib/stats/` | 3 | telemetry business logic, portable | `rdc/src/lib/stats/` | not-started |
| `lib/trampoline/` | 11 | minus `trampoline-server.ts` (§3/Phase 2) | `rdc/src/lib/trampoline/` | not-started |
| `lib/*.ts` (loose, ~110 files) | ~110 | all files **not** listed in §3 | `rdc/src/lib/*.ts` (1:1) | not-started |

Phase: 1 (loose pure utils, parsers, formatters, models-adjacent helpers), some threaded through
Phase 3 (`app-shell.ts` becomes a thin `invoke` wrapper once its Rust command exists).

**Improvement flags to revisit, not blockers**: `read-emoji.ts` / `markdown-filters/emoji-filter.ts`
and `release-notes.ts` currently read data files (emoji list, `changelog.json`) off disk at
runtime via Node `fs` — in a Tauri app these could instead be bundled as static frontend assets
and read via `fetch`/`import`, avoiding a Rust command entirely. Decide per-file when you get there;
don't assume it needs a Rust command just because the grep flagged a Node import.

---

## 3. `lib/` — backend-bound (→ Rust, or a thin `invoke` wrapper) → `src-tauri/**`

Found by scanning every `app/src/lib/**/*.ts` for imports of `electron` or a Node built-in
(`fs`, `fs/promises`, `child_process`, `os`, `net`, `dns`, `readline`, `dgram`). 52 files.
**Two different outcomes hide in this one list** — don't treat every row the same:

**(a) Whole file's logic moves into a Rust module** (the file's entire purpose is process
spawning / native OS access — there's no "frontend half" to keep):

| Old path | Target (tentative unless noted) | Phase |
|---|---|---|
| `lib/git/core.ts` (the invocation core) | `crates/git-ops/src/exec.rs` + `error.rs` — **done** for spawn/exit-code/stdin/env; error *classification*, trampoline env, hook interception and LFS progress still outstanding | 2 |
| `lib/git/push-terminal-chunk.ts` + `coerce-to-string.ts` | `crates/git-ops/src/terminal_output.rs` — **done** (see the UTF-16 note in §8) | 2 |
| `app/test/helpers/repositories.ts` | `crates/git-ops/src/test_support.rs` — `empty_repository()` + `fixture_repository()` **done**. Note `empty_repository()` pins the branch to `main`, whereas the original defaulted to `master`; a ported test asserting a branch name needs adjusting for that. | 2 |
| dugite's `GitError` enum + `GitErrorRegexes` + `parseError` + `parseBadConfigValueErrorInfo`; `isAuthFailureError` from `core.ts` | `crates/git-ops/src/git_error_kind.rs` — **done, GENERATED from dugite v3.2.2** (60 variants, 62 patterns). Regenerate rather than hand-edit; the generator reads dugite's `build/lib/errors.js` and emits the module. **Pattern order is load-bearing**: `parseError` returns the first match and patterns overlap (the HTTPS auth pattern must precede the generic one, or every HTTPS auth failure is misreported as SSH). | 2 |
| `getDescriptionForError` (`core.ts`, ~140 lines of English) | **deliberately not ported to Rust.** Rust returns the typed `GitErrorKind`; mapping a kind to user-facing copy belongs in the frontend (Phase 7) where it can be localized. Embedding English in the backend would be a regression. | 7 |
| `lib/git/cherry-pick.ts`, `description.ts`, `diff.ts`, `gitignore.ts`, `rebase.ts`, `reorder.ts`, `squash.ts`, `submodule.ts`, `worktree-include.ts`, `worktree.ts` | `crates/git-ops/src/{same-name}.rs` | 2 |
| `lib/progress/from-process.ts`, `lib/progress/lfs.ts` | `crates/git-ops/src/progress/*.rs` | 2 |
| `lib/hooks/get-repo-hooks.ts`, `get-shell-env.ts`, `hooks-proxy.ts`, `with-hooks-env.ts` | `crates/git-ops/src/hooks/*.rs` | 2 |
| `lib/trampoline/trampoline-server.ts` | `crates/trampoline/src/server.rs` | 2 |
| `lib/ssh/*` (4 files, main-process survey listed under lib but confirm — actually verify these live at `lib/ssh/`) | `crates/trampoline/src/ssh/*.rs` | 2 |
| `lib/shells/darwin.ts`, `linux.ts`, `shared.ts`, `win32.ts` | `src-tauri/src/platform/shells/*.rs` | 4 |
| `lib/editors/launch.ts` | `src-tauri/src/platform/editors.rs` | 4 |
| `lib/helpers/linux.ts` | `src-tauri/src/platform/linux_helpers.rs` (xdg-open etc.) | 4 |
| `lib/shell.ts` | `src-tauri/src/commands/shell.rs` (reveal-in-file-manager, open-external) | 4 |
| `lib/exec-file.ts` | `src-tauri/src/platform/exec.rs` (generic subprocess helper other modules call) | 2 |
| `lib/file-system.ts`, `path-exists.ts`, `directory-exists.ts`, `large-files.ts`, `get-file-hash.ts`, `compute-bundle-hash.ts` | `src-tauri/src/platform/fs_utils.rs` | 1/2 |
| `lib/path.ts` **(tentative — verify)** | likely `src-tauri/src/platform/fs_utils.rs`, but confirm it's not pure string manipulation that could stay TS | 1 |
| `lib/process/win32.ts` | `src-tauri/src/platform/win32/process.rs` | 4 |
| `lib/custom-integration.ts` | `src-tauri/src/platform/custom_integration.rs` (pairs with shells/editors config) | 4 |
| `lib/copilot/byok.ts` | `src-tauri/src/commands/copilot_byok.rs` (uses the same `keyring` crate as token storage) | 4 |
| `lib/copilot-conflict-context.ts` **(tentative)** | `src-tauri/src/commands/copilot_conflict_context.rs` | 2 |
| `lib/get-architecture.ts`, `get-os.ts` | `src-tauri/src/platform/system_info.rs` | 4 |
| `lib/get-main-guid.ts`, `get-updater-guid.ts` | `src-tauri/src/platform/install_id.rs` | 4 |
| `lib/find-toast-activator-clsid.ts` | `src-tauri/src/platform/notifications/windows.rs` — superseded by `tauri-plugin-notification`, confirm still needed at all | 4 |
| `lib/main-process-config.ts` | `src-tauri/src/config.rs` | 0/1 |
| `lib/logging/get-log-path.ts` | `src-tauri/src/platform/log_path.rs` | 4/6 |

**(b) File stays TypeScript; only its internal Node/Electron touch-points get swapped for
`invoke`/`@tauri-apps/api` calls** — the surrounding business logic doesn't move:

| Old path | New path | Note | Phase |
|---|---|---|---|
| `lib/ipc-renderer.ts` | *(deleted, not ported)* | superseded entirely by `@tauri-apps/api/core` `invoke`/`listen` | 3 |
| `lib/ipc-shared.ts` | `rdc/MIGRATION_MAP.md` §7 channel table, then generated types via `tauri-specta` | 3 |
| `lib/app-shell.ts` | `rdc/src/lib/app-shell.ts` | thin wrapper, becomes `invoke('reveal_in_file_manager', …)` etc. | 3 |
| `lib/stores/app-store.ts` | `rdc/src/lib/stores/app-store.ts` | **keep this file and its shape** (Phase 7 principle) — only its direct OS-touching calls change to `invoke` | 7 |
| `lib/stores/git-store.ts` | `rdc/src/lib/stores/git-store.ts` | same | 7 |
| `lib/stores/helpers/create-tutorial-repository.ts` | `rdc/src/lib/stores/helpers/create-tutorial-repository.ts` | same | 7 |
| `lib/source-map-support.ts` | *(dropped)* | Node-specific stack-trace remapping for the Electron main process; superseded by Rust panic hook + Sentry (Phase 6) | 6 |
| `lib/release-notes.ts` | `rdc/src/lib/release-notes.ts` **(tentative)** | see improvement flag in §2 — may not need a Rust command at all if changelog data becomes a bundled asset | 1 |

Everything else in `lib/**` not listed above → §2 (portable, stays TS as-is).

---

## 4. `main-process/**` (28 files) → `src-tauri/**`

| Old path | Target | Phase |
|---|---|---|
| `main.ts` | `src-tauri/src/lib.rs` (app entry/lifecycle, single-instance, protocol registration) | 4 |
| `app-window.ts` | `src-tauri/src/lib.rs` + `tauri-plugin-window-state` (replaces `electron-window-state`) | 4 |
| `ipc-main.ts` | *(deleted)* — superseded by `#[tauri::command]` registration | 3 |
| `ipc-webcontents.ts` | *(deleted)* — superseded by `app.emit()` | 3 |
| `trusted-ipc-sender.ts` | *(deleted)* — Tauri's IPC has no equivalent "trusted sender" gap to guard against in the same way; confirm no replacement needed | 3 |
| `crash-window.ts`, `show-uncaught-exception.ts`, `exception-reporting.ts` | Rust panic hook + unified Sentry integration (see Phase 6) | 6 |
| `menu/build-context-menu.ts`, `build-default-menu.ts`, `build-spell-check-menu.ts`, `build-test-menu.ts`, `crash-menu.ts`, `ensure-item-ids.ts`, `get-all-menu-items.ts`, `index.ts`, `menu-event.ts` | `src-tauri/src/platform/menu/*.rs` (Tauri `Menu`/`MenuBuilder`) | 4 |
| `notifications.ts` | `tauri-plugin-notification` (cross-platform, replaces vendored `desktop-notifications`) | 4 |
| `squirrel-updater.ts` | *(deleted)* — replaced by `tauri-plugin-updater` | 4 |
| `shell.ts` | `src-tauri/src/commands/shell.rs` (merge with `lib/shell.ts`, §3) | 4 |
| `migrate-config-dir.ts` | `src-tauri/src/platform/migrate_config_dir.rs` — only needed if rdc inherits an old config dir at all; confirm relevance before porting | 4 |
| `desktop-console-transport.ts`, `desktop-file-transport.ts`, `log.ts` | Rust `tracing` + file appender, replacing Winston | 6 |
| `alive-origin-filter.ts`, `same-origin-filter.ts`, `ordered-webrequest.ts`, `authenticated-image-filter.ts` | **Phase 5 redesign, not a port** — see `MIGRATION_PLAN.md` Phase 5 | 5 |
| `now.ts`, `get-os.ts` | trivial — inline or drop, don't create a module for a one-liner | — |

---

## 5. `ui/**` → `rdc/src/ui/**` (1:1 directory mirror)

All directories below map 1:1 to `rdc/src/ui/<same>/`, same filenames. Not re-listing every
row since the mapping is mechanical; flagging only what's non-mechanical:

- `ui/dispatcher/` (3 files) + `app/src/lib/stores/**` — the seam. Keep the shape (Phase 7).
- `ui/lib/` (104 files) — shared UI helpers/components (list virtualization, filter-list,
  dialog helpers, etc.). This is where `react-virtualized` usage concentrates — audit this
  directory first when starting Phase 7's replacement with `@tanstack/react-virtual`.
- `ui/main-process-proxy.ts`, `ui/install-globals.ts` — these are the renderer-side IPC
  centralization points; become the primary callers of `invoke`/`listen`, everything else in
  `ui/` should keep going through the dispatcher rather than calling `invoke` directly.
- All other top-level dirs (`about/`, `add-repository/`, `app-menu/`, `autocompletion/`,
  `banners/`, `branches/`, `changes/`, `check-runs/`, `clone-repository/`, `copilot/`,
  `create-branch/`, `delete-branch/`, `dialog/`, `diff/`, `discard-changes/`, `history/`,
  `merge-conflicts/`, `multi-commit-operation/`, `notifications/`, `octicons/`,
  `open-pull-request/`, `preferences/`, `repositories-list/`, `repository-settings/`,
  `stashing/`, `toolbar/`, `tutorial/`, `welcome/`, `window/`, `worktrees/`, plus the smaller
  ones — full list in the Phase-0 survey) — straight 1:1 port, component-by-component, per
  Phase 7's sequencing (start once Phase 3's IPC table is drafted, doesn't need Rust finished).

Phase: 7 (all rows).

---

## 6. `app/test/unit/**` → mirrored tests

| Old path | New home | Notes |
|---|---|---|
| `test/unit/git/**` (45 files) | `crates/git-ops/src/**` (`#[cfg(test)]`, inline per Rust convention) | acceptance spec for Phase 2 |
| `test/unit/stores/**` (5 + `updates/`) | `rdc/src/lib/stores/**/*.test.ts` (Vitest, colocated) | Phase 7 |
| `test/unit/main-process/**` (2: menu, spell-checker-menu) | `src-tauri/src/platform/menu/**` (`#[cfg(test)]`) | Phase 4 |
| `test/unit/ui/**` (~30 `.tsx`) | `rdc/src/ui/**/*.test.tsx` (Vitest + Testing Library, colocated) | Phase 7 |
| remaining ~25 top-level `*-test.ts` (lib utils / models) | colocated `*.test.ts` next to the ported file in `rdc/src/lib/**` or `rdc/src/models/**` | Phase 1 |

### Ported in Phase 1 (31 files, 288 tests, all green)

Colocated as `src/**/*.test.ts`, converted from `node:test` per the recipe in
`MIGRATION_PLAN.md` Phase 1. Assertions kept verbatim (still `node:assert`) so these function
as a parity check on the ported logic rather than a rewrite.

`api-error-handling`, `api`, `ci-checks/ci-checks`, `conventional-commits`, `copilot-error`,
`email`, `endpoint-capabilities`, `enum`, `fatal-error`, `find-account`, `format-duration`,
`format-number`, `http`, `local-storage`, `offset-from`, `parse-app-url`, `parse-pac-string`,
`promise`, `promise-with-timeout`, `remote-parsing`, `remove-remote-prefix`,
`repository-matching`, `sanitize-ref-name`, `squirrel-error-parser`, `status-parser`,
`status-utils`, `truncate-with-ellipsis`, `welcome` (in `src/lib/`);
`cloning-repository`, `commit-identity` (in `src/models/`);
`mock-api` (in `src/test-helpers/`).

Test helpers ported to `rdc/src/test-helpers/`: `github-repo-builder.ts`, `mock-api.ts`.

**Deferred deliberately:** `copilot-in-memory-session-fs-provider-test.ts` and its source —
needs `@github/copilot-sdk` for a *type-only* import, and that package pulls `koffi`, a native
FFI binary that doesn't belong in a webview frontend's dependency tree. Revisit if/when the
Copilot feature is actually migrated; the type could also just be declared locally.

Also ported (Step 2): `diff-parser` → `src/lib/diff-parser.test.ts`, alongside
`src/lib/diff-parser.ts` and the new `src/lib/diff-hunks.ts` (see §8).

**Blocked on hub #2** (see §1): `format`, `ipc-contract`, `model-type-guards`,
`multi-commit-operation`, `popup-manager`, `pull-request-refs`, `repository`, `ssh`,
`create-branch`, `name-of`, `text-token-parser`, `wrap-rich-text-commit-message`,
`format-commit-message`, `stats-store`, `app-store-test-harness`. These 15 need git → Rust
(Phase 2/3) and stores (Phase 7); they are **not** blocked by layering nits — see the
`Repository.url` note in `MIGRATION_PLAN.md` Phase 1 Step 4.

---

## 7. IPC channel table (`app/src/lib/ipc-shared.ts`, 77 channels)

Not yet populated — build this table at the start of Phase 3: one row per channel name,
its direction (request/response vs main→renderer push), and its target Tauri
command/event name. Do it as a dedicated pass over `ipc-shared.ts` rather than ad hoc as UI
components get ported, per `MIGRATION_PLAN.md` Phase 3.

| Channel | Direction | Tauri command/event | Status |
|---|---|---|---|
| _(TBD — populate at Phase 3 kickoff)_ | | | |

---

## 8. Deliberate deviations from a verbatim port

Every change made to ported code, so nobody has to diff against `desktop-plus` to find them.

### Layering-inversion fixes (the cause of the 455-file dependency explosion)

All three are zero-runtime-impact and were required to port `lib/` without dragging in the UI
tree, Electron, and `lib/stores`:

| File | Was | Now | Why |
|---|---|---|---|
| `src/lib/api.ts` | `import { BypassReasonType } from '../ui/secret-scanning/bypass-push-protection-dialog'` | `from '../models/secret-scanning'` | The API client imported a React dialog for one type alias. That single edge pulled all 120 `ui/` files into the API client and every test touching it. |
| `src/lib/http.ts` | `import * as appProxy from '../ui/lib/app-proxy'`, `appProxy.getVersion()` | `__APP_VERSION__` | `getVersion()` is literally `return __APP_VERSION__`. The import chain reached `ui/main-process-proxy` → `lib/ipc-renderer` → `electron` to read a build-time constant. |
| `src/lib/format-number.ts` | `import { round } from '../ui/lib/round'` | `from './round'` | `round()` is a dependency-free pure math function that was misfiled under `ui/`. Copied to `src/lib/round.ts`. |
| `src/lib/diff-parser.ts` (Step 2) | `getHunkHeaderExpansionType` from `ui/diff/text-diff-expansion`, `getLargestLineNumber` from `ui/diff/diff-helpers` | both from `./diff-hunks` | Broke a real **import cycle** (`lib/diff-parser` → `ui/diff/text-diff-expansion` → `lib/diff-parser` for `HiddenBidiCharsRegex`) and stopped the pure text-parsing layer from requiring React (`diff-helpers.tsx` imports React). The pure functions — plus `DefaultDiffExpansionStep` — now live in the new `src/lib/diff-hunks.ts`, importing only `models/diff`. **Phase 7 action:** when `ui/diff/text-diff-expansion.ts` and `ui/diff/diff-helpers.tsx` are ported they must import these from `lib/diff-hunks` (not redefine them), keeping the dependency one-way. `HiddenBidiCharsRegex` remains exported from `diff-parser.ts` for them. |

### Other intentional edits

| File | Change | Why |
|---|---|---|
| `src/lib/fatal-error.ts` | `assertNever(x: never, …)` → `assertNever(_x: never, …)` | `x` is an unused type-system device. rdc enables `noUnusedParameters` (desktop-plus did not); underscore-prefixing keeps that lint on rather than weakening the config. |
| `src/lib/api.ts` | GitLab `fetchRefCheckRuns` override: `reloadCache` → `_reloadCache` | Same reason. Note this override genuinely ignores the caller's cache-reload request — latent smell, flagged rather than changed. The two *other* `reloadCache` params are used and untouched. |
| `tsconfig.json` | `esModuleInterop: true`, `useUnknownInCatchVariables: false`, target ES2022 / lib ES2023, `types: ["node"]` | Required for ported code + `import assert from 'node:assert'`; matches desktop-plus's own compiler settings. |
| `src/lib/fonts/installed-fonts.ts` | `import { uniq } from 'lodash'` → `[...new Set(families)]` | Utility policy is native → Radash → Lodash (see `DEVELOPMENT.md`). A single `uniq()` on a `string[]` doesn't justify the dependency; lodash v4 is a 2016 release with v5 unreleased, so its vulnerability-response time is the real risk. If lodash ever *is* required, pin >= 4.18.1. |
| `src/models/accessible-message.ts` | added `import type { JSX } from 'react'` | React 19 removed the global `JSX` namespace the file relied on under React 16. `models/banner.ts` has the same issue and will need the same fix whenever it's unblocked. |
| `crates/git-ops/src/terminal_output.rs` (Phase 2) | caps the rolling terminal buffer on **UTF-8 bytes**, not JavaScript string length (UTF-16 code units) | **Exact parity is unrepresentable in Rust, so this deviation is forced rather than chosen.** The original's tests assert `'日本語ab'` has length 5 and that `'👋'` "counts as 2" — trimming by UTF-16 index can split a surrogate pair, and JavaScript will hold the resulting lone surrogate while Rust's `String` (guaranteed UTF-8) cannot. Bytes are also the honest unit for what is really a memory bound. Trimming rounds *up* to a character boundary, so this version can never emit mangled UTF-8 — an improvement, at the cost of sometimes retaining slightly *fewer* bytes than `capacity`, never more. All 27 original cases are ported; the 3 unicode ones carry comments explaining the difference. |

### Known debt carried over, not fixed during the port

- **`url.parse()` (8 call sites)** — Node emits `DEP0169`: not standardized, "security
  implications", and **CVEs are not issued for `url.parse()` vulnerabilities**. It also won't
  bundle for a webview without a Node `url` polyfill. Migrating to WHATWG `URL` is a real
  behavior change (`url.parse` is lenient, `new URL()` is strict), so it needs its own change
  with the now-ported tests as the guard — not a drive-by edit during a port.
- **Node `path` imports** in `models/cloning-repository.ts` and `lib/repository-matching.ts`
  (only `basename`/`normalize`). Fine under Vitest (runs in Node); needs a browser-safe
  answer before these modules are imported into the app bundle. Don't hand-roll `normalize` —
  its edge cases (`..`, drive letters) are exactly where bugs hide.
- **User-Agent string** still reads `GitHubDesktop/<version>` in `src/lib/http.ts`. Left
  verbatim on purpose: the GitHub API may treat it as significant, so changing it is a
  behavior decision, not cleanup.

---

## 9. Deferred extractions — bind these to the phase that ports the consumer

Phase 1 fixed four layering inversions because they blocked work *then*. These remaining ones
were deliberately **not** done in Phase 1: extracting them early would have produced modules
with zero consumers and zero test coverage, and (measured) would not have unblocked a single
additional test. The point of this table is that the inversion must not be silently re-created
when the consumer is finally ported.

| Symbol(s) | Currently lives in (desktop-plus) | Target home in rdc | Do it during |
|---|---|---|---|
| `RepositorySettingsTab` (enum) | `ui/repository-settings/repository-settings.tsx` | `models/` — popup payloads must not depend on component modules | Phase 7, with `models/popup.ts` |
| `UnreachableCommitsTab` (enum) | `ui/history/unreachable-commits-dialog.tsx` | `models/` | Phase 7, with `models/popup.ts` |
| `ISecretScanResult` (interface) | `ui/secret-scanning/push-protection-error-dialog.tsx` | **`models/secret-scanning.ts`** — the file already exists, created in Phase 1 for `BypassReason`/`BypassReasonType` | Phase 7, with the secret-scanning dialogs |
| `ApplicationTheme` (enum), `ApplicableTheme` (type) | `ui/lib/application-theme.ts` | `models/` — so `lib/app-state.ts` stops importing from `ui/` | Phase 7, with `lib/app-state.ts` |

### Do NOT port: `ui/lib/git-perf.ts`

Its only consumers are `lib/git/spawn.ts` and `lib/git/core.ts` — the dugite subprocess layer,
which **Phase 2 rewrites in Rust** — plus a devtools debug global in `ui/install-globals.ts`. A
ported `lib/git-perf.ts` would have no consumer in rdc, ever.

Instead, Phase 2's `git-ops` crate should do its own timing natively (`tracing` spans, or
`std::time::Instant` around the subprocess call), keeping the `__DEV__ || >1000ms` reporting
threshold from the original if that behavior is still wanted. If a devtools affordance is
desired later, expose it as a dev-only Tauri command rather than a global.

### Blocked on a missing Tauri equivalent, not on layering

`models/popup.ts` also types the untrusted-certificate popup with **`Electron.Certificate`**
(ambient namespace, no import — see the blind-spot note in §1). Porting `popup.ts` therefore
needs a certificate type supplied by the Rust side, which belongs with the Phase 5
security/`webRequest` redesign. Extracting the three enums above is necessary but **not
sufficient** to unblock it.
