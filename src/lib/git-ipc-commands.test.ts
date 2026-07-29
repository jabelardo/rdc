import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppFileStatusKind, GitStatusEntry } from '../models/status'
import { ManualConflictResolution } from '../models/manual-conflict-resolution'

/**
 * Pins the command names and argument names of the git commands.
 *
 * Tauri maps JavaScript argument names onto Rust parameters, so these keys are part of the contract:
 * renaming a Rust parameter without updating the caller fails at runtime with nothing to catch it at
 * build time. `wire_contract.rs` covers the *shapes* travelling in both directions; this covers the
 * names.
 *
 * Deliberately asserted with the literal strings rather than constants — a constant shared between
 * the test and the implementation would make both wrong together, which is the mistake that produced
 * the conflict-shape bug.
 */
const ipc = vi.hoisted(() => {
  class Channel<T> {
    public onmessage: (message: T) => void

    public constructor(onmessage?: (message: T) => void) {
      this.onmessage = onmessage ?? (() => {})
    }
  }

  return { invoke: vi.fn(), Channel }
})
const { invoke, Channel } = ipc
vi.mock('@tauri-apps/api/core', () => ipc)

const {
  createCommit,
  createMergeCommit,
  checkoutBranch,
  checkoutRemoteBranch,
  checkoutCommit,
  checkoutPaths,
  stageManualConflictResolution,
  mergeBranch,
  getMergeBase,
  abortMerge,
  rebaseBranch,
  continueRebase,
  abortRebase,
  getRebaseSnapshot,
} = await import('./git-ipc')

const REPO = '/tmp/repo'

