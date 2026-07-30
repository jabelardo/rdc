# History Rewrite Plan

## Current state

97 linear commits, all by one author, 729c6b5..1a186d5. The `history-rewrite` branch at 0a8b693
(Phase 3 boundary) is stale — it strips all post-Phase-3 code but was never used.

## Problems

1. **Phase 2 is 30 commits** — individual file ports (`Port stash`, `Port tag`, `Port revert`, …)
   should be squashed into a few logical groups.
2. **Phase 3 is 15 commits** — granular per-domain command slices should be ~3–4 commits.
3. **Phase 4 is 10 commits, Phase 7 is 15 commits** — each has small incremental commits that
   could be fewer, larger units.
4. **Cross-cutting fixes interleaved** — test isolation, CI hardening, and doc corrections
   (`3726bfd`, `d3b849c`, `e3e4517`, `563974c`, `bb17bad`) are scattered within the phase they
   belong to rather than squashed into their phase commit.
5. **Plan-only commits** — `275e636 Phase 4 plan`, `15aa820 Plan Phase 7e`, `8726c26 Plan Phase 3`,
   `06e06ac Record what the Phase 3 exit criteria do not measure` — add 0 code changes. These
   should be squashed into the first code commit of their phase as a message body, not a separate
   commit.
6. **`history-rewrite` branch** is dead. Either delete it or use it as the rewrite target.

## Result: 97 → 25 commits — **DONE** on the `rewrite` branch

**Tree verified identical to `origin/main`** (`git diff --stat rewrite origin/main` exits 0).

### New commit log

```
 1: b7eff15 Phase 0: Scaffold Tauri 2 + React 19 project with tooling and CI
 2: 9bfda06 Phase 1: Port models + pure-TS lib from desktop-plus, test-first
 3: 1740132 Phase 2: Cargo workspace, exec core, error classification, terminal buffer, test harness
 4: b6ed67e Phase 2: Core git primitives (init, add, config, rev-parse, branch, refs, status)
 5: e2d613c Phase 2: Recover deferred Phase 1 tests via layering extractions
 6: e24b9b3 Phase 2: Trampoline sidecar, first IPC slice, wire contract, binding generator decision
 7: b287345 Phase 2: Git operations (commit, merge, rebase, diff, log, show, stash, submodule, ...)
 8: c9c645f Phase 2: Network operations (push, fetch, pull, clone, remote, trampoline handlers)
 9: fc2e696 Phase 2: More git operations (stash, cherry-pick, submodule, squash, reorder, tag, revert, ...)
10: 5f2e226 Phase 2: Partial staging, multi-op terminal, for-each-ref, branch close, remaining primitives
11: 3616d4b Phase 2: Hook subsystem (discovery, shell, proxy transport, runner, withHooksEnv)
12: 623d489 Phase 2: Close with cross-cutting fixes (CI hardening, test isolation, exit audit)
13: 0bea061 Phase 3: Hook interception, image model, rdc-blob:// capability URLs
14: 7958479 Phase 3: Command batches (branch, reset, stage, rev-list, diff, config, trailers, LFS, worktrees)
15: fc489a0 Phase 3: Close IPC surface with measurement and cross-version verification
16: e5aabdc Phase 4: Platform menus, window lifecycle, paths, dialogs, recoverable trash
17: afdca91 Phase 4a: App lifetime, startup chrome, complete platform substrate
18: f5286fb Phase 4b: Native integrations (keychain, notifications, CLI installer, install ID)
19: 35a1e73 Phase 4->7: Transition to MVP (updater fix, webview security, crash recovery)
20: 76ac0cd Phase 7a: Repository ownership, application menu, recovery, integration harness
21: bc0e120 Phase 7b: Working tree workflow (show repo, load diffs, working tree store)
22: 14f3235 Phase 7c: History and branch workflows
23: 993b42b Phase 7d: Remote synchronization (fetch, push, pull, clone)
24: 74673df Phase 7e: MVP hardening, interaction hardening, sidebar, visual workspace, large-list
25: 66adcf4 Phase 8a: Automated qualification
```

## Original plan (record)

The table below was the target before execution. The result matches it exactly.

