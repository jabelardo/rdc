import { describe, expect, it, vi } from 'vitest'
import { Branch, BranchType } from '../../models/branch'
import { BranchStore } from './branch-store'

function branch(
  name: string,
  type = BranchType.Local
): Branch {
  return new Branch(
    name,
    null,
    {
      sha: name.padEnd(40, 'a').slice(0, 40),
      author: { date: new Date('2026-07-30T12:00:00Z') },
    },
    type,
    type === BranchType.Local
      ? `refs/heads/${name}`
      : `refs/remotes/${name}`,
    false
  )
}

describe('BranchStore', () => {
  it('loads all branches and the current branch together', async () => {
    const branches = [
      branch('main'),
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
    const store = new BranchStore({ getBranches, getStatus })

    await store.load('/repo')

    expect(getBranches).toHaveBeenCalledWith('/repo')
    expect(getStatus).toHaveBeenCalledWith('/repo', true)
    expect(store.state).toMatchObject({
      repositoryPath: '/repo',
      branches,
      currentBranch: 'main',
      loading: false,
      error: null,
    })
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
    expect(store.state.operationError).toBe(
      'Enter a branch name.'
    )
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
    let resolveOld:
      | ((branches: ReadonlyArray<Branch>) => void)
      | undefined
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
})
