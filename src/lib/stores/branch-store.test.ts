import { describe, expect, it, vi } from 'vitest'
import { Branch, BranchType } from '../../models/branch'
import { ComputedAction } from '../../models/computed-action'
import type { MergeTreeResult } from '../../models/merge'
import { MergeResult } from '../git-ipc'
import { BranchStore } from './branch-store'

function branch(
  name: string,
  type = BranchType.Local,
  upstream: string | null = null
): Branch {
  return new Branch(
    name,
    upstream,
    {
      sha: name.padEnd(40, 'a').slice(0, 40),
      author: { date: new Date('2026-07-30T12:00:00Z') },
    },
    type,
    type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/${name}`,
    false
  )
}

describe('BranchStore', () => {
  it('loads all branches and the current branch together', async () => {
    const branches = [
      branch('main', BranchType.Local, 'origin/main'),
      branch('topic'),
      branch('origin/main', BranchType.Remote),
    ]
    const getBranches = vi.fn(async () => branches)
    const getStatus = vi.fn(async () => ({
      currentBranch: 'main',
      mergeHeadFound: false,
      squashMsgFound: false,
      isCherryPickingHeadFound: false,
      files: [],
      doConflictedFilesExist: false,
    }))
    const getRecentBranches = vi.fn(async () => ['topic', 'main'])
    const getRemotes = vi.fn(async () => [
      { name: 'origin', url: 'https://example.invalid/repository.git' },
    ])
    const getRemoteHEAD = vi.fn(async () => 'main')
    const store = new BranchStore({
      getBranches,
      getStatus,
      getRecentBranches,
      getRemotes,
      getRemoteHEAD,
    })

    await store.load('/repo')

    expect(getBranches).toHaveBeenCalledWith('/repo')
    expect(getStatus).toHaveBeenCalledWith('/repo', true)
    expect(store.state).toMatchObject({
      repositoryPath: '/repo',
      branches,
      currentBranch: 'main',
      defaultBranch: 'main',
      recentBranches: ['topic', 'main'],
      loading: false,
      error: null,
    })
    expect(getRecentBranches).toHaveBeenCalledWith('/repo', 6)
    expect(getRemoteHEAD).toHaveBeenCalledWith('/repo', 'origin')
  })

  it('creates from HEAD, checks out, and refreshes branch facts', async () => {
    const main = branch('main')
    const feature = branch('feature')
    const getBranches = vi
      .fn()
      .mockResolvedValueOnce([main])
      .mockResolvedValueOnce([feature, main])
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ currentBranch: 'main' })
      .mockResolvedValueOnce({ currentBranch: 'feature' })
    const createBranch = vi.fn(async () => undefined)
    let reportProgress:
      | ((progress: {
          kind: 'checkout'
          target: string
          value: number
          description: string
        }) => void)
      | undefined
    const checkoutBranch = vi.fn(
      async (
        _repositoryPath: string,
        _name: string,
        callback?: typeof reportProgress
      ) => {
        reportProgress = callback
        callback?.({
          kind: 'checkout',
          target: 'feature',
          value: 0.5,
          description: 'Updating files',
        })
      }
    )
    const store = new BranchStore({
      getBranches,
      getStatus,
      createBranch,
      checkoutBranch,
    })
    await store.load('/repo')

    const created = await store.createAndCheckout(' feature ')

    expect(created).toBe(true)
    expect(createBranch).toHaveBeenCalledWith(
      '/repo',
      'feature',
      undefined,
      false
    )
    expect(checkoutBranch).toHaveBeenCalledWith(
      '/repo',
      'feature',
      expect.any(Function)
    )
    expect(reportProgress).toBeDefined()
    expect(store.state).toMatchObject({
      branches: [feature, main],
      currentBranch: 'feature',
      operation: null,
      progress: null,
      operationError: null,
    })
  })

  it('checks out a loaded local branch but not the current or a remote branch', async () => {
    const main = branch('main')
    const topic = branch('topic')
    const remote = branch('origin/topic', BranchType.Remote)
    const checkoutBranch = vi.fn(async () => undefined)
    const getBranches = vi.fn(async () => [main, topic, remote])
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ currentBranch: 'main' })
      .mockResolvedValue({ currentBranch: 'topic' })
    const store = new BranchStore({
      getBranches,
      getStatus,
      checkoutBranch,
    })
    await store.load('/repo')

    expect(await store.checkout('main')).toBe(false)
    expect(await store.checkout('origin/topic')).toBe(false)
    expect(await store.checkout('topic')).toBe(true)
    expect(checkoutBranch).toHaveBeenCalledOnce()
    expect(checkoutBranch).toHaveBeenCalledWith(
      '/repo',
      'topic',
      expect.any(Function)
    )
  })

  it('rejects an empty branch name before invoking git', async () => {
    const createBranch = vi.fn(async () => undefined)
    const store = new BranchStore({ createBranch })

    expect(await store.createAndCheckout('   ')).toBe(false)
    expect(createBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toBe('Enter a branch name.')
  })

  it('publishes operation failures and keeps the loaded branch list', async () => {
    const main = branch('main')
    const store = new BranchStore({
      getBranches: vi.fn(async () => [main]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      createBranch: vi.fn(async () => {
        throw new Error('branch exists')
      }),
    })
    await store.load('/repo')

    expect(await store.createAndCheckout('main')).toBe(false)
    expect(store.state.branches).toEqual([main])
    expect(store.state.operationError).toBe('Error: branch exists')
    expect(store.state.operation).toBeNull()
  })

  it('ignores a slow load after the repository changes', async () => {
    let resolveOld: ((branches: ReadonlyArray<Branch>) => void) | undefined
    const oldBranches = new Promise<ReadonlyArray<Branch>>(resolve => {
      resolveOld = resolve
    })
    const current = branch('current')
    const getBranches = vi
      .fn()
      .mockReturnValueOnce(oldBranches)
      .mockResolvedValueOnce([current])
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ currentBranch: 'old' })
      .mockResolvedValueOnce({ currentBranch: 'current' })
    const store = new BranchStore({ getBranches, getStatus })

    const oldLoad = store.load('/old')
    await store.load('/current')
    resolveOld?.([branch('stale')])
    await oldLoad

    expect(store.state.repositoryPath).toBe('/current')
    expect(store.state.branches).toEqual([current])
    expect(store.state.currentBranch).toBe('current')
  })

  function loadTopology(currentBranch: string | undefined, branches: Branch[]) {
    const getBranches = vi.fn(async () => branches)
    const getStatus = vi.fn(async () => ({
      currentBranch,
      mergeHeadFound: false,
      squashMsgFound: false,
      isCherryPickingHeadFound: false,
      files: [],
      doConflictedFilesExist: false,
    }))
    const getRemoteHEAD = vi.fn(async () => 'main')
    const getRemotes = vi.fn(async () => [
      { name: 'origin', url: 'https://example.invalid/repository.git' },
    ])
    const renameBranch = vi.fn(async () => undefined)
    const deleteLocalBranch = vi.fn(async () => undefined)
    const deleteRef = vi.fn(async () => undefined)
    const determineMergeability = vi.fn(
      async (): Promise<MergeTreeResult> => ({ kind: ComputedAction.Clean })
    )
    const mergeBranch = vi.fn(async () => MergeResult.Success)
    const store = new BranchStore({
      getBranches,
      getStatus,
      getRecentBranches: vi.fn(async () => []),
      getRemotes,
      getRemoteHEAD,
      renameBranch,
      deleteLocalBranch,
      deleteRef,
      determineMergeability,
      mergeBranch,
    })
    return {
      store,
      getBranches,
      renameBranch,
      deleteLocalBranch,
      deleteRef,
      determineMergeability,
      mergeBranch,
    }
  }

  it('renames a branch and refreshes branch facts', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const other = branch('other')
    const { store, getBranches, renameBranch } = loadTopology('topic', [
      main,
      topic,
      other,
    ])
    await store.load('/repo')

    await expect(store.renameBranch('other', 'renamed')).resolves.toBe(true)

    expect(renameBranch).toHaveBeenCalledWith(
      '/repo',
      'other',
      'renamed',
      undefined
    )
    expect(store.state.operationError).toBeNull()
    expect(getBranches).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid branch name without calling git', async () => {
    const topic = branch('topic')
    const { store, renameBranch } = loadTopology('topic', [topic])
    await store.load('/repo')

    await expect(store.renameBranch('topic', 'bad~name')).resolves.toBe(false)

    expect(renameBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toContain('not a valid branch name')
  })

  it('requires a non-empty branch name to rename', async () => {
    const topic = branch('topic')
    const { store, renameBranch } = loadTopology('topic', [topic])
    await store.load('/repo')

    await expect(store.renameBranch('topic', '   ')).resolves.toBe(false)

    expect(renameBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toBe('Enter a branch name.')
  })

  it('rejects a rename that collides with an existing branch', async () => {
    const main = branch('main')
    const topic = branch('topic')
    const { store, renameBranch } = loadTopology('topic', [main, topic])
    await store.load('/repo')

    await expect(store.renameBranch('topic', 'main')).resolves.toBe(false)

    expect(renameBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toContain('already exists')
  })

  it('deletes a non-current, non-default local branch', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const other = branch('other')
    const { store, deleteLocalBranch, deleteRef } = loadTopology('topic', [
      main,
      topic,
      other,
    ])
    await store.load('/repo')
    expect(store.state.defaultBranch).toBe('main')

    await expect(store.deleteBranch('other')).resolves.toBe(true)

    expect(deleteLocalBranch).toHaveBeenCalledWith('/repo', 'other')
    expect(deleteRef).not.toHaveBeenCalled()
  })

  it('refuses to delete the current branch', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const { store, deleteLocalBranch } = loadTopology('topic', [main, topic])
    await store.load('/repo')

    await expect(store.deleteBranch('topic')).resolves.toBe(false)

    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toContain('current branch')
  })

  it('refuses to delete the default branch', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const { store, deleteLocalBranch } = loadTopology('topic', [main, topic])
    await store.load('/repo')
    expect(store.state.defaultBranch).toBe('main')

    await expect(store.deleteBranch('main')).resolves.toBe(false)

    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toContain('default branch')
  })

  it('refuses to delete a branch on an unborn or detached HEAD', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const other = branch('other')
    const { store, deleteLocalBranch } = loadTopology(undefined, [main, other])
    await store.load('/repo')

    await expect(store.deleteBranch('other')).resolves.toBe(false)

    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(store.state.operationError).toContain('unborn or detached')
  })

  it('prunes the tracking ref only when opted in', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature', BranchType.Local, 'origin/feature')
    const { store, deleteLocalBranch, deleteRef } = loadTopology('topic', [
      main,
      topic,
      feature,
    ])
    await store.load('/repo')

    await expect(
      store.deleteBranch('feature', { pruneTrackingRef: true })
    ).resolves.toBe(true)

    expect(deleteLocalBranch).toHaveBeenCalledWith('/repo', 'feature')
    expect(deleteRef).toHaveBeenCalledWith(
      '/repo',
      'refs/remotes/origin/feature'
    )
  })

  it('does not touch the remote-tracking ref by default', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature', BranchType.Local, 'origin/feature')
    const { store, deleteLocalBranch, deleteRef } = loadTopology('topic', [
      main,
      topic,
      feature,
    ])
    await store.load('/repo')

    await expect(store.deleteBranch('feature')).resolves.toBe(true)

    expect(deleteLocalBranch).toHaveBeenCalledWith('/repo', 'feature')
    expect(deleteRef).not.toHaveBeenCalled()
  })

  it('merges a clean local branch and reports merged', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature')
    const { store, mergeBranch, determineMergeability } = loadTopology(
      'topic',
      [main, topic, feature]
    )
    await store.load('/repo')

    await expect(
      store.initiateMerge('feature', { workingTreeDirty: false })
    ).resolves.toBe('merged')

    expect(determineMergeability).toHaveBeenCalledWith(
      '/repo',
      'topic',
      'feature'
    )
    expect(mergeBranch).toHaveBeenCalledWith('/repo', 'feature')
  })

  it('reports an already-up-to-date merge', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature')
    const { store, mergeBranch } = loadTopology('topic', [main, topic, feature])
    mergeBranch.mockResolvedValueOnce(MergeResult.AlreadyUpToDate)
    await store.load('/repo')

    await expect(
      store.initiateMerge('feature', { workingTreeDirty: false })
    ).resolves.toBe('up-to-date')
  })

  it('reports a merge that produces conflicts', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature')
    const { store, mergeBranch } = loadTopology('topic', [main, topic, feature])
    mergeBranch.mockResolvedValueOnce(MergeResult.Failed)
    await store.load('/repo')

    await expect(
      store.initiateMerge('feature', { workingTreeDirty: false })
    ).resolves.toBe('conflict')
  })

  it('refuses to merge branches with unrelated histories', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature')
    const { store, determineMergeability, mergeBranch } = loadTopology(
      'topic',
      [main, topic, feature]
    )
    determineMergeability.mockResolvedValueOnce({
      kind: ComputedAction.Invalid,
    })
    await store.load('/repo')

    await expect(
      store.initiateMerge('feature', { workingTreeDirty: false })
    ).resolves.toBe('invalid')

    expect(mergeBranch).not.toHaveBeenCalled()
  })

  it('refuses to merge over a dirty working tree', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const feature = branch('feature')
    const { store, determineMergeability, mergeBranch } = loadTopology(
      'topic',
      [main, topic, feature]
    )
    await store.load('/repo')

    await expect(
      store.initiateMerge('feature', { workingTreeDirty: true })
    ).resolves.toBe('dirty')

    expect(determineMergeability).not.toHaveBeenCalled()
    expect(mergeBranch).not.toHaveBeenCalled()
  })

  it('refuses to merge a branch into itself', async () => {
    const main = branch('main', BranchType.Local, 'origin/main')
    const topic = branch('topic')
    const { store, mergeBranch } = loadTopology('topic', [main, topic])
    await store.load('/repo')

    await expect(
      store.initiateMerge('topic', { workingTreeDirty: false })
    ).resolves.toBe('failed')

    expect(mergeBranch).not.toHaveBeenCalled()
  })
})