| Proposed commit | Original commits squashed | Rationale |
| **Phase 0:** Scaffold Tauri 2 + React 19 with tooling and CI | `729c6b5` | Keep as-is (1 commit) |
| **Phase 1:** Port models + pure-TS lib from desktop-plus, test-first | `144a7d2` | Keep as-is (1 commit) |
| **Phase 2:** Cargo workspace, exec core, error classification, terminal buffer, test harness | `4aa36b0`, `7a46f19`, `555913e` | Foundational infrastructure |
| **Phase 2:** Core git primitives (init, add, config, rev-parse, branch, refs, status) | `435954e`, `6bfae88`, `ba0d898`, `a0dfd72`, `b1b15cd` | First batch of git operations |
| **Phase 2:** Recover deferred tests via layering extractions | `326c10e`, `25690e9`, `f48bcba`, `9bead06`, `1b7a7db` | All the "recover deferred test" commits are a single logical unit: extract types/constants to break import cycles |
| **Phase 2:** Git operations (commit, checkout, merge, rebase, diff, log, show, stash, cherry-pick) plus progress streaming | `cc13ac9`, `2829895`, `1914f8b`, `52494a8`, `ae4687c`, `7acaca5`, `68e2ebe`, `e2c6b75`, `fe965a1`, `10a1b73`, `aeaa6cc`, `563974c` | All the "port X to Rust" commits for core git operations. `563974c` (doc fixes) squashed since it's just docs corrections for this phase |
| **Phase 2:** Network operations (push, fetch, pull, clone, remote, trampoline) | `3d0e087`, `8eac13d`, `3b0178a` | Network-facing git operations |
| **Phase 2:** Partial staging, discards, multi-op terminal, for-each-ref, branch close | `c70d8db`, `04d77ea`, `21bb01c`, `b2a4ee7`, `8b28aeb`, `6a16f37`, `748dd78`, `263ac00` | Remaining git surface |
| **Phase 2:** Hook subsystem (discovery, shell, proxy transport, runner, withHooksEnv) | `a3304ce`, `4b78b44`, `4c5b772`, `4f50fd3`, `fdf7e2b`, `1e30672` | Hook interception |
| **Phase 2:** Close with cross-cutting fixes (CI hardening, test isolation, audit) | `6fba5dd`, `7973756`, `3726bfd`, `d3b849c`, `e3e4517`, `bb17bad`, `e0df8df` | Closure fixes |
| **Phase 3:** First IPC slice (get_status, wire contract, binding generator decision) | `e63ecac`, `b36ccf3`, `b393a35` | Foundation: first command, fix wire shape, settle on no-codegen |
| **Phase 3:** Hook interception + image diffs + blob URLs | `8726c26`, `8de1cf0`, `2e36630`, `f18cdcf` | Plan + hook wire-up + image model |
| **Phase 3:** Command batches (branch, reset, stage, rev-list, diff readers, config, trailers, LFS, worktrees, state) | `83eef79`, `2f7998a`, `19aefc8`, `d289624`, `a816b91` | All remaining command surface |
| **Phase 3:** Close (measurement, cross-version verification, conflict index entries, exit criteria) | `bf518f7`, `69e152b`, `0a8b693`, `e0e40c4`, `06e06ac` | Measurement + closure |
| **Phase 4:** Platform menus, window lifecycle, paths, dialogs, trash | `275e636`, `067d5df`, `3b5daa4`, `2154d2a` | Plan + platform foundation |
| **Phase 4:** App lifetime, startup chrome, platform substrate close | `4c482fc`, `d18778a` | Lifetime + startup |
| **Phase 4b:** Native integrations (keychain, notifications, CLI installer, install ID) | `c87f8fd`, `c65c89e`, `6f8e127` | 4b plan + macOS fix + close |
| **Phase 4→7 transition:** Fix updater, reorganize around MVP, webview security, crash recovery | `14e8ffb`, `cb69f43`, `3ebd7de`, `01c83c1` | Transition from platform to stores |
| **Phase 7a:** Repository ownership shell, application menu, recovery, integration harness | `a5fa5d4`, `c040e1e`, `48bb986`, `f4a760b` | Repository shell + menu |
| **Phase 7b:** Working tree workflow (show repo, load diffs, working tree store) | `6051254`, `3f5366e`, `c6e1e9d` | Working tree |
| **Phase 7c:** History and branch workflows | `591f95b` | Keep as-is |
| **Phase 7d:** Remote synchronization | `2089933` | Keep as-is |
| **Phase 7e:** MVP hardening, interaction hardening, sidebar, visual workspace, large-list hardening | `15aa820`, `712c357`, `25c791b`, `16a7514`, `d6ccb3c`, `a961d8f` | Hardening + visual work |
| **Phase 8a:** Automated qualification | `1a186d5` | Keep as-is |

## Execution

Rewrite uses `git filter-repo` (faster, handles all refs, preserves tags) rather than `git rebase -i`
on 97 commits:

```sh
# 1. Fetch git-filter-repo
pip install git-filter-repo   # or brew install git-filter-repo

# 2. Create the message map
#    Each line: <old-sha1> <new-sha1>  (or use --message-callback)
#    Simpler: write a commit message callback that maps old hashes to new messages

# 3. Do the rewrite on the history-rewrite branch
git checkout history-rewrite
git filter-repo --message-callback '
  messages = {
    "729c6b5": "Phase 0: Scaffold Tauri 2 + React 19 project with tooling and CI",
    "144a7d2": "Phase 1: port models + pure-TS lib from desktop-plus, test-first",
    ...
  }
  return messages.get(commit_hash, message)
'

# 4. Replace main
git branch -f main history-rewrite
git push --force-with-lease origin main
git push origin --delete history-rewrite
```

## Alternative: incremental rebase

If you want to keep the existing `main` branch and rewrite incrementally rather than all at once:

```sh
# From the boundary where Phase 1 ends and Phase 2 begins
# Use git rebase -i --rebase-merges with fixup/squash
git rebase -i 144a7d2 --onto 144a7d2
# Then mark all the small Phase 2 commits as `squash` or `fixup`
```

## Things to do after the rewrite

- [ ] Update `MIGRATION_PLAN.md` and `MIGRATION_MAP.md` if commit hashes are referenced
- [ ] Update any CI config that references commit SHAs
- [ ] Delete the stale `history-rewrite` branch
- [ ] Verify the rewritten history with `git log --oneline --graph` and `git diff main~1 HEAD`
- [ ] Run all five CI gates before force-pushing