import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommitIdentity } from '../models/commit-identity'
import type { IRevertProgress } from '../models/progress'
import snapshot from './__generated__/wire-snapshot.json'

/**
 * Checks the boundary for the smaller operations.
 *
 * Three things here need more than field-matching: tags and checkouts arrive as **pairs** and become
 * `Map`s (a name is an arbitrary string, so a plain object would collide with `Object.prototype`
 * members), checkout times cross as epoch seconds and become `Date`s, and revert progress always reports
 * zero.
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
  createTag,
  deleteTag,
  getAllTags,
  fetchTagsToPush,
  revertCommit,
  getRecentBranches,
  getBranchCheckouts,
  getDescription,
  writeDescription,
  getAuthorIdentity,
  cleanUntrackedFiles,
} = await import('./misc-ipc')

const REPO = '/tmp/repo'

describe('the revert progress shape', () => {
  const revertProgress = snapshot.revertProgress as IRevertProgress

  it('always reports zero, which is faithful rather than broken', () => {
    // Upstream's parser had a single step with an empty title and zero weight, so it could never match a
    // line or compute a percentage. A revert has only text to report.
    expect(revertProgress.kind).toBe('revert')
    expect(revertProgress.value).toBe(0)
    expect(revertProgress.title).toBe('')
    expect(revertProgress.description).toBe('Auto-merging a.txt')
  })
})

describe('the smaller commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    channelInstances.length = 0
  })

  // --- tags ---

  it('createTag and deleteTag send what they need', async () => {
    await createTag(REPO, 'v1.0', 'abc123')
    expect(invoke).toHaveBeenLastCalledWith('create_tag', {
      repositoryPath: REPO,
      name: 'v1.0',
      targetCommit: 'abc123',
    })

    await deleteTag(REPO, 'v1.0')
    expect(invoke).toHaveBeenLastCalledWith('delete_tag', {
      repositoryPath: REPO,
      name: 'v1.0',
    })
  })

  it('getAllTags turns pairs into a Map', async () => {
    invoke.mockResolvedValue([
      ['v1.0', 'aaa'],
      ['v2.0', 'bbb'],
    ])

    const tags = await getAllTags(REPO)

    expect(tags).toBeInstanceOf(Map)
    expect(tags.get('v1.0')).toBe('aaa')
    expect(tags.get('v2.0')).toBe('bbb')
    expect(tags.size).toBe(2)
  })

  it('getAllTags handles a tag name that would collide with Object.prototype', async () => {
    // Why pairs and a Map rather than an object: `constructor` and `__proto__` are legal tag names.
    invoke.mockResolvedValue([
      ['constructor', 'aaa'],
      ['__proto__', 'bbb'],
    ])

    const tags = await getAllTags(REPO)

    expect(tags.get('constructor')).toBe('aaa')
    expect(tags.get('__proto__')).toBe('bbb')
    expect(tags.size).toBe(2)
  })

  it('getAllTags resolves to an empty Map when there are no tags', async () => {
    invoke.mockResolvedValue([])
    await expect(getAllTags(REPO)).resolves.toEqual(new Map())
  })

  it('fetchTagsToPush takes isBackgroundTask because it contacts the remote', async () => {
    invoke.mockResolvedValue(['v1.0'])

    await fetchTagsToPush(REPO, 'origin', 'main', true)

    expect(invoke).toHaveBeenCalledWith('fetch_tags_to_push', {
      repositoryPath: REPO,
      remoteName: 'origin',
      branchName: 'main',
      isBackgroundTask: true,
    })
  })

  // --- revert ---

  it('revertCommit sends the parent count and a Channel', async () => {
    // The parent count is what lets a merge commit be reverted at all.
    await revertCommit(REPO, 'abc123', 2)

    expect(invoke).toHaveBeenCalledWith('revert_commit', {
      repositoryPath: REPO,
      commit: 'abc123',
      parentCount: 2,
      onProgress: expect.anything(),
    })
    expect(channelInstances).toHaveLength(1)
  })

  // --- reflog ---

  it('getRecentBranches sends the limit', async () => {
    invoke.mockResolvedValue(['feature', 'main'])

    await expect(getRecentBranches(REPO, 5)).resolves.toEqual([
      'feature',
      'main',
    ])
    expect(invoke).toHaveBeenCalledWith('get_recent_branches', {
      repositoryPath: REPO,
      limit: 5,
    })
  })

  it('getBranchCheckouts converts the date to epoch seconds', async () => {
    invoke.mockResolvedValue([])
    const after = new Date('2024-01-01T00:00:00.000Z')

    await getBranchCheckouts(REPO, after)

    expect(invoke).toHaveBeenCalledWith('get_branch_checkouts', {
      repositoryPath: REPO,
      after: Math.floor(after.getTime() / 1000),
    })
  })

  it('getBranchCheckouts turns pairs into a Map of Dates', async () => {
    invoke.mockResolvedValue([
      ['feature', 1690000100],
      ['main', 1690000000],
    ])

    const checkouts = await getBranchCheckouts(REPO, new Date(0))

    expect(checkouts.get('feature')).toBeInstanceOf(Date)
    expect(checkouts.get('feature')?.getTime()).toBe(1690000100 * 1000)
    expect(checkouts.get('main')?.getTime()).toBe(1690000000 * 1000)
  })

  // --- description ---

  it('getDescription and writeDescription send what they need', async () => {
    invoke.mockResolvedValue('my project\n')
    await expect(getDescription(REPO)).resolves.toBe('my project\n')

    invoke.mockResolvedValue(undefined)
    await writeDescription(REPO, 'renamed\n')
    expect(invoke).toHaveBeenLastCalledWith('write_description', {
      repositoryPath: REPO,
      description: 'renamed\n',
    })
  })

  // --- identity ---

  it('getAuthorIdentity hydrates the identity into a Date-carrying class', async () => {
    invoke.mockResolvedValue({
      name: 'Someone',
      email: 'someone@example.com',
      date: 1475670580,
      tzOffset: 120,
    })

    const identity = await getAuthorIdentity(REPO)

    expect(identity).toBeInstanceOf(CommitIdentity)
    expect(identity?.date).toBeInstanceOf(Date)
    expect(identity?.name).toBe('Someone')
  })

  it('getAuthorIdentity resolves to null when git would refuse to invent one', async () => {
    // Meaningful rather than merely absent: a commit will fail the same way, so the caller should prompt.
    invoke.mockResolvedValue(null)
    await expect(getAuthorIdentity(REPO)).resolves.toBeNull()
  })

  // --- clean ---

  it('cleanUntrackedFiles needs only the path', async () => {
    await cleanUntrackedFiles(REPO)
    expect(invoke).toHaveBeenCalledWith('clean_untracked_files', {
      repositoryPath: REPO,
    })
    expect(channelInstances).toHaveLength(0)
  })
})
