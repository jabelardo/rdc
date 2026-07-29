import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IRemote } from '../models/remote'
import type {
  ICloneProgress,
  IFetchProgress,
  IPullProgress,
  IPushProgress,
} from '../models/progress'
import snapshot from './__generated__/wire-snapshot.json'

/**
 * Checks the remote-operation boundary.
 *
 * Two halves, as elsewhere: the progress shapes are compared against Rust's own serializer output
 * through fixtures `tsc` has checked against `src/models/progress.ts`, and the command names and
 * argument names are pinned by mocking `invoke`.
 *
 * The `Channel` is mocked too. It is a real Tauri object with no runtime here, and what matters for
 * the contract is that one is passed as `onProgress` at all — a plain callback would be silently
 * dropped by Tauri.
 */
const invoke = vi.hoisted(() => vi.fn())
const channelInstances = vi.hoisted(() => [] as Array<{ handler?: unknown }>)

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    public handler?: unknown
    public constructor(handler?: unknown) {
      this.handler = handler
      channelInstances.push(this)
    }
  },
}))

const {
  push,
  deleteRemoteBranch,
  fetch,
  pull,
  fastForwardBranches,
  clone,
  getRemotes,
  addRemote,
  removeRemote,
  setRemoteURL,
  getRemoteURL,
  updateRemoteHEAD,
  getRemoteHEAD,
} = await import('./remote-ipc')

const REPO = '/tmp/repo'

// --- progress shapes, from Rust's serializer ---

const pushProgress: IPushProgress = snapshot.pushProgress as IPushProgress
const pushProgressInitial: IPushProgress =
  snapshot.pushProgressInitial as IPushProgress
const fetchProgress: IFetchProgress = snapshot.fetchProgress as IFetchProgress
const pullProgress: IPullProgress = snapshot.pullProgress as IPullProgress
const cloneProgress: ICloneProgress = snapshot.cloneProgress as ICloneProgress
const remote: IRemote = snapshot.remote as IRemote

describe('the remote progress shapes', () => {
  it('match the ported progress models', () => {
    // Annotating rather than casting is the check: if Rust drifted, these declarations stop compiling.
    expect(pushProgress.kind).toBe('push')
    expect(fetchProgress.kind).toBe('fetch')
    expect(pullProgress.kind).toBe('pull')
  })

  it('carry the remote, and for a push the branch', () => {
    expect(pushProgress.remote).toBe('origin')
    expect(pushProgress.branch).toBe('main')
    expect(fetchProgress.remote).toBe('origin')
    expect(pullProgress.remote).toBe('origin')
  })

  it('report value as a fraction rather than a percentage', () => {
    // 0–1, not 0–100: the UI multiplies. A backend switching to percentages would render as 6200%.
    for (const progress of [pushProgress, fetchProgress, pullProgress]) {
      expect(progress.value).toBeGreaterThan(0)
      expect(progress.value).toBeLessThanOrEqual(1)
    }
  })

  it('a clone reports no remote, since it has none configured yet', () => {
    // The one way clone progress differs from the others. `IRemote` fields would be meaningless here.
    expect(cloneProgress.kind).toBe('clone')
    expect('remote' in cloneProgress).toBe(false)
    expect(cloneProgress.title).toContain('Cloning into ')
  })

  it('a remote is a name and a fetch url', () => {
    expect(remote).toEqual({
      name: 'origin',
      url: 'https://github.com/o/r.git',
    })
  })

  it('omit the description on the initial update rather than sending null', () => {
    // `IProgress.description` is optional, so absent must mean absent.
    expect('description' in pushProgressInitial).toBe(false)
    expect(pushProgressInitial.value).toBe(0)
    expect(pushProgress.description).toBe('Writing objects:  60% (3/5)')
  })
})

// --- command and argument names ---

