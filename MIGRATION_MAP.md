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
| `lib/git/core.ts` (the invocation core) | `crates/git-ops/src/exec.rs` + `error.rs` — **done** for spawn/exit-code/stdin/env/error classification, bidirectional streaming, and the `GIT_LFS_PROGRESS` side channel. Hook interception remains deferred. | 2 |
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
| `lib/git/rev-list.ts` (`getCommitsBetweenCommits`) | `crates/git-ops/src/rev_list.rs` — **partially done**: full-SHA/summary commit lists in replay order, used by rebase progress and recovery snapshots. The remaining rev-list queries land with their callers. | 2 / 3 |
| `lib/helpers/default-branch.ts` (`getDefaultBranch`/`setDefaultBranch`) | **now unblocked** by `config.rs`'s `GlobalConfig`, but still outstanding: the `"main"` fallback is app policy that belongs above the git layer, so wire it up there rather than inside `git-ops`. | 2 |
| `lib/status-parser.ts` + the status types from `models/status.ts` | `crates/git-ops/src/status_parser.rs` — **done**. **Supersedes the Phase 1 TypeScript port**: `src/lib/status-parser.ts` and its test are deleted, as is `src/lib/split-buffer.ts` (its only consumer was that parser, and it is Node `Buffer`-based so unusable in a webview). Decision recorded in `MIGRATION_PLAN.md` Phase 2: since `lib/git/status.ts` becomes a Rust command, parsing had to move with it, or Rust would ship raw porcelain over IPC for the frontend to interpret. | 2 |
| `lib/trampoline/**` (11 files) + the vendored `desktop-trampoline` C binary | `src-tauri/crates/trampoline/` — **done**: transport, sidecar, credential protocol, session state, and askpass/credential handlers. Account storage and interactive UI decisions stay behind traits for Phase 7. One Rust crate replaces both the C binary and the TypeScript half. | 2 |
| `lib/ssh/ssh.ts` (`parseAddSSHHostPrompt` only) | `rdc/src/lib/ssh/ssh-host-prompt.ts` — **done**. `getSSHEnvironment` stays with the trampoline/shell work; it produces `SSH_ASKPASS`/`GIT_SSH_COMMAND` pointing at the trampoline binary. | 2 / 4 |
| `lib/git/status.ts` | `crates/git-ops/src/status.rs` — **done**: `get_status`, `StatusResult`, `AppFileStatus`, `ConflictedFileStatus`, header parsing and conflict-detail gathering. Returns git facts only; `WorkingDirectoryFileChange`/`DiffSelection`/`WorkingDirectoryStatus` stay frontend (see §8). | 2 |
| `lib/git/merge.ts` (`isMergeHeadSet`, `isSquashMsgSet`), `lib/git/cherry-pick.ts` (`isCherryPickHeadFound`), `lib/git/rebase.ts` (`isRebaseHeadSet`, `getRebaseInternalState`) + `models/rebase.ts` (`RebaseInternalState`) | `crates/git-ops/src/operation_state.rs` — **done**. Collected into one module because these are the marker-file checks `status` needs and nothing else from those (154/499/627-line) files; the rest lands with each module's own port. | 2 |
| `lib/git/diff-check.ts` | `crates/git-ops/src/diff_check.rs` — **done**. | 2 |
| `lib/git/diff.ts` | `crates/git-ops/src/diff.rs` — **text path done**: working-directory, commit, range, conflict-resolution, size guards, submodules, and binary detection. Image previews remain deferred; the shared LFS plumbing is done in `lfs.rs`. **Contains an upstream bug fix — see §8.** | 2 |
| `lib/git/git-delimiter-parser.ts` (`createLogParser`) | `crates/git-ops/src/git_delimiter_parser.rs::LogParser` — **done** (needed by `getBinaryPaths`'s `check-attr` parsing). | 2 |
| `lib/git/branch.ts` | `crates/git-ops/src/branch.rs` — **done**: `create_branch`, `get_branch_names`, `rename_branch` (incl. the case-only-rename retry), `delete_local_branch`, `delete_remote_branch`, `get_branches_pointed_at`, `get_merged_branches`. Remote deletion propagates authentication failures rather than classifying them, which is the original's explicit choice, and cleans up a stale tracking ref when the remote branch is already gone. Proxy support is absent here as everywhere — see `environment.ts`. | 2 |
| `lib/git/for-each-ref.ts` | `crates/git-ops/src/for_each_ref.rs` — **done**: `get_branches` and `get_branches_differing_from_upstream`. This is the branch *list*; `branch.rs` is the branch *operations*. Hydrated into the `Branch` class by `src/lib/branch-ipc.ts`. Two deliberate improvements — epoch seconds instead of a `new Date()` parse of git's `iso8601`, and a canonicalized worktree-path comparison — see §8. | 2 |
| `lib/git/environment.ts` | **partially ported, and the one `lib/git` file without a full counterpart.** `envForAuthentication` is `crates/git-ops/src/authentication.rs`; `getFallbackUrlForProxyResolve` and `envForProxy` are **not** ported, because `envForProxy` resolves through Electron's `session.resolveProxy`. There is no Tauri equivalent — it needs reading the OS proxy configuration natively, so it belongs with the Phase 4 platform integrations. Consequence: **no remote operation has proxy support today.** | 4 |
| `lib/git/git-delimiter-parser.ts` | `crates/git-ops/src/git_delimiter_parser.rs` — **done**, including the `%x00` log parser. | 2 |
| `lib/git/refs.ts` | `crates/git-ops/src/refs.rs` — **done** (`format_as_local_ref`, `get_symbolic_ref`). | 2 |
| `lib/git/update-ref.ts` (`deleteRef`) | `crates/git-ops/src/update_ref.rs` — **done**. `updateRef` itself lands when a caller needs it. | 2 |
| `lib/git/merge.ts` | `crates/git-ops/src/merge.rs` — **done**: merge (including squash/no-verify), merge-base lookup, conflict result, noop result, and abort. Hook/terminal streaming waits for the shared Channel/hook infrastructure. | 2 / 3 |
| `lib/git/rebase.ts` | `crates/git-ops/src/rebase.rs` — **done except hook/terminal output**: start/continue/abort, selected-file staging, manual conflict resolutions, Channel progress, recovery snapshots, reorder, and squash. `rebase.backend=merge` is pinned because status and snapshot recovery consume `.git/rebase-merge/**`. | 2 / 3 |
| `lib/git/worktree-include.ts`, `worktree.ts` | `crates/git-ops/src/worktree_include.rs` + `worktree.rs` — porcelain listing, linked-worktree fallback, lifecycle operations, ignore-pattern selection, and guarded best-effort copies **done**. | 2 |
| `lib/progress/from-process.ts` + git progress variants | `crates/git-ops/src/progress.rs` + `remote_progress.rs` — **done**, including live LFS side-channel progress. | 2 |
| `lib/hooks/get-repo-hooks.ts`, `get-shell.ts`, `shell-escape.ts`, `get-shell-env.ts` | `crates/git-ops/src/hooks/{discovery,shell,shell_env}.rs` — **done**, plus the `rdc-printenvz` binary replacing `vendor/printenvz` (a ten-line C program). Discovery honours `core.hooksPath`, works in a worktree, and **fixes an upstream bug** — see §8. Windows shell selection (registry-based Git Bash discovery, MSYS2/PowerShell/cmd quoting) is deliberately not ported; the reasoning is in `hooks/shell.rs`. | 2 |
| `lib/hooks/hooks-proxy.ts`, `with-hooks-env.ts` | **Not a port — a protocol design**, since `process-proxy` ships a *native binary* and its wire format is not in the desktop-plus tree. **Transport done:** `crates/git-ops/src/hooks/{protocol,client,server}.rs` plus the `rdc-hook-proxy` binary — NUL-framed request (token, hook, argv, env, cwd, length-prefixed stdin), framed streaming response (stderr chunks then an exit code), per-operation random token compared in constant time, loopback only, request size capped, and the stand-in **fails closed**. **Runner done:** `hooks/runner.rs` runs `git hook run` with the login-shell environment plus git's own `GIT_*`/`GITHEAD_*` (minus upstream's exclusion set), spools stdin for `--to-stdin`, streams and captures stderr, reports start/finish/failure progress with an abort handle, and offers a failure to the user to ignore. **Wiring done:** `hooks/with_env.rs` installs a stand-in per discovered hook in a temp directory, points `core.hooksPath` at it through `GIT_CONFIG_PARAMETERS` (existing value preserved, `sq_quote`-escaped — closing an upstream TODO), binds a server for one invocation, and loads the login shell at most once per directory. **What remains is the command layer:** `commit.rs`, `merge.rs`, `push.rs` and `pull.rs` don't yet *ask* for interception, and their callbacks need Tauri Channels — Phase 3. Whether to intercept at all is frontend state (`config.ts`), so it is Phase 7 that decides. Those close the `interceptHooks`/`onHookProgress`/`onHookFailure` deferrals in `commit.rs`, `merge.rs`, `push.rs` and `pull.rs`. | 2 / 3 |
| `lib/hooks/config.ts` | **Frontend, not Rust.** Every export reads or writes `localStorage` (`git-hooks-env-enabled`, `git-cache-hooks-env`, `git-hook-env-shell`) behind two feature flags. It is preferences state, so it lands with the Phase 7 settings UI — and note `SupportedHooksEnvShell` names four *Windows* shells, so most of it has no meaning on the primary target. | 7 |
| `lib/trampoline/trampoline-server.ts` | `crates/trampoline/src/server.rs` | 2 |
| `lib/ssh/*` (4 files, at `app/src/lib/ssh/`) | **No `ssh/` module was created.** Host-key prompt classification and parsing live in `crates/trampoline/src/handlers.rs` instead, where the askpass handler needs them (`ssh-host-prompt.ts` and its test were deleted). The remaining SSH env work needs an ssh-wrapper binary. | 2 / 7 |
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
| `lib/git/push.ts` | `crates/git-ops/src/push.rs` (hooks deferred) | 2 |
| `lib/git/fetch.ts` | `crates/git-ops/src/fetch.rs` | 2 |
| `lib/git/pull.ts` | `crates/git-ops/src/pull.rs` (hooks deferred) | 2 |
| `lib/progress/{git,push,fetch,pull}.ts` | `crates/git-ops/src/progress.rs` | 2 |
| `lib/git/authentication.ts` | `crates/git-ops/src/authentication.rs` | 2 |
| `lib/trampoline/trampoline-environment.ts` | `crates/trampoline/src/session.rs` | 2 |
| `lib/trampoline/trampoline-askpass-handler.ts` | `crates/trampoline/src/handlers.rs` | 2 |
| `lib/trampoline/trampoline-credential-helper.ts` | `crates/trampoline/src/handlers.rs` (account/UI decisions behind traits) | 2 |
| `lib/git/credential.ts`, `lib/trampoline/url-without-credentials.ts` | `crates/trampoline/src/credential.rs` | 2 |
| `lib/ssh/ssh.ts` (`parseAddSSHHostPrompt`) | `crates/trampoline/src/handlers.rs` — **the TypeScript port is deleted** | 2 |
| `lib/git/diff.ts` | `crates/git-ops/src/diff.rs` — text and conflict-resolution diff paths done; image previews deferred | 2 |
| `lib/git/show.ts` | `crates/git-ops/src/show.rs` — **done**, both entry points. `getPartialBlobContents` reads a bounded prefix through `exec::git_capped`, a real cap rather than a slice after the fact. Neither is exposed as a command: raw bytes over IPC still needs a representation decision, and its consumer (syntax highlighting) is Phase 7. | 2 |
| `lib/git/diff-index.ts` | `crates/git-ops/src/diff_index.rs`; `IndexStatus` → **`src/models/index-status.ts`** | 2 |
| `lib/git/log.ts` | `crates/git-ops/src/log.rs` | 2 |
| `lib/diff-parser.ts` | `crates/git-ops/src/diff_parser.rs` — **the TypeScript parser is deleted**, same fork as `status-parser` | 2 |
| `lib/git/apply.ts` + `lib/patch-formatter.ts` | `crates/git-ops/src/apply.rs` + `patch_formatter.rs` — partial staging and partial discard **done** | 2 / 3 |
| `lib/git/gitignore.ts` | `crates/git-ops/src/gitignore.rs` — root-file read/write/append and literal filename escaping **done** | 2 |
| `lib/git/checkout-index.ts` | `crates/git-ops/src/checkout_index.rs` — NUL-delimited index restore **done** | 2 |
| `lib/git/format-patch.ts` | `crates/git-ops/src/format_patch.rs` — minimal mailbox patch generation **done** | 2 |
| `lib/git/merge-tree.ts` | `crates/git-ops/src/merge_tree.rs` — clean/conflicted/invalid mergeability computation **done** | 2 |
| `lib/git/lfs.ts` + `lib/progress/lfs.ts` | `crates/git-ops/src/lfs.rs` + `progress.rs` — filter/hook installation, attribute queries, and aggregated live transfer progress **done** | 2 |
| `lib/git/multi-operation-terminal-output.ts` | `crates/git-ops/src/multi_operation_terminal_output.rs` — bounded replay, live fan-out, and RAII subscriptions **done**; per-command Channel wiring remains Phase 3 | 2 / 3 |
| `lib/git/commit.ts` | `crates/git-ops/src/commit.rs` (hook interception deferred) | 3 |
| `lib/git/checkout.ts` | `crates/git-ops/src/checkout.rs` — checkout, submodule updates, and **Channel-based progress done** for local branch, remote branch, and commit. | 3 |
| `lib/git/update-index.ts` | `crates/git-ops/src/update_index.rs` — whole-file and partial line selections **done** | 3 |
| `lib/git/stage.ts` | `crates/git-ops/src/stage.rs` | 3 |
| `lib/git/reset.ts` | `crates/git-ops/src/reset.rs` (`unstageAll` only) | 3 |
| `lib/git/rm.ts` | `crates/git-ops/src/rm.rs` | 3 |
| `lib/ipc-shared.ts` | `rdc/MIGRATION_MAP.md` §7 channel table; hand-written `src/lib/*-ipc.ts` wrappers over native `invoke` (**no** codegen — see §8) | 3 |
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