describe('the git commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
  })

  it('createCommit sends the message, files and options', async () => {
    invoke.mockResolvedValue('a'.repeat(40))

    const sha = await createCommit(REPO, 'Fix the thing', [
      { path: 'src/thing.ts' },
    ])

    expect(invoke).toHaveBeenCalledWith('create_commit', {
      repositoryPath: REPO,
      message: 'Fix the thing',
      files: [{ path: 'src/thing.ts' }],
      options: undefined,
      // Hook interception is off unless asked for, and the Channel is sent regardless because the Rust
      // side takes one unconditionally. Covered in hook-ipc.test.ts.
      interceptHooks: false,
      onHookProgress: expect.anything(),
    })
    expect(sha).toHaveLength(40)
  })

  it('createCommit passes options through when given', async () => {
    invoke.mockResolvedValue('a'.repeat(40))

    await createCommit(REPO, 'empty', [], { allowEmpty: true })

    expect(invoke).toHaveBeenCalledWith(
      'create_commit',
      expect.objectContaining({ options: { allowEmpty: true } })
    )
  })

  it('createCommit describes a rename with oldPath', async () => {
    invoke.mockResolvedValue('a'.repeat(40))

    await createCommit(REPO, 'renamed', [
      { path: 'after', oldPath: 'before' },
    ])

    expect(invoke).toHaveBeenCalledWith(
      'create_commit',
      expect.objectContaining({ files: [{ path: 'after', oldPath: 'before' }] })
    )
  })

  it('createCommit passes a partial line selection through', async () => {
    invoke.mockResolvedValue('a'.repeat(40))

    await createCommit(REPO, 'partial', [
      {
        path: 'src/thing.ts',
        partial: {
          status: { kind: AppFileStatusKind.Modified },
          selectedLines: [2, 3, 7],
        },
      },
    ])

    expect(invoke).toHaveBeenCalledWith(
      'create_commit',
      expect.objectContaining({
        files: [
          {
            path: 'src/thing.ts',
            partial: {
              status: { kind: 'Modified' },
              selectedLines: [2, 3, 7],
            },
          },
        ],
      })
    )
  })

  it('createMergeCommit defaults manualResolutions to empty', async () => {
    invoke.mockResolvedValue('a'.repeat(40))

    await createMergeCommit(REPO, [{ path: 'conflicted.txt' }])

    expect(invoke).toHaveBeenCalledWith('create_merge_commit', {
      repositoryPath: REPO,
      files: [{ path: 'conflicted.txt' }],
      manualResolutions: [],
    })
  })

  it('createMergeCommit sends resolutions as pairs, not a record', async () => {
    // A path is an arbitrary string, so it is not a safe object key — the Rust side takes pairs.
    invoke.mockResolvedValue('a'.repeat(40))

    await createMergeCommit(
      REPO,
      [{ path: 'a.txt' }],
      [['a.txt', ManualConflictResolution.theirs]]
    )

    expect(invoke).toHaveBeenCalledWith(
      'create_merge_commit',
      expect.objectContaining({ manualResolutions: [['a.txt', 'theirs']] })
    )
  })

  it('checkoutBranch sends the branch name', async () => {
    await checkoutBranch(REPO, 'topic')

    expect(invoke).toHaveBeenCalledWith('checkout_branch', {
      repositoryPath: REPO,
      name: 'topic',
      onProgress: expect.any(Channel),
    })
  })

  it('checkoutRemoteBranch is a distinct command from checkoutBranch', async () => {
    // Creating a local branch from a remote ref is a different operation, not an optional argument.
    await checkoutRemoteBranch(REPO, 'origin/topic', 'topic')

    expect(invoke).toHaveBeenCalledWith('checkout_remote_branch', {
      repositoryPath: REPO,
      remoteRef: 'origin/topic',
      localName: 'topic',
      onProgress: expect.any(Channel),
    })
  })

  it('checkoutCommit sends the revision', async () => {
    await checkoutCommit(REPO, 'abc123')

    expect(invoke).toHaveBeenCalledWith('checkout_commit', {
      repositoryPath: REPO,
      commit: 'abc123',
      onProgress: expect.any(Channel),
    })
  })

  it('checkoutBranch streams typed progress to its callback', async () => {
    const progress = vi.fn()
    await checkoutBranch(REPO, 'topic', progress)

    const args = invoke.mock.calls[0][1] as { onProgress: InstanceType<typeof Channel> }
    const event = {
      kind: 'checkout' as const,
      value: 0.5,
      title: 'Checking out branch topic',
      description: 'Checking out files:  50% (1/2)',
      target: 'topic',
    }
    args.onProgress.onmessage(event)

    expect(progress).toHaveBeenCalledWith(event)
  })

  it('checkoutPaths sends the pathspec', async () => {
    await checkoutPaths(REPO, ['src/thing.ts'])

    expect(invoke).toHaveBeenCalledWith('checkout_paths', {
      repositoryPath: REPO,
      paths: ['src/thing.ts'],
    })
  })

  it('stageManualConflictResolution sends the resolution as a git flag name', async () => {
    // 'ours'/'theirs' go straight to git as --ours/--theirs, so the enum's values are load-bearing.
    await stageManualConflictResolution(
      REPO,
      'conflicted.txt',
      ManualConflictResolution.ours
    )

    expect(invoke).toHaveBeenCalledWith('stage_manual_conflict_resolution', {
      repositoryPath: REPO,
      path: 'conflicted.txt',
      resolution: 'ours',
      entries: undefined,
    })
  })

  it('stageManualConflictResolution forwards the index entries when given', async () => {
    // Supplying these is what lets a side that deleted the file resolve to a deletion.
    await stageManualConflictResolution(
      REPO,
      'conflicted.txt',
      ManualConflictResolution.theirs,
      [GitStatusEntry.UpdatedButUnmerged, GitStatusEntry.Deleted]
    )

    expect(invoke).toHaveBeenCalledWith(
      'stage_manual_conflict_resolution',
      expect.objectContaining({ entries: ['U', 'D'] })
    )
  })

  it('mergeBranch sends options to the merge command', async () => {
    await mergeBranch(REPO, 'topic', { squash: true, noVerify: true })

    expect(invoke).toHaveBeenCalledWith('merge_branch', {
      repositoryPath: REPO,
      branch: 'topic',
      options: { squash: true, noVerify: true },
      interceptHooks: false,
      onHookProgress: expect.anything(),
    })
  })

  it('getMergeBase sends both commit-ish identifiers', async () => {
    await getMergeBase(REPO, 'main', 'topic')

    expect(invoke).toHaveBeenCalledWith('get_merge_base', {
      repositoryPath: REPO,
      firstCommitish: 'main',
      secondCommitish: 'topic',
    })
  })

  it('abortMerge identifies the repository', async () => {
    await abortMerge(REPO)
    expect(invoke).toHaveBeenCalledWith('abort_merge', {
      repositoryPath: REPO,
    })
  })

  it('rebaseBranch sends the base and target branches', async () => {
    await rebaseBranch(REPO, 'main', 'topic')

    expect(invoke).toHaveBeenCalledWith('rebase_branch', {
      repositoryPath: REPO,
      baseBranch: 'main',
      targetBranch: 'topic',
      onProgress: expect.any(Channel),
    })
  })

  it('continueRebase sends files, resolutions, and noVerify', async () => {
    await continueRebase(
      REPO,
      [{ path: 'conflicted.txt' }],
      [
        {
          path: 'conflicted.txt',
          resolution: ManualConflictResolution.theirs,
          entries: [
            GitStatusEntry.UpdatedButUnmerged,
            GitStatusEntry.Deleted,
          ],
        },
      ],
      true
    )

    expect(invoke).toHaveBeenCalledWith('continue_rebase', {
      repositoryPath: REPO,
      files: [{ path: 'conflicted.txt' }],
      manualResolutions: [
        {
          path: 'conflicted.txt',
          resolution: 'theirs',
          entries: ['U', 'D'],
        },
      ],
      noVerify: true,
      onProgress: expect.any(Channel),
    })
  })

  it('abortRebase identifies the repository', async () => {
    await abortRebase(REPO)
    expect(invoke).toHaveBeenCalledWith('abort_rebase', {
      repositoryPath: REPO,
    })
  })

  it('rebaseBranch streams per-commit progress', async () => {
    const progress = vi.fn()
    await rebaseBranch(REPO, 'main', 'topic', progress)

    const args = invoke.mock.calls[0][1] as {
      onProgress: InstanceType<typeof Channel>
    }
    const event = {
      kind: 'multiCommitOperation' as const,
      value: 0.5,
      position: 1,
      totalCommitCount: 2,
      currentCommitSummary: 'First',
    }
    args.onProgress.onmessage(event)
    expect(progress).toHaveBeenCalledWith(event)
  })

  it('getRebaseSnapshot identifies the repository', async () => {
    await getRebaseSnapshot(REPO)
    expect(invoke).toHaveBeenCalledWith('get_rebase_snapshot', {
      repositoryPath: REPO,
    })
  })
})
