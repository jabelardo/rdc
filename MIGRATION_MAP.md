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
| `app/src/models/app-menu.ts` | 1 | `rdc/src/models/app-menu.ts` after all — see the revision below | **done in Phase 4a** — the Electron adapter is gone; the immutable menu interaction model now consumes the frontend-owned tree directly |
| `app/src/models/commit.ts`, `models/branch.ts`, `models/tip.ts` + `lib/create-branch.ts` | 4 | `rdc/src/**` (1:1) | **done** — unblocked by the trailer extraction |
| `app/src/lib/pull-request-refs.ts` | 1 | `rdc/src/lib/pull-request-refs.ts` | **done** — unblocked by the issue-reference extraction |
| **New file:** `rdc/src/lib/markdown-filters/issue-reference.ts` | 1 | holds the issue-reference regex constants, extracted out of `lib/markdown-filters/issue-mention-filter.ts` | **done** |
| **New file:** `rdc/src/models/trailer.ts` | 1 | holds `ITrailer` + `isCoAuthoredByTrailer`, extracted out of `lib/git/interpret-trailers.ts` | **done** |
| `app/src/models/repository.ts` | 1 | `rdc/src/models/repository.ts` — **redesigned, not ported verbatim** (see §8) | **done** |
| `app/src/models/worktree.ts`, `models/editor-override.ts` | 2 | `rdc/src/models/**` (1:1) | **done** |
| **New file:** `rdc/src/models/custom-integration.ts` | 1 | holds `ICustomIntegration`, extracted out of `lib/custom-integration.ts` | **done** |
| **New file:** `rdc/src/lib/path-utils.ts` | 1 | `basename`, replacing Node `path` in `models/{repository,worktree,cloning-repository}.ts` | **done** |
| `app/src/lib/text-token-parser.ts`, `lib/wrap-rich-text-commit-message.ts`, `lib/emoji.ts` | 3 | `rdc/src/lib/**` (1:1) | **done** |
| `app/src/models/popup.ts` | 1 | `rdc/src/models/popup.ts` | **blocked (hub #2)** — imports UI dialog components |
| remaining `app/src/models/**` | ~43 | `rdc/src/models/**` | not-started (not yet required by any ported test) |

Phase: 1.

### Revision: `models/app-menu.ts` goes to `src/models/` after all

Phase 1 deferred it as an Electron adapter, which it is: `menuFromElectronMenu` converts an
`Electron.MenuItem` tree into the renderable `MenuItem` union that `ui/app-menu/**` draws. Phase 4a's
menu decision (see `MIGRATION_PLAN.md`) removes the Electron menu it was adapting *from* — the menu
definition becomes a TypeScript module and the frontend renders it directly, while Rust builds only
macOS's native menu from the same shape. What is left after `menuFromElectronMenu` is deleted is the
menu model proper, so the file lands at `rdc/src/models/app-menu.ts` and `src-tauri/src/platform/menu.rs`
consumes the shape rather than producing it. `src/models/menu-ids.ts` (Phase 1, done) is the key both
sides share.

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

Phase: 1 (loose pure utils, parsers, formatters, models-adjacent helpers), with native app-shell
integrations threaded through Phase 4 (`app-shell.ts` becomes a thin `invoke` wrapper once those Rust
commands exist).

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
| `lib/git/core.ts` (the invocation core) | `crates/git-ops/src/exec.rs` + `error.rs` — **done** for spawn/exit-code/stdin/env/error classification, bidirectional streaming, and the `GIT_LFS_PROGRESS` side channel. Hook interception and its command adapters subsequently landed. | 2 / 3 |
| `lib/git/push-terminal-chunk.ts` + `coerce-to-string.ts` | `crates/git-ops/src/terminal_output.rs` — **done** (see the UTF-16 note in §8) | 2 |
| `app/test/helpers/repositories.ts` | `crates/git-ops/src/test_support.rs` — `empty_repository()` + `fixture_repository()` **done**. Note `empty_repository()` pins the branch to `main`, whereas the original defaulted to `master`; a ported test asserting a branch name needs adjusting for that. | 2 |
| dugite's `GitError` enum + `GitErrorRegexes` + `parseError` + `parseBadConfigValueErrorInfo`; `isAuthFailureError` from `core.ts` | `crates/git-ops/src/git_error_kind.rs` — **done, GENERATED from dugite v3.2.2** (60 variants, 62 patterns). Regenerate rather than hand-edit; the generator reads dugite's `build/lib/errors.js` and emits the module. **Pattern order is load-bearing**: `parseError` returns the first match and patterns overlap (the HTTPS auth pattern must precede the generic one, or every HTTPS auth failure is misreported as SSH). | 2 |
| `getDescriptionForError` (`core.ts`, ~140 lines of English) | **deliberately not ported to Rust.** Rust returns the typed `GitErrorKind`; mapping a kind to user-facing copy belongs in the frontend (Phase 7) where it can be localized. Embedding English in the backend would be a regression. | 7 |
| `app/src/lib/app-state.ts` (1,319 lines, 49 imports) | **not ported — being decomposed** into `rdc/src/lib/app-state/` one concern at a time, as consumers need it. Extracted so far: `IBranchesState` (`branches-state.ts`), `MultiCommitOperationConflictState` (`conflict-state.ts`), `IConstrainedValue` (`constrained-value.ts`). When the module is ported with the stores in Phase 7 it must **re-export from these** rather than redeclare them. See `src/lib/app-state/README.md`. | 2 / 7 |
| `app/src/lib/{clamp,rebase,multi-commit-operation}.ts`, `models/multi-commit-operation.ts` | `rdc/src/**` (1:1) — **done**, unblocked by the app-state decomposition | 2 |
| `lib/git/interpret-trailers.ts` | **split**: git-invoking half → `crates/git-ops/src/interpret_trailers.rs` (**done**); the `ITrailer` type + `isCoAuthoredByTrailer` predicate → `rdc/src/models/trailer.ts` (**done**), because neither needs git. See §8. | 2 |
| `lib/git/init.ts` | `crates/git-ops/src/init.rs` — **done**. `init_repository(path, default_branch)` takes the branch as a **parameter**; see §8 for why the original's internal `getDefaultBranch()` call was not reproduced. | 2 |
| `lib/git/add.ts` | `crates/git-ops/src/add.rs` — **done**. Takes plain paths rather than the `Repository`/`WorkingDirectoryFileChange` models, which are frontend concerns. | 2 |
| `lib/git/config.ts` | `crates/git-ops/src/config.rs` — **partially done**: repository get/set/remove + boolean, a `GlobalConfig` type for the global scope, and `addSafeDirectory`/`addGlobalConfigValueIfMissing` (**contains an upstream bug fix — see §8**). Deferred: `getGlobalConfigPath` (needs the `git config --edit` + `GIT_EDITOR=printf` trick; a Phase 4 editor concern) and `getConfigValueWithOrigin` + `formatConfigScope`/`formatConfigPath`/`isConditionalInclude`/`getOriginFilePath` (display strings like `"global, via [includeIf]"` → frontend, same reasoning as `getDescriptionForError`). | 2 / 4 |
| `lib/git/rev-parse.ts` | `crates/git-ops/src/rev_parse.rs` — **done**: `RepositoryType` (`Regular`/`Bare`/`Missing`/`Unsafe`), `get_repository_type`, and the upstream-ref helpers. | 2 |
| `lib/git/rev-list.ts` | `crates/git-ops/src/rev_list.rs` — commit lists in replay order and `getAheadBehind`. Split deliberately: the **range builders** (`revRange`, `revRangeInclusive`, `revSymmetricDifference`) are string concatenation, so they are `src/lib/rev-range.ts`; `getBranchAheadBehind` is `src/lib/rev-list-ipc.ts`, because every branch-specific decision in it is one the frontend can make from data it holds; and `doMergeCommitsExistAfterCommit` has no consumer outside `ui/history/**`. | 3 / 7 |
| `lib/helpers/default-branch.ts` (`getDefaultBranch`/`setDefaultBranch`) | **now unblocked** by `config.rs`'s `GlobalConfig`, but still outstanding: the `"main"` fallback is app policy that belongs above the git layer. It lands with its preference/tutorial consumers rather than expanding Phase 3 with an unused command. | 7 |
| `lib/status-parser.ts` + the status types from `models/status.ts` | `crates/git-ops/src/status_parser.rs` — **done**. **Supersedes the Phase 1 TypeScript port**: `src/lib/status-parser.ts` and its test are deleted, as is `src/lib/split-buffer.ts` (its only consumer was that parser, and it is Node `Buffer`-based so unusable in a webview). Decision recorded in `MIGRATION_PLAN.md` Phase 2: since `lib/git/status.ts` becomes a Rust command, parsing had to move with it, or Rust would ship raw porcelain over IPC for the frontend to interpret. | 2 |
| `lib/trampoline/**` (11 files) + the vendored `desktop-trampoline` C binary | `src-tauri/crates/trampoline/` — **done**: transport, sidecar, credential protocol, session state, and askpass/credential handlers. Account storage and interactive UI decisions stay behind traits for Phase 7. One Rust crate replaces both the C binary and the TypeScript half. | 2 |
| `lib/ssh/ssh.ts` (`parseAddSSHHostPrompt` only) | `rdc/src/lib/ssh/ssh-host-prompt.ts` — **done**. `getSSHEnvironment` stays with the trampoline/shell work; it produces `SSH_ASKPASS`/`GIT_SSH_COMMAND` pointing at the trampoline binary. | 2 / 4 |
| `lib/git/status.ts` | `crates/git-ops/src/status.rs` — **done**: `get_status`, `StatusResult`, `AppFileStatus`, `ConflictedFileStatus`, header parsing and conflict-detail gathering. Returns git facts only; `WorkingDirectoryFileChange`/`DiffSelection`/`WorkingDirectoryStatus` stay frontend (see §8). | 2 |
| `lib/git/merge.ts` (`isMergeHeadSet`, `isSquashMsgSet`), `lib/git/cherry-pick.ts` (`isCherryPickHeadFound`), `lib/git/rebase.ts` (`isRebaseHeadSet`, `getRebaseInternalState`) + `models/rebase.ts` (`RebaseInternalState`) | `crates/git-ops/src/operation_state.rs` — **done**. Collected into one module because these are the marker-file checks `status` needs and nothing else from those (154/499/627-line) files; the rest lands with each module's own port. | 2 |
| `lib/git/diff-check.ts` | `crates/git-ops/src/diff_check.rs` — **done**. | 2 |
| `lib/git/diff.ts` | `crates/git-ops/src/diff.rs` — text and image production **done**: working-directory, commit, range, conflict-resolution, size guards, submodules, binary detection, and scoped `rdc-blob` URLs. `getFilesDiffText` and rendering land with Phase 7 consumers. **Contains an upstream bug fix — see §8.** | 2 / 3 / 7 |
| `lib/git/git-delimiter-parser.ts` (`createLogParser`) | `crates/git-ops/src/git_delimiter_parser.rs::LogParser` — **done** (needed by `getBinaryPaths`'s `check-attr` parsing). | 2 |
| `lib/git/branch.ts` | `crates/git-ops/src/branch.rs` — **done**: `create_branch`, `get_branch_names`, `rename_branch` (incl. the case-only-rename retry), `delete_local_branch`, `delete_remote_branch`, `get_branches_pointed_at`, `get_merged_branches`. Remote deletion propagates authentication failures rather than classifying them, which is the original's explicit choice, and cleans up a stale tracking ref when the remote branch is already gone. Proxy support is absent here as everywhere — see `environment.ts`. | 2 |
| `lib/git/for-each-ref.ts` | `crates/git-ops/src/for_each_ref.rs` — **done**: `get_branches` and `get_branches_differing_from_upstream`. This is the branch *list*; `branch.rs` is the branch *operations*. Hydrated into the `Branch` class by `src/lib/branch-ipc.ts`. Two deliberate improvements — epoch seconds instead of a `new Date()` parse of git's `iso8601`, and a canonicalized worktree-path comparison — see §8. | 2 |
| `lib/git/environment.ts` | **partially ported, and the one `lib/git` file without a full counterpart.** `envForAuthentication` is `crates/git-ops/src/authentication.rs`; `getFallbackUrlForProxyResolve` and `envForProxy` are **not** ported, because `envForProxy` resolves through Electron's `session.resolveProxy`. There is no Tauri equivalent — it needs reading the OS proxy configuration natively. **Owned by Phase 5**, with `resolve-proxy`, `getFallbackUrlForProxyResolve` and `lib/parse-pac-string.ts`: `session.resolveProxy` is the same Electron `session` object as `webRequest`, so this is session-level redesign work rather than the platform swap it was first filed as. Consequence, unchanged and now with a named owner: **no remote operation has proxy support today.** | 5 |
| `lib/git/git-delimiter-parser.ts` | `crates/git-ops/src/git_delimiter_parser.rs` — **done**, including the `%x00` log parser. | 2 |
| `lib/git/refs.ts` | `crates/git-ops/src/refs.rs` — **done** (`format_as_local_ref`, `get_symbolic_ref`). | 2 |
| `lib/git/update-ref.ts` (`deleteRef`) | `crates/git-ops/src/update_ref.rs` — **done**. `updateRef` has no consumer anywhere in upstream and is deliberately dropped rather than carried as dead API. | 2 |
| `lib/git/merge.ts` | `crates/git-ops/src/merge.rs` — **done**: merge (including squash/no-verify), merge-base lookup, conflict result, noop result, abort, and hook progress. Upstream exposes an optional terminal callback but no production caller supplies one, so no speculative Channel is added. | 2 / 3 |
| `lib/git/rebase.ts` | `crates/git-ops/src/rebase.rs` — **done**: start/continue/abort, selected-file staging, manual conflict resolutions, Channel progress, recovery snapshots, reorder, and squash. `rebase.backend=merge` is pinned because status and snapshot recovery consume `.git/rebase-merge/**`. Upstream's optional terminal callback has no production consumer. | 2 / 3 |
| `lib/git/worktree-include.ts`, `worktree.ts` | `crates/git-ops/src/worktree_include.rs` + `worktree.rs` — porcelain listing, linked-worktree fallback, lifecycle operations, ignore-pattern selection, and guarded best-effort copies **done**. | 2 |
| `lib/progress/from-process.ts` + git progress variants | `crates/git-ops/src/progress.rs` + `remote_progress.rs` — **done**, including live LFS side-channel progress. | 2 |
| `lib/hooks/get-repo-hooks.ts`, `get-shell.ts`, `shell-escape.ts`, `get-shell-env.ts` | `crates/git-ops/src/hooks/{discovery,shell,shell_env}.rs` — **done**, plus the `rdc-printenvz` binary replacing `vendor/printenvz` (a ten-line C program). Discovery honours `core.hooksPath`, works in a worktree, and **fixes an upstream bug** — see §8. Windows shell selection (registry-based Git Bash discovery, MSYS2/PowerShell/cmd quoting) is deliberately not ported; the reasoning is in `hooks/shell.rs`. | 2 |
| `lib/hooks/hooks-proxy.ts`, `with-hooks-env.ts` | **Not a port — a protocol design**, since `process-proxy` ships a *native binary* and its wire format is not in the desktop-plus tree. **Transport done:** `crates/git-ops/src/hooks/{protocol,client,server}.rs` plus the `rdc-hook-proxy` binary — NUL-framed request (token, hook, argv, env, cwd, length-prefixed stdin), framed streaming response (stderr chunks then an exit code), per-operation random token compared in constant time, loopback only, request size capped, and the stand-in **fails closed**. **Runner done:** `hooks/runner.rs` runs `git hook run` with the login-shell environment plus git's own `GIT_*`/`GITHEAD_*` (minus upstream's exclusion set), spools stdin for `--to-stdin`, streams and captures stderr, reports start/finish/failure progress with an abort handle, and offers a failure to the user to ignore. **Wiring done:** `hooks/with_env.rs` installs a stand-in per discovered hook in a temp directory, points `core.hooksPath` at it through `GIT_CONFIG_PARAMETERS` (existing value preserved, `sq_quote`-escaped — closing an upstream TODO), binds a server for one invocation, and loads the login shell at most once per directory. **Command layer done** (Phase 3, slice 1): `commit`, `merge`, `push` and `pull` take a `HookSupport` and name their own hooks, progress crosses on a Channel carrying an id, and `abort_hook` stops a running hook. `rebase` is **not** among them — upstream passes no `interceptHooks` there. The failure prompt is left at its conservative default, so a failing hook aborts the operation; Phase 7 fills that seam and supplies the setting that turns interception on. | 2 / 3 |
| `lib/hooks/config.ts` | **Frontend, not Rust.** Every export reads or writes `localStorage` (`git-hooks-env-enabled`, `git-cache-hooks-env`, `git-hook-env-shell`) behind two feature flags. It is preferences state, so it lands with the Phase 7 settings UI — and note `SupportedHooksEnvShell` names four *Windows* shells, so most of it has no meaning on the primary target. | 7 |
| `lib/trampoline/trampoline-server.ts` | `crates/trampoline/src/server.rs` | 2 |
| `lib/ssh/*` (4 files, at `app/src/lib/ssh/`) | **No `ssh/` module was created.** Host-key prompt classification and parsing live in `crates/trampoline/src/handlers.rs` instead, where the askpass handler needs them (`ssh-host-prompt.ts` and its test were deleted). The remaining SSH env work needs an ssh-wrapper binary. | 2 / 7 |
| `lib/shells/darwin.ts`, `linux.ts`, `shared.ts` | `src-tauri/src/platform/shells.rs` + `shell_model.rs`; typed wrapper at `src/lib/platform/shells.ts` | **Phase 4 complete on Linux/macOS** — discovery, exact terminal launch arguments/cwd behavior, custom launch and selected-shell fallback are done |
| `lib/shells/win32.ts` | `src-tauri/src/platform/shells_windows.rs` (planned); shared labels/order already pinned in `shells.rs` + `src/models/shell.ts` | **Phase 10** — registry/PATH discovery, WSL detection, Windows parsing and `cmd.exe / START` launch; requires Windows CI |
| `lib/editors/**` | `src-tauri/src/platform/editors.rs` + `commands/editor.rs`; typed wrapper at `src/lib/platform/editors.ts` | **Phase 4 complete on Linux/macOS** — discovery, path validation, and normal/custom launch landed test-first; Windows is Phase 10 |
| `lib/helpers/linux.ts` | `src-tauri/src/platform/linux_helpers.rs` (xdg-open etc.) | 4 |
| `lib/shell.ts` | `src-tauri/src/commands/shell.rs` (reveal-in-file-manager, open-external) | 4 |
| `lib/exec-file.ts` | `src-tauri/src/platform/exec.rs` (generic subprocess helper other modules call) | 2 |
| `lib/file-system.ts`, `path-exists.ts`, `directory-exists.ts`, `large-files.ts`, `get-file-hash.ts`, `compute-bundle-hash.ts` | `src-tauri/src/platform/fs_utils.rs` | 1/2 |
| `lib/path.ts` **(tentative — verify)** | likely `src-tauri/src/platform/fs_utils.rs`, but confirm it's not pure string manipulation that could stay TS | 1 |
| `lib/process/win32.ts` | `src-tauri/src/platform/win32/process.rs` | 4 |
| `lib/custom-integration.ts` | model → `src/models/custom-integration.ts`; stored-format migration and the frontend-facing validation facade → `src/lib/custom-integration.ts`; parsing, validation, placeholder expansion and process launch → `src-tauri/src/platform/custom_integration.rs` + `editors.rs` | **Phase 4 complete on Linux/macOS** — the pure migration preserves the upstream no-update `null` contract, while POSIX parsing, executable/symlink validation, macOS bundle validation, and launch are native; Windows parsing is Phase 10 |
| `lib/copilot/byok.ts` | `src-tauri/src/commands/copilot_byok.rs` (uses the same `keyring` crate as token storage) | 4 |
| `lib/copilot-conflict-context.ts` **(tentative)** | `src-tauri/src/commands/copilot_conflict_context.rs` | 2 |
| `lib/get-architecture.ts`, `get-os.ts` | `src-tauri/src/platform/system_info.rs` | 4 |
| `lib/get-main-guid.ts`, `get-updater-guid.ts` | `src-tauri/src/platform/install_id.rs` | 4 |
| `lib/find-toast-activator-clsid.ts` | `src-tauri/src/platform/notifications/windows.rs` — superseded by `tauri-plugin-notification`, confirm still needed at all | 4 |
| `lib/main-process-config.ts` | `src-tauri/src/config.rs` | **Phase 4a startup read done** for `titleBarStyle`; Phase 4b adds the typed frontend get/update surface and `hideWindowOnQuit` |
| `lib/logging/get-log-path.ts` | `src-tauri/src/platform/log_path.rs` | 4/6 |

**(b) File stays TypeScript; only its internal Node/Electron touch-points get swapped for
`invoke`/`@tauri-apps/api` calls** — the surrounding business logic doesn't move:

| Old path | New path | Note | Phase |
|---|---|---|---|
| `lib/ipc-renderer.ts` | *(deleted, not ported)* | superseded entirely by `@tauri-apps/api/core` `invoke`/`listen` | 3 |
| `lib/git/tag.ts` | `crates/git-ops/src/tag.rs` | 2 |
| `lib/git/revert.ts` | `crates/git-ops/src/revert.rs` | 2 |
| `lib/git/reflog.ts` | `crates/git-ops/src/reflog.rs` | 2 |
| `lib/git/description.ts` | `crates/git-ops/src/description.rs` (path fixed for worktrees) | 2 |
| `lib/git/var.ts` | `crates/git-ops/src/var.rs` | 2 |
| `lib/git/clean.ts` | `crates/git-ops/src/clean.rs` | 2 |
| `lib/git/squash.ts` | `crates/git-ops/src/squash.rs` | 2 |
| `lib/git/reorder.ts` | `crates/git-ops/src/reorder.rs` | 2 |
| `lib/git/submodule.ts` | `crates/git-ops/src/submodule.rs`; `SubmoduleEntry.describe` becomes nullable | 2 |
| `lib/git/stash.ts` | `crates/git-ops/src/stash.rs` | 2 |
| `lib/git/cherry-pick.ts` | `crates/git-ops/src/cherry_pick.rs` | 2 |
| `lib/git/clone.ts` | `crates/git-ops/src/clone.rs` | 2 |
| `lib/git/remote.ts` | `crates/git-ops/src/remote.rs` (memoization dropped) | 2 |
| `lib/progress/clone.ts` | `crates/git-ops/src/progress.rs` | 2 |
| `lib/git/push.ts` | `crates/git-ops/src/push.rs` — hooks and their command Channel handoff are complete; Phase 7 owns enable/failure UI | 2 / 3 / 7 |
| `lib/git/fetch.ts` | `crates/git-ops/src/fetch.rs` | 2 |
| `lib/git/pull.ts` | `crates/git-ops/src/pull.rs` — hooks and their command Channel handoff are complete; Phase 7 owns enable/failure UI | 2 / 3 / 7 |
| `lib/progress/{git,push,fetch,pull}.ts` | `crates/git-ops/src/progress.rs` | 2 |
| `lib/git/authentication.ts` | `crates/git-ops/src/authentication.rs` | 2 |
| `lib/trampoline/trampoline-environment.ts` | `crates/trampoline/src/session.rs` | 2 |
| `lib/trampoline/trampoline-askpass-handler.ts` | `crates/trampoline/src/handlers.rs` | 2 |
| `lib/trampoline/trampoline-credential-helper.ts` | `crates/trampoline/src/handlers.rs` (account/UI decisions behind traits) | 2 |
| `lib/git/credential.ts`, `lib/trampoline/url-without-credentials.ts` | `crates/trampoline/src/credential.rs` | 2 |
| `lib/ssh/ssh.ts` (`parseAddSSHHostPrompt`) | `crates/trampoline/src/handlers.rs` — **the TypeScript port is deleted** | 2 |
| `lib/git/diff.ts` | `crates/git-ops/src/diff.rs` — **complete** but for `getFilesDiffText`, which stays with its store consumer (Phase 7). Text, image, conflict-resolution, submodule, branch-merge-base and commit-range readers all ported; image bytes cross as `rdc-blob://` URLs — see §8. | 2 / 3 |
| `lib/git/show.ts` | `crates/git-ops/src/show.rs` — **done**, both entry points. `getPartialBlobContents` reads a bounded prefix through `exec::git_capped`, a real cap rather than a slice after the fact. Neither is a raw-byte command: full image contents cross through Phase 3's scoped `rdc-blob` capability URL; Phase 7 owns the bounded text-prefix consumer. | 2 / 3 / 7 |
| `lib/git/diff-index.ts` | `crates/git-ops/src/diff_index.rs`; `IndexStatus` → **`src/models/index-status.ts`** | 2 |
| `lib/git/log.ts` | `crates/git-ops/src/log.rs` | 2 |
| `lib/diff-parser.ts` | `crates/git-ops/src/diff_parser.rs` — **the TypeScript parser is deleted**, same fork as `status-parser` | 2 |
| `lib/git/apply.ts` + `lib/patch-formatter.ts` | `crates/git-ops/src/apply.rs` + `patch_formatter.rs` — partial staging and partial discard **done** | 2 / 3 |
| `lib/git/gitignore.ts` | `crates/git-ops/src/gitignore.rs` — root-file read/write/append and literal filename escaping **done** | 2 |
| `lib/git/checkout-index.ts` | `crates/git-ops/src/checkout_index.rs` — NUL-delimited index restore **done** | 2 |
| `lib/git/format-patch.ts` | `crates/git-ops/src/format_patch.rs` — minimal mailbox patch generation **done** | 2 |
| `lib/git/merge-tree.ts` | `crates/git-ops/src/merge_tree.rs` — clean/conflicted/invalid mergeability computation **done** | 2 |
| `lib/git/lfs.ts` + `lib/progress/lfs.ts` | `crates/git-ops/src/lfs.rs` + `progress.rs` — filter/hook installation, attribute queries, and aggregated live transfer progress **done** | 2 |
| `lib/git/multi-operation-terminal-output.ts` | `crates/git-ops/src/multi_operation_terminal_output.rs` — bounded replay, live fan-out, and RAII subscriptions **done**; `create_commit` adapts it to a Tauri Channel | 2 / 3 |
| `lib/git/commit.ts` | `crates/git-ops/src/commit.rs` — create/amend, hooks, and combined terminal-output Channel **done**; Phase 7 owns the store buffer and progress dialog | 3 / 7 |
| `lib/git/checkout.ts` | `crates/git-ops/src/checkout.rs` — checkout, submodule updates, and **Channel-based progress done** for local branch, remote branch, and commit. | 3 |
| `lib/git/update-index.ts` | `crates/git-ops/src/update_index.rs` — whole-file and partial line selections **done** | 3 |
| `lib/git/stage.ts` | `crates/git-ops/src/stage.rs` — **complete**, both entry points. `stageResolvedConflictFiles` takes `ResolvedConflict` (path, index entries, marker count, chosen side) rather than a `WorkingDirectoryFileChange`, which is view state. | 3 |
| `lib/git/reset.ts` | `crates/git-ops/src/reset.rs` — **complete**: `unstageAll`, `reset` and `resetPaths`, with `ResetMode` → **`src/models/git-reset-mode.ts`** (an enum crossing IPC is a domain type, as `IndexStatus` was). Paths reach `resetPaths` through `--pathspec-from-file` rather than the original's Windows-only `--stdin` — see §8. | 3 |
| `lib/git/rm.ts` | `crates/git-ops/src/rm.rs` — **complete**: `removeConflictedFile` and `unstageAllFiles`. The latter is `rm --cached -r -f .`, which is *not* `reset.ts`'s `unstageAll`; upstream keeps them in different files for that reason. | 3 |
| `lib/ipc-shared.ts` | `rdc/MIGRATION_MAP.md` §7 channel table; hand-written `src/lib/*-ipc.ts` wrappers over native `invoke` (**no** codegen — see §8) | 3 |
| `lib/app-shell.ts` | `rdc/src/lib/app-shell.ts` | thin wrapper over native opener/shell commands | 4 |
| `lib/stores/app-store.ts` | `rdc/src/lib/stores/app-store.ts` | **keep this file and its shape** (Phase 7 principle) — only its direct OS-touching calls change to `invoke` | 7 |
| `lib/stores/git-store.ts` | `rdc/src/lib/stores/git-store.ts` | same | 7 |
| `lib/stores/helpers/create-tutorial-repository.ts` | `rdc/src/lib/stores/helpers/create-tutorial-repository.ts` | same | 7 |
| `lib/source-map-support.ts` | *(dropped)* | Node-specific stack-trace remapping for the Electron main process; superseded by Rust panic hook + Sentry (Phase 6) | 6 |
| `lib/release-notes.ts` | `rdc/src/lib/release-notes.ts` **(tentative)** | see improvement flag in §2 — may not need a Rust command at all if changelog data becomes a bundled asset | 1 |

### Phase 2 export-level closure checklist

Audited against the recursive `desktop-plus/app/src/lib/git/**/*.ts` and
`desktop-plus/app/src/lib/hooks/**/*.ts` trees, not against matching filenames in rdc. **Complete**
means every exported runtime behavior is implemented or deliberately superseded. **Deferred**
means the behavior has a concrete owner; the later phase need not implement it before Phase 2
closes, but it must accept the handoff. Exported TypeScript-only types are tracked with the runtime
operation that consumes them rather than counted as separate backend behavior.

#### `lib/git` — 60 files

| Upstream file | Exported behavior disposition | Status / owner |
|---|---|---|
| `add.ts` | `addConflictedFile` → `add_conflicted_file` | **complete** |
| `apply.ts` | partial staging and discard → `apply.rs` + `patch_formatter.rs` | **complete** |
| `authentication.ts` | authentication environment and error classification → `authentication.rs` + `git_error_kind.rs` | **complete** |
| `branch.ts` | create, list names, rename, local/remote delete, pointed-at and merged queries → `branch.rs` | **complete** |
| `checkout-index.ts` | `checkoutIndex` → `checkout_index.rs` | **complete** |
| `checkout.ts` | branch/commit/path/conflict checkout and progress → `checkout.rs` | **complete** |
| `cherry-pick.ts` | start, snapshot, continue, abort and state detection → `cherry_pick.rs` + `operation_state.rs` | **complete** |
| `clean.ts` | `cleanUntrackedFiles` → `clean.rs` | **complete** |
| `clone.ts` | clone and progress → `clone.rs` | **complete** |
| `coerce-to-buffer.ts` | Node `Buffer` coercion is superseded by byte-native `GitOutput` | **complete — superseded** |
| `coerce-to-string.ts` | string coercion is superseded by explicit lossy/trimmed output conversion | **complete — superseded** |
| `commit.ts` | create/amend and merge commits → `commit.rs`; hook progress and combined commit stdout/stderr cross through Channels | backend and Channel handoff **complete**; bounded frontend history, enable state and progress dialog **Phase 7** |
| `config.ts` | repository/global get/set/add/remove and booleans → `config.rs`; global config path remains platform/editor work; origin/display formatters remain frontend work | backend **complete**; deferred **Phase 4 / Phase 7** |
| `core.ts` | process execution, output, errors, auth classification, rebase flags and SHA parsing → `exec.rs`, `error.rs`, `git_error_kind.rs` and callers; config-lock/user-facing descriptions remain frontend policy | backend and Phase 3 command adapters **complete**; descriptions/config-lock presentation **Phase 7** |
| `create-tail-stream.ts` | bounded terminal history → `terminal_output.rs` / `multi_operation_terminal_output.rs` | **complete — superseded** |
| `credential.ts` | credential parse/format/fill/approve/reject protocol → `trampoline` | **complete** |
| `description.ts` | read/write repository description → `description.rs` | **complete** |
| `diff-check.ts` | conflict-marker detection → `diff_check.rs` | **complete** |
| `diff-index.ts` | index status, null tree and index changes → `diff_index.rs` + `models/index-status.ts` | **complete** |
| `diff.ts` | working-directory, commit, range, resolution, and image diff production → `diff.rs`; images use Phase 3's scoped `rdc-blob` capability URLs; `getFilesDiffText` and rendering wait for store/UI consumers | backend and byte transport **complete**; remaining consumers **Phase 7** |
| `environment.ts` | authentication half → `authentication.rs`; proxy fallback/resolution has no Electron-free equivalent yet | **deferred Phase 5** |
| `fetch.ts` | fetch, refspec fetch and fast-forward → `fetch.rs` | **complete** |
| `for-each-ref.ts` | branches and upstream-difference queries → `for_each_ref.rs` | **complete** |
| `format-patch.ts` | mailbox patch generation → `format_patch.rs` | **complete** |
| `git-delimiter-parser.ts` | log and for-each-ref delimiter parsers → `git_delimiter_parser.rs` | **complete** |
| `gitignore.ts` | root read/save/append and escaping → `gitignore.rs` | **complete** |
| `index.ts` | barrel exports only; consumers import the replacement modules directly | **complete — dropped barrel** |
| `init.ts` | repository initialization → `init.rs`; default branch is an explicit caller argument | **complete** |
| `interpret-trailers.ts` | parsing/merging → `interpret_trailers.rs`; trailer model/predicate → `models/trailer.ts` | **complete — split** |
| `lfs.ts` | filter/hook installation and attribute queries → `lfs.rs` | **complete** |
| `log.ts` | commits, changed files, raw/numstat parsing, commit and authors → `log.rs` | **complete** |
| `merge-tree.ts` | mergeability calculation → `merge_tree.rs` | **complete** |
| `merge.ts` | merge, base, abort and state detection → `merge.rs` + `operation_state.rs`; hook progress crosses on a Channel. Its optional terminal callback has no production caller upstream. | **complete**; hook enable state **Phase 7** |
| `multi-operation-terminal-output.ts` | bounded replay and live fan-out → `multi_operation_terminal_output.rs`; `create_commit` subscribes a Tauri Channel for its concrete upstream consumer | **complete** |
| `pull.ts` | pull, progress and hook progress → `pull.rs`. Upstream declares terminal and hook-failure callbacks but never copies them into its Git execution options, so its terminal callback is a no-op; rdc does not silently turn it into a new feature. | **complete**; hook enable/failure UI **Phase 7** |
| `push-terminal-chunk.ts` | bounded terminal chunk handling → `terminal_output.rs` | **complete** |
| `push.ts` | push, lease, transfer progress and hook progress → `push.rs`; upstream's optional terminal callback has no production caller | **complete**; hook enable/failure UI **Phase 7** |
| `rebase.ts` | state, snapshot, start/continue/abort and interactive reorder/squash → `rebase.rs`, `reorder.rs`, `squash.rs`; upstream's optional terminal callback has no production caller | **complete** |
| `reflog.ts` | recent branches and branch checkouts → `reflog.rs` | **complete** |
| `refs.ts` | local-ref formatting and symbolic ref → `refs.rs` | **complete** |
| `remote.ts` | list/add/remove/set/get URL and remote HEAD → `remote.rs`; frontend memoization is intentionally dropped | **complete** |
| `reorder.ts` | interactive reorder → `reorder.rs` | **complete** |
| `reset.ts` | all three entry points → `reset.rs`, with `GitResetMode` in `models/` | **complete** |
| `rev-list.ts` | commit-range queries and `getAheadBehind` → `rev_list.rs`; range builders and `getBranchAheadBehind` → TypeScript | **complete** but for `doMergeCommitsExistAfterCommit`, whose only callers are `ui/history/**` (**Phase 7**) |
| `rev-parse.ts` | repository type and upstream ref/remote queries → `rev_parse.rs` | **complete** |
| `revert.ts` | revert and progress → `revert.rs` | **complete** |
| `rm.ts` | unstage-all/remove-conflicted behavior → `reset.rs` + `rm.rs` | **complete — split** |
| `show.ts` | full and capped blob reads → `show.rs`; full bytes are served by scoped `rdc-blob` capability URLs, not a byte-returning command | backend and Phase 3 representation **complete**; bounded text consumer **Phase 7** |
| `spawn.ts` | dugite spawn wrapper → byte-native async `exec.rs` | **complete — superseded** |
| `squash.ts` | interactive squash → `squash.rs` | **complete** |
| `stage.ts` | manual and batch conflict resolution staging → `stage.rs` | **complete** |
| `stash.ts` | list/create/drop/pop/move/rename/last-entry/files → `stash.rs` | **complete** |
| `status.ts` | status execution, parsing and operation state → `status.rs` + `status_parser.rs` + `operation_state.rs` | **complete** |
| `submodule.ts` | update/list/reset and checkout integration → `submodule.rs` | **complete** |
| `tag.ts` | create/delete/list/tags-to-push → `tag.rs` | **complete** |
| `update-index.ts` | whole-file and partial selection staging → `update_index.rs` | **complete** |
| `update-ref.ts` | `deleteRef` → `update_ref.rs`; `updateRef` has no consumer anywhere in upstream and is deliberately not carried as dead API | **complete — unused export dropped** |
| `var.ts` | author identity → `var.rs` | **complete** |
| `worktree-include.ts` | patterns, matching copies and add-with-includes → `worktree_include.rs` | **complete** |
| `worktree.ts` | parse/list/add/remove/move worktrees → `worktree.rs` | **complete** |

#### `lib/hooks` — 7 files

| Upstream file | Exported behavior disposition | Status / owner |
|---|---|---|
| `config.ts` | hook enable/cache/shell preferences are frontend `localStorage` state | **deferred Phase 7** |
| `get-repo-hooks.ts` | hook discovery → `hooks/discovery.rs` | **complete** |
| `get-shell-env.ts` | login-shell environment loading → `hooks/shell_env.rs` + `rdc-printenvz` | **complete** |
| `get-shell.ts` | Unix shell selection → `hooks/shell.rs`; Git Bash/Windows selection remains platform work | Unix **complete**; Windows **Phase 4** |
| `hooks-proxy.ts` | proxy transport/runner/server → `hooks/{protocol,client,server,runner}.rs` + `rdc-hook-proxy` | backend and Phase 3 command Channel handoff **complete**; failure UI **Phase 7** |
| `shell-escape.ts` | POSIX shell escaping → `hooks/shell.rs`; cmd/PowerShell escaping remains Windows platform work | Unix **complete**; Windows **Phase 4** |
| `with-hooks-env.ts` | stand-ins, server lifetime and environment injection → `hooks/with_env.rs`; four upstream operations opt in through their commands | backend and Phase 3 command handoff **complete**; enable state **Phase 7** |

#### Adjacent Phase 2 handoffs

- `lib/helpers/default-branch.ts`: `getDefaultBranch`/`setDefaultBranch` are app policy over global
  config. They land with their preference and tutorial consumers in **Phase 7**; Phase 3 does not add
  consumerless commands for them.
- `crates/trampoline`: Linux and macOS credential/askpass transport is complete. Windows token
  generation requires `BCryptGenRandom`, and Windows shell selection/escaping is likewise absent;
  the Windows port is explicitly owned by **Phase 4**. Until then, Windows is not a supported rdc
  target.
- The acceptance suite count is **51 recursively**, not 45: 45 files at `test/unit/git/` plus four
  under `git/pull/` and two under `git/rebase/`.

Everything else in `lib/**` not listed above → §2 (portable, stays TS as-is).

---

## 4. `main-process/**` (28 files) → `src-tauri/**`

| Old path | Target | Phase |
|---|---|---|
| `main.ts` | `src-tauri/src/lib.rs` (app entry/lifecycle, single-instance, protocol registration) | 4 |
| `app-window.ts` | `src-tauri/src/lib.rs` + `src-tauri/src/platform/window.rs` + `src/lib/platform/lifetime.ts` + `tauri-plugin-window-state` (replaces `electron-window-state`) | **Phase 4a done** — startup `titleBarStyle`, direct state/zoom wrappers, the `renderer-ready` restore/show gate, frontend-owned preventable close flow, per-window selected-repository metadata, fresh repository-window creation and non-last-window destruction are implemented; persisted geometry/maximization restores before the first visible frame |
| `ipc-main.ts` | *(deleted)* — superseded by `#[tauri::command]` registration | 3 |
| `ipc-webcontents.ts` | *(deleted)* — superseded by `app.emit()` | 3 |
| `trusted-ipc-sender.ts` | *(deleted)* — Tauri's IPC has no equivalent "trusted sender" gap to guard against in the same way; confirm no replacement needed | 3 |
| `crash-window.ts`, `show-uncaught-exception.ts`, `exception-reporting.ts` | Rust panic hook + unified Sentry integration (see Phase 6) | 6 |
| `menu/build-context-menu.ts`, `build-default-menu.ts`, `build-test-menu.ts`, `crash-menu.ts`, `ensure-item-ids.ts`, `get-all-menu-items.ts`, `index.ts`, `menu-event.ts` | structure/model → `src/lib/menu/**` + `src/models/app-menu.ts` (**default/test tree and Linux/Windows dispatcher done**); bindings/persistence → `src-tauri/src/platform/keybindings.rs` (**done**); native macOS → `src-tauri/src/platform/menu.rs` (**mechanism done and manually validated; automation is Linux-only**); general/nested contextual menus → `src-tauri/src/platform/context_menu.rs` + `src/lib/menu/context-menu.ts` (**done; edit placeholder deferred below**). **Phase 9 owns the inherited Help destinations and `About Desktop Plus` label as product identity, after rdc's URLs are final.** | 4 / 9 |
| `menu/build-spell-check-menu.ts` + contextual `editMenu` expansion | WebKitGTK suggestions and Wayland-safe edit actions, ported with their text-input consumers | 7 |
| `notifications.ts` | `tauri-plugin-notification` (cross-platform, replaces vendored `desktop-notifications`) | 4 |
| `squirrel-updater.ts` | *(deleted)* — replaced by `tauri-plugin-updater` | 4 |
| `shell.ts` | `src-tauri/src/commands/shell.rs` (merge with `lib/shell.ts`, §3) | 4 |
| `migrate-config-dir.ts` | *(dropped, not ported)* — the "confirm relevance" question has an answer: rdc owes `desktop-plus` no configuration compatibility, per `MIGRATION_PLAN.md` guiding principle 6. Settings formats are rdc's own | 4 |
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
| `test/unit/git/**` (51 files recursively: 45 top-level + 6 nested) | `crates/git-ops/src/**` (`#[cfg(test)]`, inline per Rust convention) | acceptance spec for Phase 2 |
| `test/unit/stores/**` (5 + `updates/`) | `rdc/src/lib/stores/**/*.test.ts` (Vitest, colocated) | Phase 7 |
| `test/unit/main-process/menu-test.ts` | `src/lib/menu/**` + `src-tauri/src/platform/{menu,context_menu}.rs` | Phase 4 |
| `test/unit/main-process/spell-checker-menu-test.ts` | colocated with the WebKitGTK text-input integration | Phase 7 |
| `test/unit/ui/**` (~30 `.tsx`) | `rdc/src/ui/**/*.test.tsx` (Vitest + Testing Library, colocated) | Phase 7 |
| remaining ~25 top-level `*-test.ts` (lib utils / models) | colocated `*.test.ts` next to the ported file in `rdc/src/lib/**` or `rdc/src/models/**` | Phase 1 |

### Landed in the initial Phase 1 slice (historical: 31 files, 288 tests)

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

Also ported in Step 2: `diff-parser` → `src/lib/diff-parser.test.ts`, alongside
`src/lib/diff-parser.ts` and the new `src/lib/diff-hunks.ts` (see §8). Phase 2 later moved parsing
to Rust and deleted both TypeScript parser implementations/tests; these counts are the Phase 1
closure snapshot, not the current tree.

**Blocked** (4, was 15): `popup-manager`, `format-commit-message`, `stats-store`, and
`app-store-test-harness`. They are genuinely consumer-phase-gated rather than blocked by layering.
The former `ipc-contract` deferral is superseded by the exact 82-channel measurement and its regression
tests; Phase 3 also supplied `format-commit-message`'s `merge_trailers` command, leaving its TypeScript
helper/test to Phase 7 with the stores that consume it.

**Recovered (9):**
- `create-branch` → `src/lib/create-branch.test.ts` (9 tests), by extracting the trailer type out
  of the git layer.
- `pull-request-refs` → `src/lib/pull-request-refs.test.ts` (6 tests), by extracting the
  issue-reference regex constants out of the markdown-filter chain. Its closure now has **no
  filesystem dependency at all** — contrary to the earlier note here, no emoji-asset work was
  needed; see the correction in `MIGRATION_PLAN.md`.
- `repository`, `name-of`, `model-type-guards`, `text-token-parser`,
  `wrap-rich-text-commit-message` (5) → by the `Repository` redesign (§8). 45 tests across the five.
- `format` → `src/lib/rebase.test.ts`, `multi-commit-operation` →
  `src/lib/multi-commit-operation.test.ts` (20 tests), by decomposing `lib/app-state.ts` into
  `src/lib/app-state/` and narrowing two over-specified parameter types (§8).

**Historical checkpoint after `status` landed: still all 15.** Porting git to Rust could not unblock them —
they are TypeScript tests whose closure reaches `lib/git/**` via `import`, and a Rust
implementation gives TypeScript nothing to import. The blocker is not "git isn't implemented" but
"TypeScript still asks for git the Node way". The eight edges responsible, and the cheapest way to
retire them, are tabulated in `MIGRATION_PLAN.md` under "Re-check of the 15 deferred Phase 1
tests". Short version: `interpret-trailers` → Rust unblocks `create-branch` outright and leaves
`pull-request-refs` with a single blocker; the `Repository` redesign is worth 5 tests on its own.

---

## 7. IPC channel table (`app/src/lib/ipc-shared.ts`, 82 channels)

**Complete.** Two tables, because the app has two disjoint IPC surfaces: §7.1 routes every channel
upstream actually had, and §7.2 lists the git commands, which had no channel at all because the renderer
called dugite in-process.

**There are 82 channels, not 77.** The earlier figure was never derived from the file — 53 in
`RequestChannels` and 29 in `RequestResponseChannels`, counted by parsing the two type declarations. The
directions below were read the same way, from which side calls `ipcRenderer.send`/`ipcMain.on` versus
`ipcWebContents.send`/`ipcRenderer.on`, rather than inferred from the channel's name.

### 7.1 Upstream channels, routed

Every channel, its direction, what replaces it, and the phase that owns it. **Not one of them is Phase 3
work** — that is the finding, not an omission: git never crossed IPC in Electron, and everything that did
cross is a platform integration.

| | Count |
|---|---|
| Phase 4 — native platform integrations | 70 |
| Phase 6 — crash and exception reporting | 5 |
| Phase 5 — session-level network behaviour | 4 |
| Phase 9 — packaging and the CLI | 3 |

Phase 4 was 71 and Phase 5 was 3 until `resolve-proxy` moved between them; see its row.

Phase 4's frontend-facing audit is `scripts/measure-platform-surface.mjs`. Its kickoff baseline parses
67 callable exports from `ui/main-process-proxy.ts` and **19** distinct `ipcRenderer.on(...)` channels
across upstream `ui/` and `lib/` (the plan originally said 18 because it omitted `app-menu` from that
count). All 86 names are classified; Phase 4 owns 58 exports and 16 subscriptions, while the rest name
their later phase or deliberate deletion.

**37 of the 82 need no IPC at all.** A Tauri plugin API is callable straight from the frontend, so
`minimize-window` becomes `getCurrentWindow().minimize()` and the channel simply disappears — which is
what makes this table worth having before Phase 4 starts rather than after. **Four** have **no known
equivalent** and are flagged as design work rather than given a mechanism, and all four are now Phase 5:
`update-accounts`, `certificate-error`, `show-certificate-trust-dialog`, and `resolve-proxy`, which was
routed as a Phase 4 command until it was rehomed — see its row.

**Two more are deleted rather than routed**, by `MIGRATION_PLAN.md` guiding principle 6 (rdc owes
`desktop-plus` no configuration compatibility): `get-config-migration-result` and the
`main-process/migrate-config-dir.ts` it reports on. Their rows stay in the table so the inventory still
matches upstream's 82 exactly; "deleted" is a routing outcome, not a gap.

Two shapes changed rather than moved, and both are cheaper than a port:

- **Five auto-updater push channels collapse into one plugin call.** They were separate only because
  Squirrel reported its progress as a state machine; `tauri-plugin-updater` returns a promise.
- **The three quit channels reverse direction.** Electron's main process asked the renderer for
  permission to quit; Tauri hands the frontend a preventable `onCloseRequested`, so the frontend decides
  in place instead of answering a question.

**Application menu and context menus** (10)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `get-app-menu` | renderer→main | **implemented with no IPC** — `ApplicationMenuController.menu` owns the current frontend tree | 4 |
| `app-menu` | main→renderer | **implemented with no IPC** — tree replacement stays inside `ApplicationMenuController` | 4 |
| `update-menu-state` | renderer→main | **implemented as in-process tree replacement**; Phase 7 supplies the app-state policy | 4 |
| `update-preferred-app-menu-item-labels` | renderer→main | **implemented by rebuilding/replacing the frontend tree**; macOS mirrors it through `set_native_menu` | 4 |
| `execute-menu-item-by-id` | renderer→main | **implemented in-process** against the current enabled/visible item and shared action executor | 4 |
| `menu-event` | main→renderer | **implemented and narrowed to macOS** — `on_menu_event` emits the typed action; Linux/Windows execute locally | 4 |
| `show-contextual-menu` | request/response | command building a `Menu` and popping it up | 4 |
| `select-all-window-contents` | renderer→main | **implemented with no IPC** — `document.execCommand('selectAll')` in the frontend | 4 |
| `dialog-did-open` | renderer→main | command → `request_user_attention` — beeps on macOS and bounces the dock; nothing to route if that is dropped | 4 |
| `get-apple-action-on-double-click` | request/response | command reading the macOS preference — macOS only; no plugin, so a `plist` read | 4 |

> **Phase 4a revises these rows: the menu splits in two, and the split is not down platform lines.**
> The mechanisms above assume Rust owns the menu the way Electron's main process did. It won't.
>
> **Structure, labels and enablement → TypeScript**, because the menu is a continuous function of frontend
> state, not a static definition: `buildDefaultMenuTemplate` takes **11 app-state fields**
> (`models/menu-labels.ts`) and `lib/menu-update.ts` computes a 531-line enablement policy on top. Rust
> owning it would mean the frontend pushing all of that in so Rust could re-template.
>
> **Key bindings → Rust** (`platform/keybindings.rs`), because macOS *requires* a native menu bar and Rust
> builds it before the webview loads — so the bindings cannot live in webview storage, the same reasoning
> that makes `titleBarStyle` a Rust-side config read. The 52 accelerator declarations currently inline
> in `build-default-menu.ts` are extracted into 50 logical `MenuId → { modifiers, key }` defaults
> (`preferences` and `repository-preferences` each occur in two platform branches);
> a binding crosses as **structured data, never as an accelerator string**, so its grammar is parsed once
> in Rust rather than reimplemented in both languages. `key` uses physical `KeyboardEvent.code` names,
> matching the physical accelerator parser behind Tauri 2.11/muda. macOS first installs a minimal Rust
> bootstrap menu; after `renderer-ready`, TypeScript pushes the canonical state-derived structure,
> labels and enablement rather than Rust duplicating that policy.
>
> Channel outcome, precisely: `get-app-menu`, `app-menu` and `execute-menu-item-by-id` become **in-process
> frontend state on every platform**; `update-menu-state` and `update-preferred-app-menu-item-labels` do
> the same **on Linux and Windows only** and survive on macOS with their **direction reversed**
> (renderer→main), since Rust needs labels and enablement to build the native menu; `menu-event` narrows
> to the macOS native menu. This is now implemented by `ApplicationMenuController`: it preserves open
> menu state while replacing the tree, rejects stale/disabled execution, refreshes macOS after tree or
> binding changes, and gives Linux/Windows the live tree and binding map through the capture-phase
> dispatcher. Phase 7 plugs its state-derived tree and action dispatcher into that owner.
>
> **The cost:** Electron registers accelerators natively and they fire on Linux with the menu bar hidden.
> `models/app-menu.ts` carries `accelerator` and `ui/app-menu/menu-list-item.tsx` only renders it —
> verified, nothing upstream dispatches it — so accelerator matching becomes new frontend `keydown` code.
> The rebinding *UI* that the Rust map makes possible is **Phase 7**, and is the one place rdc adds a
> capability upstream never had: there is no keybinding customization in `desktop-plus` at all (checked).

**Window state, position and zoom** (20)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `minimize-window` | renderer→main | **implemented, no IPC** — `getCurrentWindow().minimize()` | 4 |
| `maximize-window` | renderer→main | **implemented, no IPC** — `.maximize()` | 4 |
| `unmaximize-window` | renderer→main | **implemented, no IPC** — `.unmaximize()` | 4 |
| `close-window` | renderer→main | **implemented, no IPC** — `.close()` | 4 |
| `focus-window` | renderer→main | **implemented, no IPC** — `.setFocus()` | 4 |
| `is-window-maximized` | request/response | **implemented, no IPC** — `.isMaximized()` | 4 |
| `is-window-focused` | request/response | **implemented, no IPC** — `.isFocused()` | 4 |
| `get-current-window-state` | request/response | **implemented, no IPC** — window API with the upstream state precedence; `tauri-plugin-window-state` separately persists geometry | 4 |
| `window-state-changed` | main→renderer | **implemented, no IPC** — frontend `onResized` plus direct notification after wrapper-initiated transitions | 4 |
| `focus` | main→renderer | **implemented, no IPC** — one typed `onWindowFocusChanged` adapter over `onFocusChanged` | 4 |
| `blur` | main→renderer | **implemented, no IPC** — the same boolean adapter | 4 |
| `set-window-title` | renderer→main | **implemented, no IPC** — `.setTitle()` | 4 |
| `set-window-zoom-factor` | renderer→main | **implemented command** — `.set_zoom()` and the per-webview remembered value change atomically from the frontend's perspective | 4 |
| `get-current-window-zoom-factor` | request/response | **implemented command** — Tauri sets zoom but does not report it, so Rust remembers the last successful value per webview | 4 |
| `zoom-factor-changed` | main→renderer | **implemented** — the setter emits from the originating window; there is no native webview zoom event | 4 |
| `update-window-background-color` | renderer→main | **implemented, no IPC** — current window `.setBackgroundColor()` accepts the same CSS color string | 4 |
| `set-window-selected-repository` | renderer→main | **implemented command** — stores the renderer's verbatim `string \| null` routing hint by originating window label and removes it on native window destruction | 4 |
| `open-repository-in-new-window` | renderer→main | **implemented command** — always creates a fresh uniquely labelled `WebviewWindow` from the `main` template and queues the verbatim repository path for that renderer | 4 |
| `renderer-ready` | renderer→main | **implemented command** — the window starts hidden; the one-shot handshake restores persisted size/position/maximization, shows and focuses it, then returns any queued startup action exactly once | 4 |
| `launch-timing-stats` | main→renderer | **implemented** — Rust combines native ready/load durations with the renderer duration and emits the upstream three-field payload | 4 |

**Theme** (3)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `should-use-dark-colors` | request/response | **implemented, no IPC** — resolved current-window `.theme()` is compared with `dark` | 4 |
| `set-native-theme-source` | renderer→main | **implemented, no custom IPC** — application-wide `setTheme`; upstream `system` maps to Tauri `null` | 4 |
| `native-theme-updated` | main→renderer | **implemented, no IPC** — `onThemeChanged` adapted back to upstream's payload-free notification | 4 |

**Paths, files and the shell** (13)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `get-path` | request/response | **implemented, no IPC** — typed mapping from every renderer-consumed Electron name to `@tauri-apps/api/path` | 4 |
| `get-app-path` | request/response | **implemented, no IPC** — `resourceDir()` is the packaged-resource equivalent | 4 |
| `get-exec-path` | request/response | **implemented command** — `current_exe()`, including a non-Unicode error rather than a lossy path | 4 |
| `get-app-architecture` | request/response | **implemented, no custom IPC** — `tauri-plugin-os` plus the translation query preserves `x64` / `arm64` / `x64-emulated` | 4 |
| `is-running-under-arm64-translation` | request/response | **implemented command on macOS/Linux** — `sysctl.proc_translated` on macOS and false elsewhere; WOW64 remains Phase 10 | 4 / 10 |
| `move-to-trash` | request/response | **implemented command** using the `trash` crate in a blocking task — deletion is never substituted | 4 |
| `show-item-in-folder` | request/response | **implemented, no IPC** — `tauri-plugin-opener` `revealItemInDir`, preserving upstream's absorbed/logged failure | 4 |
| `open-external` | request/response | **implemented, no IPC** — URL/path split over `tauri-plugin-opener`, preserving the boolean result | 4 |
| `unsafe-open-directory` | renderer→main | **implemented, no IPC** — direct `openPath`, kept private behind the safe classifier in normal use | 4 |
| `show-save-dialog` | request/response | **implemented, no IPC** — `tauri-plugin-dialog`; returns one path or `null` | 4 |
| `show-open-dialog` | request/response | **implemented, no IPC** — Electron property flags translate to Tauri options and multiple results collapse to the first | 4 |
| `is-in-application-folder` | request/response | command — macOS only | 4 |
| `move-to-applications-folder` | request/response | command — macOS only | 4 |

**Updater and process lifetime** (13)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `check-for-updates` | request/response | **no IPC** — `tauri-plugin-updater` | 4 |
| `quit-and-install-updates` | renderer→main | **no IPC** — `tauri-plugin-updater` | 4 |
| `show-installing-update` | main→renderer | `emit` from Rust | 4 |
| `auto-updater-checking-for-update` | main→renderer | **no IPC** — the plugin's own promise | 4 |
| `auto-updater-update-available` | main→renderer | **no IPC** — the plugin's own promise | 4 |
| `auto-updater-update-not-available` | main→renderer | **no IPC** — the plugin's own promise | 4 |
| `auto-updater-update-downloaded` | main→renderer | **no IPC** — the plugin's download progress | 4 |
| `auto-updater-error` | main→renderer | **no IPC** — a rejected promise — five push channels collapse into one plugin call, since Squirrel's state machine was the only reason they were separate | 4 |
| `restart-app` | renderer→main | **implemented, no IPC** — `tauri-plugin-process` `relaunch()` | 4 |
| `quit-app` | renderer→main | **implemented, no IPC** — `exit(0)` after the frontend has resolved application-state policy | 4 |
| `will-quit` | renderer→main | **implemented with direction reversed** — one `onCloseRequested` handler synchronously prevents close, then the frontend decides `quit` / `hide` / `cancel` | 4 |
| `will-quit-even-if-updating` | renderer→main | **implemented by the same decision point** — update state becomes frontend policy rather than a Rust flag | 4 |
| `cancel-quitting` | renderer→main | **implemented by returning `cancel`**; no second channel or mutable cross-process state survives | 4 |

**Notifications** (4)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `show-notification` | request/response | **no IPC** — `tauri-plugin-notification` | 4 |
| `get-notifications-permission` | request/response | **no IPC** — the plugin | 4 |
| `request-notifications-permission` | request/response | **no IPC** — the plugin | 4 |
| `notification-event` | main→renderer | the plugin's action listener — the vendored `desktop-notifications` addon goes away, and macOS and Linux gain notifications they never had | 4 |

**Deep links and the CLI** (4)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `url-action` | main→renderer | `tauri-plugin-deep-link` → `emit` | 4 |
| `cli-action` | main→renderer | `tauri-plugin-single-instance` → `emit` | 9 |
| `install-windows-cli` | renderer→main | command | 9 |
| `uninstall-windows-cli` | renderer→main | command | 9 |

**Configuration and the stats GUID** (5)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `get-main-process-config` | request/response | command | 4 |
| `update-main-process-config` | request/response | command | 4 |
| `get-config-migration-result` | request/response | **deleted, not ported** — guiding principle 6; there is no config migration to report | 4 |
| `save-guid` | request/response | command | 4 |
| `get-guid` | request/response | command | 4 |

**Logging, crashes and errors** (6)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `log` | renderer→main | **implemented through `tauri-plugin-log`** — the plugin writes stdout and the application log file; Phase 6 owns retention and what happens to a crash | 4 |
| `uncaught-exception` | renderer→main | command | 6 |
| `send-error-report` | renderer→main | command | 6 |
| `error` | main→renderer | `emit` from Rust | 6 |
| `crash-ready` | renderer→main | command — the separate crash `BrowserWindow` is what these serve, and Phase 6 replaces it outright | 6 |
| `crash-quit` | renderer→main | command | 6 |

**Network interception and certificates** (4)

| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| `update-accounts` | renderer→main | — (design work) — its only upstream purpose is feeding `installAuthenticatedImageFilter`, which Phase 5 replaces with fetching in Rust | 5 |
| `resolve-proxy` | request/response | — (design work) — **rehomed from Phase 4 to Phase 5.** `session.resolveProxy` is the same Electron `session` object as `webRequest`, so it belongs with the other session-level behaviours that need a redesign rather than a port. Phase 5 inherits `envForProxy`, `getFallbackUrlForProxyResolve` and `lib/parse-pac-string.ts` with it. **Consequence until then: no remote operation has proxy support.** | 5 |
| `certificate-error` | main→renderer | — (may have no equivalent) — wry exposes no certificate-error hook; verify on WebKitGTK before promising parity | 5 |
| `show-certificate-trust-dialog` | renderer→main | — (may have no equivalent) — macOS and Windows only upstream, and it is the recovery path for the above | 5 |

### 7.2 Git commands (no upstream channel)

The **command** side is measured rather than eyeballed: `scripts/measure-store-surface.mjs` checks the
rows below against `generate_handler!` and against upstream's store imports in both directions. It caught
`abort_hook` registered twice — which nothing else would have, since neither `clippy` nor the Tauri macro
says a word about a duplicate handler.

Each row's TypeScript wrapper lives in a `src/lib/*-ipc.ts` module grouped by domain, and the JSON
shape of everything it carries is pinned by a wire-contract test on the Rust side.

| Channel | Direction | Tauri command/event | Status |
|---|---|---|---|
| _(no direct equivalent — new)_ | request/response | `get_status` → `getStatus()` | **done** |
| _(new)_ | request/response | `create_commit` → `createCommit()` | **done** |
| _(new)_ | request/response | `create_merge_commit` → `createMergeCommit()` | **done** |
| _(new)_ | request/response + Channel | `checkout_branch` → `checkoutBranch()` | **done** |
| _(new)_ | request/response + Channel | `checkout_remote_branch` → `checkoutRemoteBranch()` | **done** |
| _(new)_ | request/response + Channel | `checkout_commit` → `checkoutCommit()` | **done** |
| _(new)_ | request/response | `checkout_paths` → `checkoutPaths()` | **done** |
| _(new)_ | request/response | `merge_branch` → `mergeBranch()` | **done** |
| _(new)_ | request/response | `get_merge_base` → `getMergeBase()` | **done** |
| _(new)_ | request/response | `abort_merge` → `abortMerge()` | **done** |
| _(new)_ | request/response + Channel | `rebase_branch` → `rebaseBranch()` | **done** |
| _(new)_ | request/response + Channel | `continue_rebase` → `continueRebase()` | **done** |
| _(new)_ | request/response | `abort_rebase` → `abortRebase()` | **done** |
| _(new)_ | request/response | `get_rebase_snapshot` → `getRebaseSnapshot()` | **done** |
| _(new)_ | request/response | `get_commits` → `getCommits()` | **done** |
| _(new)_ | request/response | `get_commit` → `getCommit()` | **done** |
| _(new)_ | request/response | `get_changed_files` → `getChangedFiles()` | **done** |
| _(new)_ | request/response | `get_index_changes` → `getIndexChanges()` | **done** |
| _(new)_ | request/response | `get_working_directory_diff` → `getWorkingDirectoryDiff()` | **done** |
| _(new)_ | request/response | `get_commit_diff` → `getCommitDiff()` | **done** |
| _(new)_ | request/response | `get_commit_range_diff` → `getCommitRangeDiff()` | **done** |
| _(new)_ | request/response | `discard_changes_from_selection` → `discardChangesFromSelection()` | **done** |
| _(new)_ | request/response | `get_branches` → `getBranches()` | **done** |
| _(new)_ | request/response | `get_branches_differing_from_upstream` → `getBranchesDifferingFromUpstream()` | **done** |
| _(new)_ | request/response | `delete_remote_branch` → `deleteRemoteBranch()` | **done** |
| _(new)_ | request/response | `add_safe_directory` → `addSafeDirectory()` | **done** |
| _(new)_ | request/response | `abort_hook` → `abortHook()` | **done** — stops a running hook by the id its progress update carried |
| _(new)_ | **URI scheme** | `rdc-blob://localhost/<token>` → `Image.url` | **done** — serves blob bytes to the webview; not a command, and deliberately so |
| _(new)_ | request/response | `create_branch` → `createBranch()` | **done** |
| _(new)_ | request/response | `rename_branch` → `renameBranch()` | **done** |
| _(new)_ | request/response | `delete_local_branch` → `deleteLocalBranch()` | **done** |
| _(new)_ | request/response | `get_branches_pointed_at` → `getBranchesPointedAt()` | **done** |
| _(new)_ | request/response | `get_merged_branches` → `getMergedBranches()` | **done** |
| _(new)_ | request/response | `delete_ref` → `deleteRef()` | **done** |
| _(new)_ | request/response | `get_symbolic_ref` → `getSymbolicRef()` | **done** |
| _(none — pure)_ | — | `formatAsLocalRef` → `src/lib/refs.ts` | **done** — a string from a string, so TypeScript rather than a round trip |
| _(new)_ | request/response | `reset` → `reset()` | **done** |
| _(new)_ | request/response | `reset_paths` → `resetPaths()` | **done** |
| _(new)_ | request/response | `unstage_all` → `unstageAll()` | **done** |
| _(new)_ | request/response | `unstage_all_files` → `unstageAllFiles()` | **done** — `rm --cached`, not a reset |
| _(new)_ | request/response | `stage_resolved_conflict_files` → `stageResolvedConflictFiles()` | **done** |
| _(new)_ | request/response | `get_ahead_behind` → `getAheadBehind()` | **done** |
| _(none — pure)_ | — | `revRange`, `revRangeInclusive`, `revSymmetricDifference` → `src/lib/rev-range.ts` | **done** — string concatenation |
| _(none — no git)_ | — | `getBranchAheadBehind` → `src/lib/rev-list-ipc.ts` | **done** — answers `null` for a remote or upstream-less branch without asking git |
| _(new)_ | request/response | `get_branch_merge_base_diff` → `getBranchMergeBaseDiff()` | **done** |
| _(new)_ | request/response | `get_branch_merge_base_changed_files` → `getBranchMergeBaseChangedFiles()` | **done** — `null` for unrelated histories |
| _(new)_ | request/response | `get_commit_range_changed_files` → `getCommitRangeChangedFiles()` | **done** |
| _(new)_ | request/response | `get_config_value` → `getConfigValue()` | **done** |
| _(new)_ | request/response | `read_gitignore_at_root`, `save_gitignore`, `append_ignore_rules`, `append_ignore_files` | **done** — patterns are sent as written, file names are escaped |
| _(new)_ | request/response | `install_global_lfs_filters`, `install_lfs_hooks`, `is_using_lfs` | **done** — the global one takes no repository |
| _(new)_ | request/response | `determine_mergeability` → `determineMergeability()` | **done** — answered in the object database, so no side effects |
| _(new)_ | request/response | `get_repository_type` → `getRepositoryType()`, with `RepositoryType` → **`src/models/repository-type.ts`** | **done** |
| _(new)_ | request/response | `is_cherry_pick_head_found`, `get_rebase_internal_state` | **done** — both resolve the git directory themselves |
| _(new)_ | request/response | `checkout_index` → `checkoutIndex()` | **done** |
| _(new)_ | request/response | `get_trailer_separator_characters`, `parse_trailers`, `merge_trailers` | **done** |
| _(new)_ | request/response | the six `*_worktree*` commands → `src/lib/worktree-ipc.ts` | **done** — three listing entry points, because a linked worktree's `.git` is a file elsewhere |
| _(new)_ | request/response + Channel | `push` → `push()` | **done** |
| _(new)_ | request/response + Channel | `fetch` → `fetch()` | **done** |
| _(new)_ | request/response | `fetch_refspec` → `fetchRefspec()` | **done** — no Channel; one ref, and a missing refspec resolves |
| _(new)_ | request/response + Channel | `pull` → `pull()` | **done** |
| _(new)_ | request/response | `fast_forward_branches` → `fastForwardBranches()` | **done** |
| _(new)_ | request/response + Channel | `clone` → `clone()` | **done** |
| _(new)_ | request/response | `get_remotes` → `getRemotes()` | **done** |
| _(new)_ | request/response | `add_remote` → `addRemote()` | **done** |
| _(new)_ | request/response | `remove_remote` → `removeRemote()` | **done** |
| _(new)_ | request/response | `set_remote_url` → `setRemoteURL()` | **done** |
| _(new)_ | request/response | `get_remote_url` → `getRemoteURL()` | **done** |
| _(new)_ | request/response | `update_remote_head` → `updateRemoteHEAD()` | **done** |
| _(new)_ | request/response | `get_remote_head` → `getRemoteHEAD()` | **done** |
| _(new)_ | request/response | `get_stashes` → `getStashes()` | **done** |
| _(new)_ | request/response | `create_stash_entry` → `createStashEntry()` | **done** |
| _(new)_ | request/response | `drop_stash_entry`, `pop_stash_entry` | **done** |
| _(new)_ | request/response | `rename_stash_entry`, `move_stash_entry` | **done** |
| _(new)_ | request/response | `get_last_stash_entry_for_branch`, `get_stashed_files` | **done** |
| _(new)_ | request/response + Channel | `cherry_pick`, `continue_cherry_pick` | **done** |
| _(new)_ | request/response | `get_cherry_pick_snapshot`, `abort_cherry_pick` | **done** |
| _(new)_ | request/response | `list_submodules` → `listSubmodules()` | **done** |
| _(new)_ | request/response | `reset_submodule_paths` → `resetSubmodulePaths()` | **done** |
| _(new)_ | request/response + Channel | `squash` → `squash()` | **done** |
| _(new)_ | request/response + Channel | `reorder` → `reorder()` | **done** |
| _(new)_ | request/response | `create_tag`, `delete_tag`, `get_all_tags` | **done** |
| _(new)_ | request/response + Channel | `revert_commit` → `revertCommit()` | **done** |
| _(new)_ | request/response | `get_recent_branches`, `get_branch_checkouts` | **done** |
| _(new)_ | request/response | `get_description`, `write_description` | **done** |
| _(new)_ | request/response | `get_author_identity`, `clean_untracked_files` | **done** |

---

## 8. Deliberate deviations from a verbatim port

### The application menu is serializable frontend data, not Electron click closures

Upstream constructs `Electron.MenuItemConstructorOptions` in the main process, attaches click closures,
then serializes the resulting `Electron.Menu` back to the renderer for the custom Windows/Linux menu.
rdc builds `src/lib/menu/default-menu.ts` directly as the `src/models/app-menu.ts` tree. Executable
items carry a discriminated `MenuAction` value, while keybindings remain a separate Rust-owned map keyed
by item ID. This is what lets the same state-derived tree drive React and, after `renderer-ready`, the
native macOS menu without duplicating frontend policy in Rust.

Three implementation details are intentional consequences:

- role-derived accelerated items (`quit`, `select-all`, and zoom) receive explicit stable IDs so the
  50-entry binding map can address them;
- the Linux/Windows listener runs in the capture phase because Chromium otherwise consumes shortcuts
  such as Ctrl+A before the application menu sees them;
- matching uses physical `KeyboardEvent.code`, while display text is derived from the same structured
  binding. Keyboard layout therefore cannot make native and webview consumers interpret different keys.

`scripts/measure-menu-accelerators.mjs` now checks the chain end-to-end: 52 ordered upstream
declarations, 50 logical binding IDs, and all 50 IDs present in the TypeScript menu source.

The surviving macOS `menu-event` changes payload from an upstream `MenuEvent` string to the complete
structured `MenuAction`. That is necessary for actions such as opening documentation, zoom and quit,
which Electron previously implemented as main-process closures. Rust stores the action attached to each
native item ID and emits it unchanged. `src/lib/menu/startup.ts` now replaces the bootstrap from the
current React harness, after registering the action listener. It enables only behavior available today:
native roles, external links, Select All, zoom, reload and one-window quit. Stateful repository/UI
actions stay visibly disabled until Phase 7 connects the same action type to its dispatcher. Before
`set_native_menu` marks the renderer ready, the bootstrap quit action exits in Rust so the app cannot
become unquittable during startup.

General contextual menus keep upstream's request/response contract. The renderer removes callback
functions before invoking `show_contextual_menu`; Rust assigns collision-free native IDs, recursively
builds ordinary, separator, checkbox and submenu items, and returns the selected item's nested index
path so the renderer invokes the original callback. muda's popup is synchronous while Tauri forwards
its selection through the event-loop proxy, so Rust queues a main-thread dismissal marker after the
popup returns: an earlier selection event resolves the request first, while dismissal resolves `null`.
The Linux-container WebDriver suite now exercises that complete boundary with a nested selection and
an Escape dismissal against the real debug application. It uses `xdotool` only inside the accepted
Xvfb harness to operate GTK's native popup; this is IPC/native-menu plumbing evidence, not Wayland
rendering evidence. The macOS default menu was separately verified by launching `pnpm tauri dev`.

Two text-input additions are deliberately Phase 7 rather than incomplete Phase 4 menu work.
`addSpellCheckMenu` currently fails explicitly, and the `editMenu` placeholder does too. The former
needs a WebKitGTK suggestions investigation; the latter cannot use muda's Linux predefined edit
actions on the Wayland-only primary target because their implementation uses X11 key injection and
contains an explicit Wayland TODO. Phase 7 owns both alongside the inputs that consume them.

### Native file operations split on policy, not on API availability

Paths, dialogs and ordinary opener calls stay in TypeScript because Tauri already exposes them with
window-scoped capabilities. Two operations remain Rust-owned: trash must be recoverable, so the
`trash` crate runs off the main thread; and opening folder contents needs filesystem/application
metadata because a macOS directory may be an executable `.app`. A failed `mdls` query therefore
reveals the item instead of opening it, preserving upstream's conservative failure mode.

The opener path permission intentionally covers arbitrary filesystem paths. Repositories and
user-selected executables are not confined to `$HOME`, and narrowing the capability to a guessed set
of roots would make valid repositories silently unopenable. This is still narrower than filesystem
read/write permission: it authorizes only handing a path to its registered OS application.

Tauri's dialog plugin does not expose Electron's `buttonLabel`, `nameFieldLabel`, `message`,
`showsTagField`, or hidden-file presentation flags. The adapters accept those fields so Phase 7
callers retain their source shape, but pass only title, initial path, filters, directory/multiple and
directory-creation behavior. **Consequence:** the macOS clone chooser uses the native default save
button/name-field presentation rather than `Select` / `Clone As:`; the selected path and cancellation
contract are unchanged.

### Application close is one frontend decision, not three renderer-to-main flags

Electron set `quitting` and `quittingEvenIfUpdating` flags synchronously in the main process, then
consulted them during a later `BrowserWindow.close`. Tauri delivers a preventable close request to the
renderer instead. `src/lib/platform/lifetime.ts` prevents that event before awaiting anything and lets
frontend policy resolve it as `quit`, `hide` or `cancel`; repeated close requests coalesce while that
decision is pending. Explicit quit and restart reach `tauri-plugin-process` only after the caller has
resolved the same application-state policy.

**Consequence:** `will-quit`, `will-quit-even-if-updating` and `cancel-quitting` disappear together
instead of becoming commands, so there is no cross-process state to race or reset. macOS keeps
upstream's hide-on-close default. Linux and Windows default to quitting until Phase 4b's
`hideWindowOnQuit` config is available, at which point the same decision function can return `hide`
without changing the native boundary.

### A new repository window receives its startup action through readiness

Upstream's explicit `open-repository-in-new-window` handler always constructs a fresh window, waits
for its page load, then sends an `open-repository` CLI action with `persistSelection: false`. It does
not consult `findWindowForRepositoryPath` or normalize the requested path; those operations belong to
external CLI/open-event routing.

rdc creates a uniquely labelled webview from the same hidden `main` template and queues the structured
startup action in Rust under that label. The target renderer's existing `renderer-ready` command takes
and returns it exactly once, after restoring and showing the window. **Consequence:** the path and
`persistSelection: false` semantics are unchanged, but delivery is a command response instead of a
post-load push event. This removes the emit-before-listener race and keeps Phase 9's external
`cli-action` stream out of the Phase 4a boundary. Destroying a window discards any unclaimed action.

When more than one application window exists, the preventable close decision destroys only the
requesting window. The last window retains the platform hide/quit policy described above.

### Startup chrome reads rdc's config before the main window exists

`tauri.conf.json` keeps `main` as a `create: false` template. During setup Rust reads
`app_config_dir/main-process-config.json`, applies the platform decision, and only then constructs the
webview. This preserves upstream's load-bearing synchronous ordering without moving config into
webview storage. The matrix is also upstream's: macOS always uses native overlay chrome, Windows is
always frameless, and only Linux consults `native` / `custom` / `native-without-menu-bar`.

The filename and directory are intentionally rdc-owned under guiding principle 6; Desktop Plus's
`.main-process-config` is not imported. **Consequence:** an existing Desktop Plus title-bar preference
does not carry over. A missing or unknown value defaults to `native`, while malformed JSON fails
startup as upstream's synchronous `JSON.parse` did. `native-without-menu-bar` already selects native
decorations. The Phase 4a menu-state bridge is now in place; suppressing Phase 7's frontend-rendered
Linux menu still needs the typed Phase 4b config surface, because Tauri's window builder has no
Electron-style `autoHideMenuBar` property.

### Three ported functions have no command, on purpose

`git-ops` implements all three and their tests pass — the port followed upstream's test suite, which is
the right rule. What they don't get is IPC surface, because nothing calls them:

| Function | Why no command |
|---|---|
| `get_authors` | upstream's `getAuthors` has **no caller anywhere**, not even a test — dead since some earlier refactor |
| `fetch_tags_to_push` | upstream calls it only from `app/test/unit/git/tag-test.ts`; the tags-to-push indicator reads local storage instead |
| `stage_manual_conflict_resolution` | **internal** to upstream's `lib/git`, called by `stageFiles` and `cherry-pick.ts` — and internal here too, since `create_merge_commit`, `continue_rebase` and `stage_resolved_conflict_files` stage resolutions themselves |

All three had commands, wrappers and tests until the Phase 3 re-measure asked the question the other way
round: not "is every consumer served?" but "does every command have a consumer?". A command is a wire
contract to keep working across two languages, so one nobody calls is pure liability. Add them back the
moment a caller exists — the function underneath is ready.

### A resolved conflict crosses as one shape, carrying its index entries

Three operations stage a side the user picked — concluding a merge, continuing a rebase, and staging
before a checkout — and upstream passed each of them a `WorkingDirectoryFileChange`, reading
`status.entry` off it inside `stageManualConflictResolution`. That is view state, so this port carries the
two entries directly in `stage::ManualResolution` (`{ path, resolution, entries? }`), which the frontend
fills from the status it already holds.

**`create_merge_commit` originally took `(path, resolution)` pairs, and that lost the entries.** The
entry-less path can only mean "check out the chosen side's content and add it", which cannot express a
side that *deleted* the file — and `git checkout --ours/--theirs` refuses such a path outright:

```
error: path 'foo' does not have their version
```

So a modify/delete conflict resolved in favour of the deleting side did not merely stage the wrong thing,
it made the merge **uncommittable**. `continue_rebase` had carried the entries since it was written; the
merge path had not, and nothing failed because no test covered that combination. It does now —
`commit::tests::a_merge_commit_stages_a_chosen_deletion_as_a_deletion`, with a fixture that builds the
modify/delete conflict and git as the oracle on the resulting tree.

`RebaseConflictResolution` was the same three fields under a name that claimed only one caller; it is
gone, and `ManualResolution` lives in `stage.rs` where the staging does.

### `parse_single_unfolded_trailer` exists in both languages

The Rust copy is used by `parse_raw_unfolded_trailers`, which reads a whole commit message. The
TypeScript copy in `src/models/trailer.ts` is what `git-store` needs, because it scans a message **one
line at a time** — a command there would be a round trip per line. Two implementations of eight lines
beats an IPC call in a loop, and `src/models/trailer.test.ts` runs the same cases as the Rust unit tests
so they can't drift apart quietly.

Both fix the same upstream bug while they're at it: the original advanced past the separator by one
UTF-16 unit, so a separator outside the BMP left half a surrogate pair at the front of the value.

### IPC uses Tauri's native mechanism, with no binding generator

**Evaluated and decided, not assumed.** ts-rs was prototyped against the real types before this was
settled; the prototype is why the answer is no. See "Why not a generator" below.


The plan originally called for `tauri-specta`/`ts-rs` to generate TypeScript from the Rust command
signatures. rdc instead uses **plain `#[tauri::command]` + `invoke`**, with events and Channels for
the Rust→frontend direction.

The cost is that `src/lib/git-ipc.ts` is hand-written, which is the same manual-contract problem
`ipc-shared.ts` had. The mitigation is that **the contract is enforced in Rust**:
`crates/git-ops/tests/wire_contract.rs` asserts the exact JSON of every type crossing the boundary,
and `src/App.test.tsx` pins the command name and its camelCase argument names. A rename on either
side fails a test rather than silently producing `undefined` in the webview.

Two consequences worth knowing before writing more commands:

- **Commands return `CommandError`, not `String`.** Tauri requires the error type to `Serialize`;
  the reflexive `.map_err(|e| e.to_string())` would discard `GitErrorKind`. `CommandError` keeps the
  classified `kind` alongside the message, which is what allows user-facing wording to stay in the
  frontend (see `getDescriptionForError` below).
- **Streaming output uses a `Channel`, not `app.emit`.** Tauri's docs say events are unsuited to
  high-throughput data. Progress streams and the commit terminal stream therefore use command-scoped
  Channels. The latter exists for `create_commit`, the only operation whose terminal callback has a
  production consumer upstream; optional, unconsumed callbacks on merge/rebase/push are not speculative
  wire surface, and pull's declared callback is not wired upstream at all.

### `getGitDescription` used a path that can't exist in a worktree or submodule

The original joined `<repository>/.git/description`. In a **linked worktree** or a **submodule** `.git` is
a *file* pointing elsewhere, so that path isn't a directory at all — and because a read failure meant "no
description", it silently returned `""` rather than failing visibly.

Verified against real git: the file lives in the **common** directory. Note `--absolute-git-dir` is the
wrong question — in a worktree it reports `.git/worktrees/<name>`, which has no `description`. The port
asks `rev-parse --git-common-dir`, with a test that reads a description from inside a linked worktree.

### `RevertProgressParser` was a no-op by construction

Not a bug so much as something worth knowing before anyone "fixes" the port. It was a `GitProgressParser`
with a single step `{ title: '', weight: 0 }`, and both halves are inert: an empty title can never match,
because the line parser requires a non-empty one; and a zero total weight makes the normalisation
`weight / totalWeight` a `0/0` NaN. So every line fell through to *context* carrying the unchanged
`lastPercent` — zero.

A revert therefore reported `value: 0` with an empty title, always, and the parser existed only to route
git's output into the description. The port can't reproduce it literally — `GitProgressParser::new`
asserts a non-zero total weight rather than silently producing NaN — so it streams the lines and reports
the same thing directly.

### `listSubmodules` silently dropped uninitialized and conflicted submodules

The original parsed `git submodule status` with `/^.([^ ]+) (.+) \((.+?)\)$/gm`, which **requires** a
parenthesised `git describe` value. Verified against real git: that part is printed only for a submodule
that is checked out. An **uninitialized** submodule is reported as `-<sha> <path>` and a **conflicted**
one as `U<sha> <path>`, neither with it — so neither matched, and both vanished from the list.

That is a safety issue rather than a display one. `git-store`'s discard-changes path uses this list to
decide whether a changed path is a submodule, because a submodule must be **reset** rather than moved to
the trash — so an omission removes that protection for exactly the submodules most likely to need it.

`describe` is therefore `string | null` in `src/models/submodule.ts` (the original typed it `string`) and
every entry is reported. The leading status character is still discarded, as upstream did.

### `getStashes` under-reported the stash count by one

`getStashes` returned `entries.length - 1` as the total number of stash entries. Verified against real
git: three stashes produce three parsed records, so it reported two — and with exactly **one** stash it
reported **zero**, which the UI would read as "no stashes at all". Fixed, with tests for both the
three-stash and one-stash cases.

### `createDesktopStashEntry` guessed whether a stash was created

The original inferred success from the exit code and stderr: exit 1 with no line beginning `error: ` was
taken to mean a stash *was* created. Its own comment documented that this doesn't hold — an unborn
repository exits 1 having created nothing — and explicitly declined to fix it ("I'm not going to mess
with this now").

The port asks git instead: `refs/stash` is read before and after, and a stash was created exactly when
that ref changed. No inference, and the unborn-repository case falls out correctly.

### Two dead guards in `cherry-pick`, from missing `await`s

`isCherryPickHeadFound` is `async`. `getCherryPickSnapshot` wrote `if (!isCherryPickHeadFound(repo))`,
which negates a `Promise` — always falsy, so the guard never fired. `continueCherryPick` wrote
`if (await !isCherryPickHeadFound(repo))`, which awaits `false`. Both checks were dead code.

The first was benign, because the `try`/`catch` around the sequencer reads returned `null` anyway. The
second was not: continuing with no cherry-pick in progress fell through to running git. Both are real
checks in the port, each with a test.

### `GIT_CLONE_PROTECTION_ACTIVE=false` on clone — preserved, deliberately

`clone` sets this, which disables a git check. Worth being precise about *which* one, because it looks
alarming and is a defensible tradeoff rather than the mistake the SSH fingerprint was.

git 2.45 shipped the fix for **CVE-2024-32002** — a malicious repository whose submodule could write
into `.git/hooks` and get code executed during `clone --recursive`. Alongside the fix it added a
*defense-in-depth* layer: refuse to clone when the repository being cloned has hooks that would run.
This variable turns off **that layer only**; the CVE fix itself is unconditional and still in force.

The check is known to break `git clone` for repositories using Git LFS, and that cannot be worked
around on the LFS side. So the choice is between a belt-and-braces check and cloning LFS repositories
at all. The original chose the latter and the port keeps it — but it is documented at the call site
rather than left as an unexplained environment variable, so it can be revisited deliberately.

### SECURITY: the SSH host-key auto-accept trusted a retired, leaked GitHub key

The askpass handler auto-accepted one github.com fingerprint without prompting:
`SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8`. **GitHub rotated that RSA host key in March
2023**, after its private half was briefly exposed in a public repository. It no longer appears in
GitHub's published fingerprints — verified against
<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>.

Two consequences. The benign one: github.com presents a different key now, so the auto-accept never
fired and users were prompted anyway. The one that matters: anyone holding the leaked private key
could present the retired key to a client, and this code would have trusted it **silently, with no
prompt** — reinstating a key GitHub had deliberately revoked.

The port pins GitHub's three current fingerprints (RSA, ECDSA, Ed25519) and keeps the retired one in a
`RETIRED_GITHUB_FINGERPRINTS` constant purely so a test can assert it is never accepted, at the unit
level and end-to-end through the real trampoline binary.

### `addSafeDirectory` failed for a path containing a regex metacharacter

The existence check before appending was:

```ts
const { stdout, exitCode } = await git(
  ['config', '--global', '-z', '--get-all', name, value],
  __dirname, 'addGlobalConfigValue',
  { successExitCodes: new Set([0, 1]) }
)
```

That trailing `value` is a **value-pattern**, which git treats as a *regular expression* unless
`--fixed-value` is passed. Verified against real git 2.50:

```
$ git config --global -z --get-all safe.directory '/tmp/a(b'
error: invalid pattern: /tmp/a(b        # exit 6
$ git config --global -z --get-all --fixed-value safe.directory '/tmp/a(b'
                                        # exit 1 — absent, as intended
```

Exit 6 is outside the accepted set, so the call rejected and `addSafeDirectory` never ran.

**Consequence upstream:** `addSafeDirectory` is the *only* remedy for git's "dubious ownership"
refusal, and it is reached from `missing-repository.tsx` and `add-existing-repository.tsx` — the
recovery path. A directory named `app (old)`, `notes [archive]` or `v2+` is perfectly ordinary, so a
user with such a path could be told their repository is unsafe and then be unable to do anything about
it from the app. Fixed with `--fixed-value` in `crates/git-ops/src/config.rs`, with tests including the
metacharacter case and an end-to-end check that git really does start working afterwards.

`--fixed-value` also makes the comparison exact, which is what the original did afterwards in
JavaScript (`stdout.split('\0').includes(value)`) to compensate for the pattern possibly matching a
*different* stored value. git does that now, so the exit code alone answers the question — and a
regression test covers `/repos/a.b` versus `/repos/axb`, which the pattern form would have conflated.

### A `"*"` hook filter returned no hooks at all

`getRepoHooks(path, filter)` documents `filter` as "an optional array of hook names to filter the
results. Including '*' will return all hooks." The loop then began:

```ts
const matchAll = filter?.includes('*')
for (const file of files) {
  const hookName = basename(file.name, '.exe')
  if (matchAll || filter?.includes(hookName) === false) {
    continue
  }
```

`matchAll` is on the **skip** side of the condition, so asking for all hooks skipped every one of them
and returned an empty list. It needed `!matchAll`.

**Consequence upstream:** nothing today, because every caller passes an explicit list of hook names —
`commit.ts`, `merge.ts`, `push.ts` and `pull.ts` all do. But `withHooksEnv` treats an empty result as
"this repository has no hooks" and skips interception entirely, so a caller that reached for the
documented `'*'` would have got silently unhooked git invocations rather than an error. Fixed in
`crates/git-ops/src/hooks/discovery.rs`, with a test.

### `DiffHunkHeader.equals` now compares `newLineCount`

The original's fourth comparison was `this.oldStartLine === other.oldStartLine` — a repeat of the
first — so **`newLineCount` was never compared**. Two hunk headers differing only in how many lines
they cover on the new side compared as equal. Present in `desktop-plus` and carried into rdc's Phase 1
port of `models/diff/raw-diff.ts`; fixed with a regression test in `src/lib/diff-ipc.test.ts`.

### `createCommit` returns a full SHA, not `"(root-commit)"`

The original's `parseCommitSHA` did `stdout.split(']')[0].split(' ')[1]` on git's summary line. For
`[main 1a2b3c4] message` that yields an abbreviated SHA; for a repository's **first** commit git
prints `[main (root-commit) 1a2b3c4]`, so it yields the literal string `"(root-commit)"`.

Verified against real git. The original's own test suite asserted
`assert.equal(sha, '(root-commit)')` — the bug was pinned as expected behaviour rather than caught.

The port runs `rev-parse HEAD` instead of parsing git's prose, and returns the full 40-character SHA,
consistent with every other SHA in the codebase.

#### Why not a generator

The candidates, checked in July 2026:

| | Generates | Status | Native `invoke`? |
|---|---|---|---|
| **ts-rs** | types only | 12.0.1 stable, 4.0M dl/90d | yes |
| **tauri-specta** | types + command wrappers + events | 2.0.0-**rc.25**, 445k dl/90d | no — replaces `generate_handler!` |
| **typeshare** | types only | 1.0.5, static analysis | yes |
| **tauri-bindgen** (official org) | WIT bindings | "under heavy development", not on crates.io | n/a |

There is no official Tauri answer, so "idiomatic" means convention, not endorsement. `tauri-specta`
is healthy but swaps `tauri::generate_handler!` for its own builder and a generated `commands.*`
client — that *is* the generator layer we're avoiding. `typeshare` loses cross-crate information,
and our boundary types live in `git-ops` and surface through the app crate.

**ts-rs was the real candidate, and it fails on a specific, structural mismatch.** It handles every
serde representation we use correctly — the internally-tagged struct emits `kind: "conflicted"`, the
untagged enum works, `rename_all_fields` works, `skip_serializing_if` + `default` yields `?:`. But its
output is *not assignable to the ported models*, because it emits string-literal unions where the
ported TypeScript uses `enum`:

```
export type GitStatusEntry = "M" | "A" | "U"       // ts-rs
export enum GitStatusEntry { Modified = 'M', … }   // ported models/status.ts
```

TypeScript string enums are **nominal**. `"Modified"` is not assignable to
`AppFileStatusKind.Modified`, so the generated `AppFileStatus` cannot stand in for the ported one —
verified with `tsc`, not assumed. It also emits `T | null` for `Option` where the ported types use
optional properties.

The underlying reason is a premise clash, and it is specific to this project. **A Rust→TS generator
assumes Rust owns the domain model. Here TypeScript owns it**: `src/models/**` holds 50+ types ported
from the original — `commit.ts`, `branch.ts`, `remote.ts`, `stash-entry.ts`, `submodule.ts` — which
are exactly what the remaining commands return, and which the ported UI already consumes. Generating
would mean either a second definition of every domain type (the bug above, now automated) or
rewriting ported models to suit the generator. Both are worse than writing the wrapper by hand.

#### What replaces the generator

The problem was never that types are hand-written — it was that **nothing compared the wire shape to
the domain model**. That is now a closed loop with no hand-copied JSON:

1. `wire_contract.rs` emits Rust's real serializer output to
   `src/lib/__generated__/wire-snapshot.json` (regenerate with `UPDATE_WIRE_SNAPSHOT=1`).
2. `src/lib/git-ipc.test.ts` declares fixtures **annotated with the ported types**, so `tsc` rejects
   any shape `src/models/**` would not accept.
3. That test asserts each fixture equals its snapshot entry, and runs the ported consumers
   (`mapStatus`, `isConflictWithMarkers`) over them.

Rust drifting from the domain model fails step 3; a fixture edited to match a bad shape fails step 2.
Verified by reintroducing the flattened conflict into the snapshot and confirming the suite goes red.

Serialization was also chosen to **reuse the already-ported TypeScript enums** rather than duplicate
them: `AppFileStatus` is `#[serde(tag = "kind")]` (internally tagged), which reproduces the original
discriminated union exactly, while `ConflictedFileStatus` is `untagged` because the original
discriminated its two shapes by the presence of `conflictMarkerCount`. `Option` fields use
`skip_serializing_if` so they are absent rather than `null`, matching TS optional properties.


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
| `vite.config.ts` | production minification uses Vite 8's Oxc default rather than the scaffold's explicit esbuild override | Vite 8 made esbuild optional and deprecated `build.minify: "esbuild"`. Installing it did not restore the build: esbuild cannot perform the configured Safari 13 destructuring transform. Oxc supports the target, needs no extra install script, and makes `pnpm build` green; debug Tauri builds remain unminified. |
| `src/lib/fonts/installed-fonts.ts` | `import { uniq } from 'lodash'` → `[...new Set(families)]` | Utility policy is native → Radash → Lodash (see `DEVELOPMENT.md`). A single `uniq()` on a `string[]` doesn't justify the dependency; lodash v4 is a 2016 release with v5 unreleased, so its vulnerability-response time is the real risk. If lodash ever *is* required, pin >= 4.18.1. |
| `src/models/accessible-message.ts` | added `import type { JSX } from 'react'` | React 19 removed the global `JSX` namespace the file relied on under React 16. `models/banner.ts` has the same issue and will need the same fix whenever it's unblocked. |
| `crates/git-ops/src/init.rs` (Phase 2) | `init_repository` takes `default_branch` as a parameter; the original `initGitRepository(path)` called `getDefaultBranch()` internally | That helper reads the user's **global** `init.defaultBranch` and falls back to `"main"` — ambient machine configuration plus app policy, reached from inside a low-level git call. It made the function's result depend on the developer's machine, and made the original test tautological: it asserted the branch equalled `getDefaultBranch()`, the very function the code called, so it could not have caught the argument being ignored. Resolution now belongs to the caller; the config lookup + fallback lands with `config.rs`. |
| `crates/git-ops/src/add.rs` (Phase 2) | test asserts via `git ls-files -u` instead of the app's status parser | The original used `getStatusOrThrow`, and `lib/git/status.ts` isn't ported. Querying git's index directly is the same behavioural claim ("no longer an unmerged entry") while using git as the oracle rather than another unported module. |
| `crates/trampoline/src/token.rs` (Phase 2) | constant-time token comparison, where the original used `Set.has` | The token is the only thing separating git-invoked-by-us from any other local process that found the loopback port, so a timing oracle on a live token is worth closing — it costs nothing. Also `scoped()` revokes through a drop guard rather than a `finally`, so revocation survives a panic/unwind as well as an error. |
| `crates/trampoline/src/bin/rdc-trampoline.rs` (Phase 2) | reads stdin **only** for the credential helper | Askpass invocations are given no stdin. Reading it unconditionally would block until git closed the pipe, deadlocking the credential prompt — the kind of bug that only appears in the two-process case, so there is a timeout-guarded end-to-end test for it. Diagnostics go to stderr, never stdout, because git treats the binary's stdout as the credential itself. |
| `rdc/src/lib/ssh/ssh-host-prompt.ts` (Phase 2) | `parseAddSSHHostPrompt` extracted out of `lib/ssh/ssh.ts` | **Sixth instance of the co-located-declaration pattern.** A pure regex parser sat next to `getSSHEnvironment`, which imports the trampoline paths and `pathExists` (`fs`), so the test for the parser was blocked behind the whole trampoline module. |
| `rdc/src/lib/multi-commit-operation.ts` (Phase 2) | two parameter types **narrowed to the subset each function reads** | The originals declared `IRepositoryState` and `IMultiCommitOperationState` from the 1,319-line `app-state.ts`, but the functions read only `state.branchesState` and `state.step.kind`. Naming the god-module types meant two field reads depended on the whole module — and through it on `lib/git/config` and `ui/lib/application-theme`. TypeScript is structurally typed, so **callers are unaffected**: a full `IRepositoryState` still satisfies `RepositoryStateForChooseBranch`. Naming a large state type when you read one field of it is how a god module acquires its gravity — worth checking for elsewhere. |
| `rdc/src/models/repository.ts` (Phase 2) | **redesigned**: `Repository` is a plain data type. `url` is a readonly constructor field instead of a self-resolving getter, and `resolvedGitDir` is removed. | The original `url` getter was synchronous but fired an un-awaited `getRemotes()` subprocess, so the first read always returned `null`, every read before it settled spawned *another* `git remote`, and the promise had no `.catch`. Making `url` data means **a data type cannot do IO, so the bug is unrepresentable rather than fixed**. `url` is excluded from `hash` on purpose: two repositories differing only in a value fetched from git are the same repository. `resolvedGitDir` was `gitDir ?? join(path, '.git')`, wrong for worktrees/submodules where `.git` is a file; every consumer was in `lib/git/**` or `git-store.ts` (all Rust-bound) and Rust resolves it properly via `rev_parse::resolve_git_dir`. Unblocked 5 tests. |
| `rdc/src/lib/path-utils.ts` (Phase 2) | a local `basename` replaces Node's `path` in three models | Node's `path` doesn't exist in a webview and a polyfill isn't worth two `basename` calls. Tested against `node:path/posix` rather than hand-written expectations, which caught a real surprise: Node compares the suffix to the **entire path**, so `basename('.git', '.git')` is `''` while `basename('/foo/.git', '.git')` is `'.git'`. Reproduced deliberately, since callers may rely on it. Deliberately provides **no `normalize`/`resolve`** — `..`-beyond-root, drive letters and UNC paths are where hand-rolled path code goes wrong, so those belong in Rust's `std::path`. |
| `rdc/src/models/custom-integration.ts` (Phase 2) | `ICustomIntegration` extracted out of `lib/custom-integration.ts` | **Fourth instance of the co-located-declaration pattern.** A pure `{ path, arguments, bundleID? }` interface sat in a module importing `child_process`, `fs`, `fs/promises`, `util` and `windows-argv-parser`; `models/editor-override.ts` needed only the shape, and `models/repository.ts` inherited that Node tree through it. |
| `rdc/src/lib/markdown-filters/issue-reference.ts` (Phase 2) | regex constants extracted out of `issue-mention-filter.ts` | `lib/pull-request-refs.ts` needs only `IssueReference`, and because it's a `RegExp` **value** rather than a type it cannot be erased at compile time. That one import pulled in the filter class → `node-filter.ts`'s pipeline builder → `EmojiFilter` → `fs/promises`: four hops from a regex to filesystem access. When `issue-mention-filter.ts` is ported in Phase 7 it must import these from here rather than redeclaring them. |
| `crates/git-ops/src/interpret_trailers.rs` + `rdc/src/models/trailer.ts` (Phase 2) | the module is **split across the language boundary** rather than ported wholesale | `models/commit.ts` imported only `ITrailer` and `isCoAuthoredByTrailer` from it — a plain string pair and a case-insensitive comparison, neither of which needs git. That single edge dragged the entire git layer into the commit model and kept `create-branch` and `pull-request-refs` blocked for two phases. Splitting it unblocked `create-branch` outright. Also note `parse_single_unfolded_trailer` advances by `separator.len_utf8()` where the original used `ix + 1`: the original's index was in UTF-16 units, so a multi-byte separator character would have corrupted the value. Covered by a test. |
| `crates/git-ops/src/diff.rs` (Phase 2) | **fixes an upstream bug** in `binaryListRegex` | The original `-\t-\t(?:\0.+\0)?([^\0]*)` captures an **empty string** for a renamed binary file. Real `git diff --numstat -z` output for a rename is `-\t-\t\0old.bin\0new.bin\0`, and the greedy `.+` swallows both paths (`\0` isn't a line terminator, so `.` matches it) before the trailing `\0`. Confirmed in Node: upstream yields `[""]`, the fix yields `["new.bin"]`. **Consequence upstream:** a renamed binary is never recognized as binary, so a conflict involving one is treated as text and the UI hunts for conflict markers that cannot exist. Fixed with `[^\x00]*`, covered by a unit test and an end-to-end test driven by real git. |
| `crates/git-ops/src/status.rs` (Phase 2) | returns git facts only — no `WorkingDirectoryFileChange`, `DiffSelection` or `WorkingDirectoryStatus` | Those are **view state**, not git data: `DiffSelection` is the set of lines/files the user has ticked for staging, initialized here and then mutated by the UI. Inventing a Rust representation of something only the frontend mutates would put selection state on the wrong side of the IPC boundary. The frontend builds them from `StatusResult`. The one piece of that logic worth keeping is preserved as `StatusFileChange::starts_unselected`, carrying the original's rule that a dirty submodule whose own commit hasn't changed starts unticked. |
| `crates/git-ops/src/status.rs` (Phase 2) | `includeUntracked` renamed to `list_untracked_files_individually` | The original name is actively misleading: passing `false` does **not** exclude untracked files. git's default `--untracked-files=normal` still reports them, it just collapses an untracked *directory* to one entry (`nested/`) rather than enumerating its contents (`nested/b.txt`, `nested/deep/a.txt`). Verified against real git and pinned by a test asserting both modes. Behaviour is identical to the original; only the name changed, so a caller can't reasonably misread it. |
| `crates/git-ops/src/status.rs` (Phase 2) | an unclassifiable entry is skipped, where the original called `fatalError` | A status combination we don't recognize shouldn't take down the entire file listing. In practice it's unreachable — the only path to it is a rename/copy without an original path, which the parser already rejects. |
| `crates/git-ops/src/operation_state.rs` (Phase 2) | takes the **git directory**, not the repository path | The originals each recomputed `repository.resolvedGitDir` internally. Passing it in means `get_status` resolves it once and these stay pure filesystem checks with no spawning. Resolution itself is now `rev_parse::resolve_git_dir`, which asks git (`--absolute-git-dir`) instead of assuming `<repo>/.git` — correct for worktrees and submodules, where `.git` is a *file* pointing elsewhere and the naive join isn't a directory at all. |
| `crates/git-ops/src/status_parser.rs` (Phase 2) | takes `&[u8]` rather than a string, and returns `Result` where the original threw | Paths are arbitrary bytes on Unix, so the input is bytes and fields are decoded lossily to match the original's `Buffer::toString()` — an invalid-UTF-8 path degrades to replacement characters instead of failing the whole parse. Malformed entries surface as `GitError::Parse` rather than being skipped, so a porcelain shape we don't handle can't silently vanish from the UI. Also note `parse_untracked_entry` reports `??`/`????` rather than the real codes; that oddity is deliberate in the original (to suit `map_status`) and is kept so the two stay in agreement. |
| `crates/git-ops/src/branch.rs` (Phase 2) | test coverage is largely *new*, not ported | `branch-test.ts` mostly doesn't test `branch.ts`: its `tip` block (5 tests) drives `GitStore` — a frontend store, Phase 7 — and `upstreamWithoutRemote` tests the `Branch` model. Only `getBranchesPointedAt` and `deleteLocalBranch` were portable. Notably `renameBranch`'s case-only-rename retry is **untested upstream** despite being the subtlest logic in the file, so it has new tests, including the guard that refuses to force a rename over a genuinely different branch. |
| `crates/git-ops/src/update_ref.rs` (Phase 2) | documents two behaviours found by testing, rather than the ones the API implies | `update-ref -d` on a **missing ref exits 0** — deletion is idempotent, so callers needn't check existence first. And the `-m` reason has **no observable effect on a deletion**: git records it in the ref's own reflog, which is removed with the ref. Both were verified against real git after tests asserting the opposite failed. |
| `crates/git-ops/src/git_delimiter_parser.rs` (Phase 2) | keeps the original's silent-drop of an incomplete trailing record | A record with fewer values than declared fields is discarded rather than reported, matching the TypeScript (which only pushes an entry once `consumed % keys.length === 0`). Not reachable in practice, since the same parser builds the format string it parses, but pinned by a test so a future change doesn't assume partial records error. |
| `crates/git-ops/src/config.rs` (Phase 2) | global-scope access goes through a `GlobalConfig` type carrying an optional `HOME`, rather than an `env?: { HOME }` parameter on each function | Which file "global" means depends entirely on `HOME`, so making it a property of the accessor rather than an optional trailing argument means a test cannot forget it and silently write to the developer's real `~/.gitconfig`. `GlobalConfig::with_home()` is what tests use; a test asserts two different homes can't see each other's values. Also: global operations need *some* working directory that exists — the original used the app's install dir (`__dirname`), this uses the temp dir, since `--global` makes the location irrelevant to the result. |
| `crates/git-ops/src/rev_parse.rs` (Phase 2) | `resolve()` is lexical, not `std::fs::canonicalize` | The original used Node's `path.resolve`, which does not resolve symlinks. Canonicalizing would return a different path than the caller passed in — immediately visible on macOS, where the temp dir is a symlink (`/var` → `/private/var`), breaking any comparison against the input path. Unit-tested directly for the empty-cdup, walk-up, relative and absolute cases. |
| `crates/git-ops/src/rev_parse.rs` (Phase 2) | test env vars are passed per-invocation via `get_repository_type_with_env`, not by mutating the process environment | The original's unsafe-repository test set `process.env` and restored it with `process.env[k] = undefined`, which in Node assigns the **literal string `"undefined"`** — leaving `GIT_TEST_ASSUME_DIFFERENT_OWNER` set to a non-empty value for everything running afterwards in that process. Per-invocation env makes that class of leakage impossible. |
| `crates/git-ops/src/test_support.rs` (Phase 2) | `conflicted_repository()` merges `main`; the original `setupConflictedRepo` merged `master` | Follows from `empty_repository()` pinning `main`. Also note the helper needs `run_allowing_failure` for the merge step: the conflict means git exits non-zero *by design*, which the TypeScript helpers got for free because dugite's `exec` returns a result instead of throwing. |
| `crates/git-ops/src/config.rs` (Phase 2) | `GlobalConfig::with_home` now also pins `GIT_CONFIG_GLOBAL`, not just `HOME` | The type exists so a test cannot write to the developer's real `~/.gitconfig`, and that guarantee was **defeatable**: `GIT_CONFIG_GLOBAL` outranks `HOME`, so an ambient one sent both reads and writes back to the real file. Found while reproducing a CI-only failure by running the suite with a hostile ambient config; `rev_parse`'s dubious-ownership test had the same hole. Pointing the variable at the stub file overrides an ambient value instead of relying on it being unset. |
| `crates/git-ops/src/{config,var}.rs` (Phase 2) | two tests rewritten to pin the global config, after passing locally and failing in CI | Both asked what git does when the *repository* config has no answer — the one case where ambient global and system config decide. `vouching_for_a_repository_makes_git_work_in_it` was suppressed by a system-wide `safe.directory = *` (CI images set one), so it asserted a refusal that never came; `falls_back_past_the_repository_config` relied on the developer having a global identity **and** on macOS's hostname carrying a domain for git to synthesise an email from, neither of which holds on a fresh Linux runner. Reproduced locally via `GIT_CONFIG_SYSTEM`/`GIT_CONFIG_GLOBAL` before changing anything. The fix added `var::get_author_identity_with_env`, following `rev_parse::get_repository_type_with_env`, which also let the previously-uncovered `useConfigOnly`-with-nothing-anywhere case be tested at last. A guard test now asserts the `safe.directory` stub actually restores the check, so it cannot rot into a vacuous pass. |
| `crates/git-ops/src/exec.rs` (Phase 2) | a capped read reports truncation as **success**, where Node's `maxBuffer` made it an error | The original's `getPartialBlobContents` set `maxBuffer` and then *caught* the rejection to recover `e.stdout` as its answer — the bytes it wanted arrived by way of an error path. That is an artifact of Node's API, not behaviour worth reproducing: `git_capped` returns the prefix with `truncated: true`, so a caller finds its answer where answers go. What the port does have to reproduce is the killing: once reading stops, git blocks writing to a full pipe and would never exit, so it is killed — and because that death is a signal, the exit status is deliberately not classified. Stderr drains in its own task, since a git that filled *stderr* while stdout was being read would block before writing the bytes being waited for. A test with a 4 MiB blob and a 10-byte cap fails by hanging if either half is wrong. |
| `crates/git-ops/src/hooks/protocol.rs` (Phase 2) | a **new** wire protocol, not a ported one, modelled on `trampoline` | `process-proxy` ships a native binary, so there was nothing to port. Three choices differ from the trampoline's message, each for a reason: the **token is positional and first**, so it can be checked before anything else is parsed (the trampoline inherited its placement inside the environment block from the vendored C client); **stdin is length-prefixed bytes**, because it is written to a file for `git hook run --to-stdin` and must survive byte for byte; and the **response is framed** (`E` chunks then one `X` exit code) rather than a single reply, because output has to arrive while the hook runs and an exit code has to follow it. The request is size-capped because the server must read before it can authenticate. |
| `crates/git-ops/src/hooks/with_env.rs` (Phase 2) | escapes the stand-in directory in `GIT_CONFIG_PARAMETERS`, **closing an upstream TODO** | The original wrote `'core.hooksPath=${tmpHooksDir}'` with a comment asking whether the path could contain a single quote — "probably not?". It can: the parent is `TMPDIR`, which is the user's to set, and an unescaped quote would end the quoted item early, leaving git to read the rest of the path as further configuration. git parses this variable with its shell-style `sq_dequote`, so a quote is escaped as `'\''`. Tested. |
| `crates/git-ops/src/hooks/with_env.rs` (Phase 2) | stand-ins are **symlinks**, not copies | Copying an executable and then running it races with `fork` in another thread: Linux fails `execve` with `ETXTBSY` ("Text file busy") while any process holds the file open for writing, and `CLOEXEC` closes an inherited descriptor only *after* the kernel has made that check. Measured on Debian: **370 of 400 copied executables failed to run, and 0 of 400 symlinked ones**. It surfaced as an intermittent CI failure in the tests; in the app the window is smaller but git spawns plenty of subprocesses of its own. A symlinked inode is never open for writing, so there is no window. Falls back to copying where symlinks need a privilege (Windows). A test asserts the stand-in is a link, so a change back to copying fails with the reason attached. |
| `crates/git-ops/src/rev_list.rs` (Phase 3) | reuses `status::AheadBehind` rather than declaring a second one | Caught by the compiler while exporting: `status` already had exactly this shape, because `git status --branch` answers the same question about a different range. Two identical types would have been two things to keep in step with `IAheadBehind` for no gain. |
| `crates/git-ops/src/reset.rs` (Phase 3) | `resetPaths` sends paths through `--pathspec-from-file=- --pathspec-file-nul`, on every platform | Upstream passed paths as arguments except on Windows, where it used `git reset --stdin` — with a comment that the flag "hasn't made it to Git core". It still hasn't: `--stdin` is a Git for Windows extension and fails elsewhere with `unknown option`. **Found by trying it** — the first version of this function used `--stdin` everywhere on a misreading of that comment, and git said no. git core's `--pathspec-from-file` does the same job portably, and using it everywhere removes both problems an argument list has: the platform's length limit (`ARG_MAX` is larger than Windows' ~32KB but a repository with tens of thousands of changed paths still reaches it) and the impossibility of passing a path containing a newline. A test resets exactly such a path. |
| `crates/git-ops/src/branch.rs` (Phase 3) | `rename_branch`'s retry is a second call, not recursion | It recursed through `Box::pin(rename_branch(…))`, which made the future's type refer to itself — so proving `Send` for it never terminated and the function **could not be used from a Tauri command at all**. The recursion was never more than one level deep anyway: the retry passes `force: Some(true)`, which an early guard turns into an immediate return. Spelling the second attempt out makes "at most once" evident, the same choice `get_commit_range_diff` made about the original's recursion. |
| `src-tauri/src/blob_protocol.rs` (Phase 3) | blob bytes cross as an **`rdc-blob://` URL**, not base64 in a command response | Upstream base64-encoded an image into a `data:` URI and shipped it through IPC: a 4 MB PNG becomes ~5.5 MB of JSON, copied twice, resident for as long as the diff is open. A URL the webview fetches keeps the bytes out of JavaScript entirely, and `<img src>` asks for them natively. **A URL is a capability, not a query**: the obvious design — `?repo=…&rev=…&path=…` validated against the open repositories — cannot be written correctly today, because there is no backend list of open repositories (that state lives in the frontend store until Phase 7), and validating against nothing would serve any path on disk. So Rust registers a blob it has decided to expose and hands back an opaque token; the webview can fetch what it was given and can name nothing else. Scoping is structural rather than a rule that could be got wrong — the trampoline's reasoning again. |
| `src/models/diff/image.ts` (Phase 3) | `Image` carries `{ url, mediaType, bytes }` instead of `{ rawContents, contents, mediaType, bytes }` | Follows from the above, and it is a **ported domain type changing while its consumer is unported**, which is the cheapest moment for it. The only consumer is `ImageContainer.loadImage`: it builds a `data:` URI for everything except a DirectDraw Surface texture, where it converts `rawContents` in JS. A URL makes the first case simpler than it was and the second a `fetch` away. `bytes` stays because the two-up view shows both sides' sizes and the difference between them — and it comes from `git cat-file -s`, which answers without reading the object. |
| `crates/git-ops/src/diff.rs` (Phase 3) | image sides are `None` when the blob can't be read, which settles an upstream TODO | The original read the previous side from `${oldestCommitish}^` with a comment that it "won't work for the first commit". It doesn't — and a file added in a repository's first commit has no previous version, so an absent side is the right answer rather than an error. `.dds` is also **excluded** from the image extensions, matching upstream's default: it gates DirectDraw previews behind a feature flag whose converter is frontend code. |
| `crates/git-ops/src/cherry_pick.rs` (Phase 2) | picks the spelling of "keep an empty commit" that this git has | `--empty=keep`, which upstream passes, needs git **2.45** — and **Ubuntu 24.04 LTS ships 2.43**, where it makes every cherry-pick fail with exit 129 and a usage dump about an option the user never typed. `--keep-redundant-commits` is its documented deprecated synonym and behaves identically; verified on 2.39 and 2.53, both keeping the empty commit. The modern spelling is still preferred where it exists, since the synonym will eventually go. Upstream could ignore this because it bundles its own git; rdc runs the system one. Probed with `exec::supports_flag`, which is where the technique is explained. |
| `crates/git-ops/src/hooks/runner.rs` (Phase 2) | probes for `git hook run --to-stdin` and fails the hook with an explanation when it is missing | The option is **newer than `git hook run` itself**, and it is the only way to give a hook stdin — git otherwise runs one with none (verified on 2.39 and 2.50), so piping is not an alternative. Upstream never had to ask because it **bundles its own git**, and says so: "we can't be certain the user's Git binary is new enough". rdc runs the system git, and distros inside their support windows lack it: **Ubuntu 22.04 LTS ships git 2.34.1 and Debian 12 ships 2.39.5, neither with `--to-stdin`**; Ubuntu 24.04 (2.43), Ubuntu 26.04 (2.53) and `ubuntu-latest` all have it. Without the probe, a `pre-push` on such a machine fails with `error: unknown option 'to-stdin'` — an error about a flag the user never typed. With it, the message names the hook and says a newer git enables it, and the hook is **not** run without the data it expects, since a `pre-push` that reads no refs could approve a push it was written to reject. `hook run -h` is the probe: it lists the options this git has and runs no hook. |
| `crates/git-ops/src/hooks/runner.rs` (Phase 2) | resolves git to an **absolute path** before replacing the environment; no `ensureGitExecPathEnv` equivalent | Rust resolves a bare program name through the **child's** `PATH` (verified experimentally), and the hook's environment is the *shell's* — so `git` alone would let a hook's shell decide which git runs it, or fail outright if that environment had no `PATH`. Resolving against rdc's own `PATH` keeps hook execution on the same git as every other operation here. That also removes the need for upstream's `ensureGitExecPathEnv`, which existed only because it invoked a *bundled* git built without a prefix, which set `GIT_EXEC_PATH` to a path that doesn't exist. |
| `crates/git-ops/src/hooks/runner.rs` (Phase 2) | sets **`RDC=1`** alongside upstream's `GITHUB_DESKTOP=1` | Hooks in the wild test for `GITHUB_DESKTOP` (upstream added it for desktop/desktop#19001), so dropping it would silently change how those behave — it is kept as **compatibility, not identity**. rdc is not GitHub Desktop, so `RDC` is the variable to test for from here on, and both are documented in the runner. |
| `crates/git-ops/src/bin/rdc-hook-proxy.rs` (Phase 2) | **fails closed** when the app can't be reached | A hook that didn't run is not a hook that passed. Exiting zero would let a commit through that the user's `pre-commit` hook would have blocked; the cost of the opposite choice is a confusing failure, which is the better failure. Also reads stdin only for the five hooks git pipes it to — reading unconditionally would block until git closed the pipe, the same trap `rdc-trampoline` documents for askpass, and there is a timeout-guarded test for it. |
| `crates/git-ops/src/hooks/discovery.rs` (Phase 2) | returns hooks **sorted**; the original was an async generator yielding in `readdir` order | Directory order is filesystem-dependent. The only consumer collected the lot, so nothing depended on the order — but a test can't assert against it, and a reproducible result costs a sort of a list that is at most 28 entries long. |
| `crates/git-ops/src/hooks/discovery.rs` (Phase 2) | tests the executable **mode bits**, where the original called `access(path, X_OK)` | Rust's standard library has no `access`, and `libc` isn't worth adding for one check. They differ only for a file the current user can't execute despite the bit being set — a hook owned by someone else with `--x` for the owner alone. The result is a stand-in installed for a hook git then declines to run, and git says so: visible, not silent. |
| `crates/git-ops/src/hooks/shell_env.rs` (Phase 2) | the shell's **stdin is closed**; the original piped it and never wrote or closed it | The shell is run interactive (`-i`), so an init file that reads stdin is possible — and upstream's version would block on it forever, with no timeout anywhere in the call. EOF is the answer a well-behaved init file can't distinguish from an empty pipe. |
| `crates/git-ops/src/bin/rdc-printenvz.rs` (Phase 2) | reimplements `vendor/printenvz` (C) in Rust, writing **bytes** rather than strings | Removes a native build step from the project. Bytes because a variable's value is arbitrary bytes on Unix: routing it through a UTF-8 string type would either fail or silently alter it. The marker text (`--printenvz--begin`/`--end`) is kept verbatim so the two implementations stay comparable — it is a private protocol between the binary and `hooks::shell_env`. |
| `crates/git-ops/src/for_each_ref.rs` (Phase 2) | asks git for `%(authordate:unix)` where the original asked for `%(authordate:iso8601)` | The original handed git's string to `new Date()`. git's `iso8601` is space-separated (`2021-01-22 11:45:28 +0100`), which **ECMAScript does not require an engine to parse** — it worked because V8 accepts non-standard formats, and would have been a silent `Invalid Date` in a stricter one. Epoch seconds remove the parse entirely and match how every other timestamp crosses this boundary. |
| `crates/git-ops/src/for_each_ref.rs` (Phase 2) | the `%(worktreepath)` comparison canonicalizes both paths; the original compared strings | `getBranchesDifferingFromUpstream` excludes branches checked out in other worktrees. git prints a **fully resolved** path, so wherever the caller reaches the repository through a symlink the string comparison fails and a branch checked out *here* is misclassified as belonging elsewhere — immediately visible on macOS, where a temp directory is reached via `/var` but reported as `/private/var`. Falls back to the string comparison when either path can't be resolved, so a deleted worktree behaves as before. Pinned by a test that reaches a repository through a symlink. |
| `crates/git-ops/src/terminal_output.rs` (Phase 2) | caps the rolling terminal buffer on **UTF-8 bytes**, not JavaScript string length (UTF-16 code units) | **Exact parity is unrepresentable in Rust, so this deviation is forced rather than chosen.** The original's tests assert `'日本語ab'` has length 5 and that `'👋'` "counts as 2" — trimming by UTF-16 index can split a surrogate pair, and JavaScript will hold the resulting lone surrogate while Rust's `String` (guaranteed UTF-8) cannot. Bytes are also the honest unit for what is really a memory bound. Trimming rounds *up* to a character boundary, so this version can never emit mangled UTF-8 — an improvement, at the cost of sometimes retaining slightly *fewer* bytes than `capacity`, never more. All 27 original cases are ported; the 3 unicode ones carry comments explaining the difference. |

### Known debt carried over, not fixed during the port

- **`url.parse()` (8 call sites)** — Node emits `DEP0169`: not standardized, "security
  implications", and **CVEs are not issued for `url.parse()` vulnerabilities**. It also won't
  bundle for a webview without a Node `url` polyfill. Migrating to WHATWG `URL` is a real
  behavior change (`url.parse` is lenient, `new URL()` is strict), so it needs its own change
  with the now-ported tests as the guard — not a drive-by edit during a port.
- **Node `path`**: `basename` is resolved — `lib/path-utils.ts` provides it and
  `models/{repository,worktree,cloning-repository}.ts` use it. **Only `lib/repository-matching.ts`
  still imports Node `path`**, for `normalize`, which `path-utils` deliberately omits: `..`-beyond
  -root, drive letters and UNC paths are exactly where hand-rolled path code goes wrong. Resolve it
  with a Rust query or a vetted library, not by hand. Fine under Vitest (which runs in Node) but must
  be settled before that module enters the app bundle.
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
| ~~`IndexStatus`, `NoRenameIndexStatus`~~ **DONE** | `lib/git/diff-index.ts` | `models/index-status.ts` — an enum crossing IPC is a domain type, and its old home is now a Rust module | Phase 2, with `diff-index` |
| `IAddSSHHostPrompt` (interface) | was `lib/ssh/ssh-host-prompt.ts`, now parsed in Rust | `models/` — it becomes the payload of the host-confirmation prompt request | Phase 7, with the SSH prompt UI |
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
