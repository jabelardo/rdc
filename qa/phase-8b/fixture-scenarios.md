# Phase 8b fixture scenarios

Generate one fixture root per platform and QA cycle. The command refuses to replace an existing
target, and every mutating journey has its own working tree below that target:

```sh
pnpm fixture:phase8b -- /tmp/rdc-phase8b-macos-cycle-2
```

Open `fixture-manifest.json` and use the paths under `scenarios`. Do not copy a path from an older
cycle and do not reuse one scenario for a different journey. The top-level `primary`, `remote` and
`publisher` fields are compatibility aliases for `scenarios.populated`; new evidence should record
the scenario name and its own repository path.

## Scenario map

| Scenario | Use | Initial state and oracle |
|---|---|---|
| `clean` | Clean Changes/History visual states and recovery target | Clean `main` with one commit; `git status --short` is empty and `HEAD` equals `expectedHead`. |
| `populated` | Foundation gates and read-only status/diff/history | Dirty `main`, two expected working-tree files, long file/branch names, and a local bare remote one commit ahead. Do not mutate it during visual review. |
| `branch` | Create/check out/return branch journey | Clean `main`; create the manifest's `branchToCreate`, verify it, then return to `initialBranch`. |
| `lineDiscard` | Selected-line discard | Two separated hunks in `file`. Discard the first and retain the last; the resulting bytes must equal `expectedContent`. |
| `wholeFileDiscard` | Whole-file discard | One modified tracked `file`; after discard its bytes equal `expectedContent` and `git diff --exit-code -- <file>` succeeds. |
| `commitHook` | Hook failure, terminal output and bypass | One untracked `file`; ordinary commit fails with `expectedGitExitCode` and contains `expectedHookMessage`. Choose **Bypass hooks** and commit with `commitSummary`, then verify `git log -1 --format=%s`. |
| `mergeConflict` | Minimum conflict recovery | Already stopped in a merge conflict on `file`. Resolve it to `expectedResolution`, complete the merge, then require no unmerged paths and no `MERGE_HEAD`. |
| `remoteFetchPull` | Fetch followed by pull | The bare remote is at `remoteHead`; local `HEAD` is `localHeadBeforeFetch` and the tracking ref is intentionally stale. Fetch must update the tracking ref; Pull must update `HEAD` and create `expectedPulledFile` with `expectedPulledContent`. |
| `remotePush` | Unpublished-branch push | Checked out on `unpublishedBranch`, which has no upstream. Push must create the matching bare-remote ref at `localHead` and configure the upstream. |
| `remoteClone` | Clone | Clone `remote` into the deliberately absent `destination`; cloned `HEAD` must equal `expectedHead`. |
| `delayedPush` | Stable progress/busy-state visual inspection | Same unpublished-branch topology as `remotePush`, but the local bare remote's `pre-receive` hook waits `delaySeconds`. Start Push and inspect the busy/progress presentation during that window. Product code contains no artificial delay. |
| `unreachableRemote` | Network failure and recovery | `origin` points at a reserved local endpoint expected to reject immediately. Run `expectedOperation`, confirm actionable failure and unchanged repository state, then refresh the separate `clean` scenario to prove recovery. |

The system-credential HTTPS/SSH and authentication-rejection checks remain tester-controlled native
integration checks: generating credentials or embedding a secret-bearing URL would make the fixture
less safe, not more deterministic. Record only the transport and result in evidence.

## Required Git checks

Run these from the scenario repository after the corresponding UI journey. Substitute values from
the manifest; UI presentation alone is not evidence.

```sh
git status --short
git branch --show-current
git log -1 --format='%H%n%s'
git diff --name-only --diff-filter=U
git rev-parse -q --verify MERGE_HEAD
git rev-parse HEAD
git rev-parse '@{upstream}'
git --git-dir=<remote> rev-parse refs/heads/<branch>
```

For discard results, compare the actual file bytes with the manifest's `expectedContent`. For Pull
and Clone, compare both the commit ID and the named file contents. A command expected to find no
merge state (`git rev-parse -q --verify MERGE_HEAD`) must fail and print nothing.

## Isolation rule

Treat a scenario as consumed after Discard, Commit, conflict resolution, Pull, Push or Clone. If a
journey has to be repeated, generate a new fixture root rather than repairing the repository by hand.
That rule keeps every evidence record reproducible and prevents one earlier result from manufacturing
the precondition for a later one.