**Blocked** (5, was 15): `ipc-contract`, `popup-manager`, `format-commit-message`, `stats-store`,
`app-store-test-harness`. All six are now genuinely phase-gated rather than blocked by
layering — what each needs, and in which phase, is tabulated in `MIGRATION_PLAN.md`.

**Recovered (2):**
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

**Re-checked after `status` landed: still all 15.** Porting git to Rust could not unblock them —
they are TypeScript tests whose closure reaches `lib/git/**` via `import`, and a Rust
implementation gives TypeScript nothing to import. The blocker is not "git isn't implemented" but
"TypeScript still asks for git the Node way". The eight edges responsible, and the cheapest way to
retire them, are tabulated in `MIGRATION_PLAN.md` under "Re-check of the 15 deferred Phase 1
tests". Short version: `interpret-trailers` → Rust unblocks `create-branch` outright and leaves
`pull-request-refs` with a single blocker; the `Repository` redesign is worth 5 tests on its own.

---

## 7. IPC channel table (`app/src/lib/ipc-shared.ts`, 77 channels)

Not yet populated — build this table at the start of Phase 3: one row per channel name,
its direction (request/response vs main→renderer push), and its target Tauri
command/event name. Do it as a dedicated pass over `ipc-shared.ts` rather than ad hoc as UI
components get ported, per `MIGRATION_PLAN.md` Phase 3.

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
| _(new)_ | request/response | `stage_manual_conflict_resolution` → `stageManualConflictResolution()` | **done** |
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
| _(new)_ | request/response | `get_authors` → `getAuthors()` | **done** |
| _(new)_ | request/response | `get_index_changes` → `getIndexChanges()` | **done** |
| _(new)_ | request/response | `get_working_directory_diff` → `getWorkingDirectoryDiff()` | **done** |
| _(new)_ | request/response | `get_commit_diff` → `getCommitDiff()` | **done** |
| _(new)_ | request/response | `get_commit_range_diff` → `getCommitRangeDiff()` | **done** |
| _(new)_ | request/response | `discard_changes_from_selection` → `discardChangesFromSelection()` | **done** |
| _(new)_ | request/response | `get_branches` → `getBranches()` | **done** |
| _(new)_ | request/response | `get_branches_differing_from_upstream` → `getBranchesDifferingFromUpstream()` | **done** |
| _(new)_ | request/response | `delete_remote_branch` → `deleteRemoteBranch()` | **done** |
| _(new)_ | request/response | `add_safe_directory` → `addSafeDirectory()` | **done** |
| _(new)_ | request/response + Channel | `push` → `push()` | **done** |
| _(new)_ | request/response + Channel | `fetch` → `fetch()` | **done** |
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
| _(new)_ | request/response | `create_tag`, `delete_tag`, `get_all_tags`, `fetch_tags_to_push` | **done** |
| _(new)_ | request/response + Channel | `revert_commit` → `revertCommit()` | **done** |
| _(new)_ | request/response | `get_recent_branches`, `get_branch_checkouts` | **done** |
| _(new)_ | request/response | `get_description`, `write_description` | **done** |
| _(new)_ | request/response | `get_author_identity`, `clean_untracked_files` | **done** |
| _(remaining 77 — populate as each is ported)_ | | | |