describe('the remote commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    channelInstances.length = 0
  })

  it('push sends a null remoteBranch to set the upstream', async () => {
    await push(REPO, 'origin', 'main', null)

    expect(invoke).toHaveBeenCalledWith('push', {
      repositoryPath: REPO,
      remoteName: 'origin',
      localBranch: 'main',
      remoteBranch: null,
      tags: [],
      options: {},
      isBackgroundTask: false,
      onProgress: expect.anything(),
      // Hook interception is off unless asked for; covered in hook-ipc.test.ts.
      interceptHooks: false,
      onHookProgress: expect.anything(),
    })
  })

  it('push forwards tags and options', async () => {
    await push(REPO, 'origin', 'main', 'main', ['v1.0'], {
      forceWithLease: true,
    })

    expect(invoke).toHaveBeenCalledWith(
      'push',
      expect.objectContaining({
        remoteBranch: 'main',
        tags: ['v1.0'],
        options: { forceWithLease: true },
      })
    )
  })

  it('push passes a Channel, not the callback itself', async () => {
    // Tauri only streams to a Channel; handing it a bare function would silently deliver nothing.
    const callback = vi.fn()
    await push(REPO, 'origin', 'main', null, [], {}, callback)

    // Two Channels now: progress, then the hook Channel every hook-capable command carries. Asserting on
    // the *progress* one keeps this about what it was written to check.
    expect(channelInstances[0].handler).toBe(callback)

    const sent = invoke.mock.calls[0][1] as { onProgress: unknown }
    expect(sent.onProgress).toBe(channelInstances[0])
  })

  it('push still passes a Channel when no callback is given', async () => {
    // The Rust side always enables --progress, so a Channel must always be there to receive it.
    await push(REPO, 'origin', 'main', null)

    expect(channelInstances[0].handler).toBeUndefined()
  })

  it('fetch defaults isBackgroundTask to false', async () => {
    // The default that matters: a call site that hasn't considered it is almost certainly
    // user-initiated, and getting this wrong the other way suppresses prompts silently.
    await fetch(REPO, 'origin')

    expect(invoke).toHaveBeenCalledWith('fetch', {
      repositoryPath: REPO,
      remoteName: 'origin',
      isBackgroundTask: false,
      onProgress: expect.anything(),
    })
  })

  it('fetch forwards isBackgroundTask when set', async () => {
    await fetch(REPO, 'origin', undefined, true)

    expect(invoke).toHaveBeenCalledWith(
      'fetch',
      expect.objectContaining({ isBackgroundTask: true })
    )
  })

  it('deleteRemoteBranch sends no Channel, since a deletion has no progress', async () => {
    await deleteRemoteBranch(REPO, 'origin', 'topic')

    expect(invoke).toHaveBeenCalledWith('delete_remote_branch', {
      repositoryPath: REPO,
      remoteName: 'origin',
      remoteBranchName: 'topic',
      isBackgroundTask: false,
    })
    expect(channelInstances).toHaveLength(0)
  })

  it('deleteRemoteBranch forwards isBackgroundTask when set', async () => {
    await deleteRemoteBranch(REPO, 'origin', 'topic', true)

    expect(invoke).toHaveBeenCalledWith(
      'delete_remote_branch',
      expect.objectContaining({ isBackgroundTask: true })
    )
  })

  it('pull sends noVerify and isBackgroundTask', async () => {
    await pull(REPO, 'origin', undefined, true, true)

    expect(invoke).toHaveBeenCalledWith('pull', {
      repositoryPath: REPO,
      remoteName: 'origin',
      noVerify: true,
      isBackgroundTask: true,
      onProgress: expect.anything(),
      interceptHooks: false,
      onHookProgress: expect.anything(),
    })
  })

  it('fastForwardBranches sends pairs and no channel', async () => {
    // No progress to report, so no Channel — and pairs because a ref name is an arbitrary string.
    await fastForwardBranches(REPO, [
      ['refs/remotes/origin/main', 'refs/heads/main'],
    ])

    expect(invoke).toHaveBeenCalledWith('fast_forward_branches', {
      repositoryPath: REPO,
      branches: [['refs/remotes/origin/main', 'refs/heads/main']],
    })
    expect(channelInstances).toHaveLength(0)
  })

  it('propagates a command error rather than swallowing it', async () => {
    // An authentication failure has to reach the caller, since it is the recoverable one.
    invoke.mockRejectedValue({
      message: 'Authentication failed: the credential prompt was cancelled',
      kind: 'HTTPSAuthenticationFailed',
      isAuthFailure: true,
    })

    await expect(push(REPO, 'origin', 'main', null)).rejects.toMatchObject({
      isAuthFailure: true,
    })
  })
})


