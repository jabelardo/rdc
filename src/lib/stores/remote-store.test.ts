import { describe, expect, it, vi } from 'vitest'
import { Branch, BranchType } from '../../models/branch'
import type {
  IFetchProgress,
  IPullProgress,
  IPushProgress,
} from '../../models/progress'
import type { IRemote } from '../../models/remote'
import { RemoteStore } from './remote-store'

const origin: IRemote = {
  name: 'origin',
  url: '/remotes/origin.git',
}
const upstream: IRemote = {
  name: 'upstream',
  url: '/remotes/upstream.git',
}

function branch(name: string, upstreamName: string | null): Branch {
  return new Branch(
    name,
    upstreamName,
    {
      sha: name.padEnd(40, 'a').slice(0, 40),
      author: { date: new Date('2026-07-30T12:00:00Z') },
    },
    BranchType.Local,
    `refs/heads/${name}`,
    false
  )
}

describe('RemoteStore', () => {
  it('selects the current branches tracked remote ahead of origin', async () => {
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin, upstream]),
      getBranches: vi.fn(async () => [branch('topic', 'upstream/topic')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'topic' })),
    })

    await store.load('/repo')

    expect(store.state).toMatchObject({
      repositoryPath: '/repo',
      remotes: [origin, upstream],
      currentRemote: upstream,
      loading: false,
      error: null,
    })
  })

  it('falls back to origin and then the first remote', async () => {
    const dependencies = {
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
    }
    const withOrigin = new RemoteStore({
      ...dependencies,
      getRemotes: vi.fn(async () => [upstream, origin]),
    })
    const withoutOrigin = new RemoteStore({
      ...dependencies,
      getRemotes: vi.fn(async () => [upstream]),
    })

    await withOrigin.load('/repo')
    await withoutOrigin.load('/repo')

    expect(withOrigin.state.currentRemote).toBe(origin)
    expect(withoutOrigin.state.currentRemote).toBe(upstream)
  })

  it('fetches the tracked remote before a distinct origin and fast-forwards eligible branches', async () => {
    const progress: IFetchProgress = {
      kind: 'fetch',
      remote: 'upstream',
      value: 0.5,
      description: 'Receiving objects',
    }
    const fetch = vi.fn(
      async (
        _repositoryPath: string,
        _remoteName: string,
        callback?: (progress: IFetchProgress) => void
      ) => callback?.(progress)
    )
    const getRemotes = vi.fn(async () => [origin, upstream])
    const getBranches = vi.fn(async () => [branch('topic', 'upstream/topic')])
    const getStatus = vi.fn(async () => ({ currentBranch: 'topic' }))
    const getBranchesDifferingFromUpstream = vi.fn(async () => [
      {
        ref: 'refs/heads/main',
        sha: 'a'.repeat(40),
        upstreamRef: 'refs/remotes/origin/main',
        upstreamSha: 'b'.repeat(40),
      },
    ])
    const fastForwardBranches = vi.fn(async () => undefined)
    const updateRemoteHEAD = vi.fn(async () => undefined)
    const store = new RemoteStore({
      getRemotes,
      getBranches,
      getStatus,
      fetch,
      updateRemoteHEAD,
      getBranchesDifferingFromUpstream,
      fastForwardBranches,
    })
    const observedProgress: number[] = []
    store.onDidUpdate(state => {
      if (state.progress !== null) {
        observedProgress.push(state.progress.value)
      }
    })
    await store.load('/repo')

    await expect(store.fetch()).resolves.toBe(true)

    expect(fetch.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['/repo', 'upstream'],
      ['/repo', 'origin'],
    ])
    expect(updateRemoteHEAD.mock.calls).toEqual([
      ['/repo', 'upstream', false],
      ['/repo', 'origin', false],
    ])
    expect(observedProgress).toContain(0.225)
    expect(fastForwardBranches).toHaveBeenCalledWith('/repo', [
      ['refs/remotes/origin/main', 'refs/heads/main'],
    ])
    expect(getRemotes).toHaveBeenCalledTimes(2)
    expect(store.state).toMatchObject({
      operation: null,
      progress: null,
      operationError: null,
    })
  })

  it('pushes the current branch to its tracked branch and refreshes the remote', async () => {
    const pushProgress: IPushProgress = {
      kind: 'push',
      remote: 'upstream',
      branch: 'topic',
      value: 0.5,
      description: 'Writing objects',
    }
    const push = vi.fn(
      async (
        _repositoryPath: string,
        _remoteName: string,
        _localBranch: string,
        _remoteBranch: string | null,
        _tags: ReadonlyArray<string>,
        _options: object,
        callback?: (progress: IPushProgress) => void
      ) => callback?.(pushProgress)
    )
    const fetch = vi.fn(
      async (
        _repositoryPath: string,
        remoteName: string,
        callback?: (progress: IFetchProgress) => void
      ) =>
        callback?.({
          kind: 'fetch',
          remote: remoteName,
          value: 0.5,
          description: 'Updating refs',
        })
    )
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin, upstream]),
      getBranches: vi.fn(async () => [branch('topic', 'upstream/topic')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'topic' })),
      push,
      fetch,
      updateRemoteHEAD: vi.fn(async () => undefined),
      getBranchesDifferingFromUpstream: vi.fn(async () => []),
      fastForwardBranches: vi.fn(async () => undefined),
    })
    const progressKinds: string[] = []
    store.onDidUpdate(state => {
      if (state.progress !== null) {
        progressKinds.push(state.progress.kind)
      }
    })
    await store.load('/repo')

    await expect(store.push()).resolves.toBe(true)

    expect(push).toHaveBeenCalledWith(
      '/repo',
      'upstream',
      'topic',
      'topic',
      [],
      {},
      expect.any(Function),
      false
    )
    expect(fetch).toHaveBeenCalledWith(
      '/repo',
      'upstream',
      expect.any(Function),
      false
    )
    expect(progressKinds).toContain('push')
    expect(progressKinds).toContain('fetch')
    expect(store.state.operation).toBeNull()
  })

  it('does not turn a remote HEAD refresh failure into a failed fetch', async () => {
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      fetch: vi.fn(async () => undefined),
      updateRemoteHEAD: vi.fn(async () => {
        throw new Error('remote did not advertise HEAD')
      }),
      getBranchesDifferingFromUpstream: vi.fn(async () => []),
      fastForwardBranches: vi.fn(async () => undefined),
    })
    await store.load('/repo')

    await expect(store.fetch()).resolves.toBe(true)
    expect(store.state).toMatchObject({
      operation: null,
      progress: null,
      operationError: null,
    })
  })

  it('sets upstream when pushing an unpublished current branch', async () => {
    const push = vi.fn(async () => undefined)
    const getBranches = vi
      .fn()
      .mockResolvedValueOnce([branch('new-topic', null)])
      .mockResolvedValueOnce([branch('new-topic', 'origin/new-topic')])
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches,
      getStatus: vi.fn(async () => ({ currentBranch: 'new-topic' })),
      push,
      fetch: vi.fn(async () => undefined),
      updateRemoteHEAD: vi.fn(async () => undefined),
      getBranchesDifferingFromUpstream: vi.fn(async () => []),
      fastForwardBranches: vi.fn(async () => undefined),
    })
    await store.load('/repo')

    await expect(store.push()).resolves.toBe(true)

    expect(push).toHaveBeenCalledWith(
      '/repo',
      'origin',
      'new-topic',
      null,
      [],
      {},
      expect.any(Function),
      false
    )
    expect(store.state.currentBranch?.upstream).toBe('origin/new-topic')
  })

  it('pulls a tracked current branch and refreshes its remote', async () => {
    const pullProgress: IPullProgress = {
      kind: 'pull',
      remote: 'origin',
      value: 0.5,
      description: 'Fast-forwarding',
    }
    const pull = vi.fn(
      async (
        _repositoryPath: string,
        _remoteName: string,
        callback?: (progress: IPullProgress) => void
      ) => callback?.(pullProgress)
    )
    const fetch = vi.fn(async () => undefined)
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      pull,
      fetch,
      updateRemoteHEAD: vi.fn(async () => undefined),
      getBranchesDifferingFromUpstream: vi.fn(async () => []),
      fastForwardBranches: vi.fn(async () => undefined),
    })
    const progressKinds: string[] = []
    store.onDidUpdate(state => {
      if (state.progress !== null) {
        progressKinds.push(state.progress.kind)
      }
    })
    await store.load('/repo')

    await expect(store.pull()).resolves.toBe(true)

    expect(pull).toHaveBeenCalledWith(
      '/repo',
      'origin',
      expect.any(Function),
      false,
      false
    )
    expect(fetch).toHaveBeenCalledWith(
      '/repo',
      'origin',
      expect.any(Function),
      false
    )
    expect(progressKinds).toContain('pull')
    expect(store.state.operation).toBeNull()
  })

  it('does not pull an unpublished, detached, or unborn branch', async () => {
    const pull = vi.fn(async () => undefined)
    const unpublished = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('topic', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'topic' })),
      pull,
    })
    const detached = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({})),
      pull,
    })
    await unpublished.load('/unpublished')
    await detached.load('/detached')

    expect(await unpublished.pull()).toBe(false)
    expect(await detached.pull()).toBe(false)
    expect(pull).not.toHaveBeenCalled()
  })

  it('turns pull conflicts into recovery guidance without transport copy', async () => {
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      pull: vi.fn(async () => {
        throw {
          message: 'automatic merge failed',
          kind: 'MergeConflicts',
          isAuthFailure: false,
        }
      }),
    })
    await store.load('/repo')

    expect(await store.pull()).toBe(false)
    expect(store.state.operationError).toMatch(
      /merge conflicts.*Resolve.*commit/s
    )
    expect(store.state.operationError).not.toMatch(/proxy|certificate/)
  })

  it('explains a non-fast-forward rejection without offering force push', async () => {
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      push: vi.fn(async () => {
        throw {
          message: 'failed to push some refs',
          kind: 'PushNotFastForward',
          isAuthFailure: false,
        }
      }),
    })
    await store.load('/repo')

    expect(await store.push()).toBe(false)
    expect(store.state.operationError).toMatch(
      /updated since.*Fetch and pull.*pushing again/s
    )
    expect(store.state.operationError).not.toMatch(/force/i)
  })

  it('cannot push a detached or unborn HEAD', async () => {
    const push = vi.fn(async () => undefined)
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({})),
      push,
    })
    await store.load('/repo')

    expect(await store.push()).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })

  it('does not run concurrent fetches or fetch a repository without remotes', async () => {
    let finishFetch: (() => void) | undefined
    const pendingFetch = new Promise<void>(resolve => {
      finishFetch = resolve
    })
    const fetch = vi.fn(async () => pendingFetch)
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      fetch,
      updateRemoteHEAD: vi.fn(async () => undefined),
    })
    await store.load('/repo')

    const first = store.fetch()
    await Promise.resolve()
    expect(await store.fetch()).toBe(false)
    finishFetch?.()
    expect(await first).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()

    const noRemote = new RemoteStore({
      getRemotes: vi.fn(async () => []),
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      fetch,
    })
    await noRemote.load('/other')
    expect(await noRemote.fetch()).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('turns authentication and unsupported transport failures into actionable copy', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce({
        message: 'git authentication failed',
        kind: 'HTTPSAuthenticationFailed',
        isAuthFailure: true,
      })
      .mockRejectedValueOnce({
        message: 'SSL certificate problem: self-signed certificate',
        isAuthFailure: false,
      })
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => [origin]),
      getBranches: vi.fn(async () => [branch('main', 'origin/main')]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      fetch,
    })
    await store.load('/repo')

    expect(await store.fetch()).toBe(false)
    expect(store.state.operationError).toMatch(
      /Authentication failed.*credential helper.*SSH agent/s
    )
    expect(await store.fetch()).toBe(false)
    expect(store.state.operationError).toMatch(
      /SSL certificate problem.*system Git.*proxy.*certificate/s
    )
  })

  it('ignores a slow load after the repository changes', async () => {
    let resolveOld: ((remotes: ReadonlyArray<IRemote>) => void) | undefined
    const oldRemotes = new Promise<ReadonlyArray<IRemote>>(resolve => {
      resolveOld = resolve
    })
    const getRemotes = vi
      .fn()
      .mockReturnValueOnce(oldRemotes)
      .mockResolvedValueOnce([upstream])
    const store = new RemoteStore({
      getRemotes,
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
    })

    const staleLoad = store.load('/old')
    await store.load('/current')
    resolveOld?.([origin])
    await staleLoad

    expect(store.state.repositoryPath).toBe('/current')
    expect(store.state.remotes).toEqual([upstream])
  })

  it('adds a remote and refreshes the remote facts', async () => {
    const addRemote = vi.fn(async () => origin)
    const getRemotes = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([origin])
    const store = new RemoteStore({
      getRemotes,
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      addRemote,
    })
    await store.load('/repo')
    expect(store.state.remotes).toEqual([])

    await expect(
      store.addRemote('origin', '/remotes/origin.git')
    ).resolves.toBe(true)

    expect(addRemote).toHaveBeenCalledWith(
      '/repo',
      'origin',
      '/remotes/origin.git'
    )
    expect(store.state.remotes).toEqual([origin])
  })

  it('refuses to add a remote without a name and url', async () => {
    const addRemote = vi.fn(async () => origin)
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => []),
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      addRemote,
    })
    await store.load('/repo')

    await expect(store.addRemote('   ', '/x')).resolves.toBe(false)
    await expect(store.addRemote('origin', '   ')).resolves.toBe(false)
    expect(addRemote).not.toHaveBeenCalled()
  })

  it('removes a remote and refreshes the remote facts', async () => {
    const removeRemote = vi.fn(async () => undefined)
    const getRemotes = vi
      .fn()
      .mockResolvedValueOnce([origin])
      .mockResolvedValueOnce([])
    const store = new RemoteStore({
      getRemotes,
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      removeRemote,
    })
    await store.load('/repo')
    expect(store.state.remotes).toEqual([origin])

    await expect(store.removeRemote('origin')).resolves.toBe(true)

    expect(removeRemote).toHaveBeenCalledWith('/repo', 'origin')
    expect(store.state.remotes).toEqual([])
  })

  it('surfaces an add-remote failure through operationError', async () => {
    const addRemote = vi.fn(async () => {
      throw new Error('remote exists')
    })
    const store = new RemoteStore({
      getRemotes: vi.fn(async () => []),
      getBranches: vi.fn(async () => [branch('main', null)]),
      getStatus: vi.fn(async () => ({ currentBranch: 'main' })),
      addRemote,
    })
    await store.load('/repo')

    await expect(store.addRemote('origin', '/x')).resolves.toBe(false)
    expect(store.state.operationError).not.toBeNull()
  })
})