---

## 8. Deliberate deviations from a verbatim port

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
  high-throughput data, so the original's `processCallback` / `onTerminalOutputAvailable` — progress
  during push/pull/fetch — maps to a Channel argument on the command.

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
| `crates/git-ops/src/exec.rs` (Phase 2) | a capped read reports truncation as **success**, where Node's `maxBuffer` made it an error | The original's `getPartialBlobContents` set `maxBuffer` and then *caught* the rejection to recover `e.stdout` as its answer — the bytes it wanted arrived by way of an error path. That is an artifact of Node's API, not behaviour worth reproducing: `git_capped` returns the prefix with `truncated: true`, so a caller finds its answer where answers go. What the port does have to reproduce is the killing: once reading stops, git blocks writing to a full pipe and would never exit, so it is killed — and because that death is a signal, the exit status is deliberately not classified. Stderr drains in its own task, since a git that filled *stderr* while stdout was being read would block before writing the bytes being waited for. A test with a 4 MiB blob and a 10-byte cap fails by hanging if either half is wrong. |
| `crates/git-ops/src/hooks/protocol.rs` (Phase 2) | a **new** wire protocol, not a ported one, modelled on `trampoline` | `process-proxy` ships a native binary, so there was nothing to port. Three choices differ from the trampoline's message, each for a reason: the **token is positional and first**, so it can be checked before anything else is parsed (the trampoline inherited its placement inside the environment block from the vendored C client); **stdin is length-prefixed bytes**, because it is written to a file for `git hook run --to-stdin` and must survive byte for byte; and the **response is framed** (`E` chunks then one `X` exit code) rather than a single reply, because output has to arrive while the hook runs and an exit code has to follow it. The request is size-capped because the server must read before it can authenticate. |
| `crates/git-ops/src/hooks/with_env.rs` (Phase 2) | escapes the stand-in directory in `GIT_CONFIG_PARAMETERS`, **closing an upstream TODO** | The original wrote `'core.hooksPath=${tmpHooksDir}'` with a comment asking whether the path could contain a single quote — "probably not?". It can: the parent is `TMPDIR`, which is the user's to set, and an unescaped quote would end the quoted item early, leaving git to read the rest of the path as further configuration. git parses this variable with its shell-style `sq_dequote`, so a quote is escaped as `'\''`. Tested. |
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