describe('the clone and remote commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    channelInstances.length = 0
  })

  it('clone defaults login to null rather than omitting it', async () => {
    // `null` is meaningful — it means "use whatever account the helper picks" — so it must be sent.
    await clone('https://github.com/o/r.git', '/home/me/r')

    expect(invoke).toHaveBeenCalledWith('clone', {
      url: 'https://github.com/o/r.git',
      path: '/home/me/r',
      login: null,
      options: {},
      isBackgroundTask: false,
      onProgress: expect.anything(),
    })
  })

  it('clone forwards a login and options', async () => {
    await clone('https://github.com/o/r.git', '/home/me/r', 'octocat', {
      branch: 'topic',
      defaultBranch: 'trunk',
    })

    expect(invoke).toHaveBeenCalledWith(
      'clone',
      expect.objectContaining({
        login: 'octocat',
        options: { branch: 'topic', defaultBranch: 'trunk' },
      })
    )
  })

  it('clone passes a Channel for progress', async () => {
    const callback = vi.fn()
    await clone('u', '/p', null, {}, callback)

    expect(channelInstances).toHaveLength(1)
    expect(channelInstances[0].handler).toBe(callback)
  })

  it('getRemotes hydrates nothing — remotes are plain data', async () => {
    invoke.mockResolvedValue([remote])

    const remotes = await getRemotes(REPO)

    expect(invoke).toHaveBeenCalledWith('get_remotes', { repositoryPath: REPO })
    expect(remotes).toEqual([remote])
  })

  it('getRemotes resolves to an empty array for a path that is not a repository', async () => {
    invoke.mockResolvedValue([])
    await expect(getRemotes('/not/a/repo')).resolves.toEqual([])
  })

  it('addRemote sends the name and url and resolves to the remote', async () => {
    invoke.mockResolvedValue(remote)

    const added = await addRemote(REPO, 'origin', 'https://github.com/o/r.git')

    expect(invoke).toHaveBeenCalledWith('add_remote', {
      repositoryPath: REPO,
      name: 'origin',
      url: 'https://github.com/o/r.git',
    })
    expect(added).toEqual(remote)
  })

  it('removeRemote and setRemoteURL send what they need', async () => {
    await removeRemote(REPO, 'origin')
    expect(invoke).toHaveBeenLastCalledWith('remove_remote', {
      repositoryPath: REPO,
      name: 'origin',
    })

    await setRemoteURL(REPO, 'origin', 'https://example.invalid/new.git')
    expect(invoke).toHaveBeenLastCalledWith('set_remote_url', {
      repositoryPath: REPO,
      name: 'origin',
      url: 'https://example.invalid/new.git',
    })
  })

  it('getRemoteURL distinguishes a missing remote with null', async () => {
    invoke.mockResolvedValue(null)
    await expect(getRemoteURL(REPO, 'nope')).resolves.toBeNull()

    invoke.mockResolvedValue('https://github.com/o/r.git')
    await expect(getRemoteURL(REPO, 'origin')).resolves.toBe(
      'https://github.com/o/r.git'
    )
  })

  it('updateRemoteHEAD takes isBackgroundTask because it contacts the remote', async () => {
    await updateRemoteHEAD(REPO, 'origin', true)

    expect(invoke).toHaveBeenCalledWith('update_remote_head', {
      repositoryPath: REPO,
      name: 'origin',
      isBackgroundTask: true,
    })
  })

  it('getRemoteHEAD needs no session, since it only reads what was recorded', async () => {
    invoke.mockResolvedValue('main')

    await expect(getRemoteHEAD(REPO, 'origin')).resolves.toBe('main')
    expect(invoke).toHaveBeenCalledWith('get_remote_head', {
      repositoryPath: REPO,
      name: 'origin',
    })
    expect(channelInstances).toHaveLength(0)
  })
})
