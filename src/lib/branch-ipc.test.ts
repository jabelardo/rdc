import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Branch, BranchType, type ITrackingBranch } from '../models/branch'
import snapshot from './__generated__/wire-snapshot.json'

/**
 * Checks the branch boundary.
 *
 * The interesting property is that the wire shape can *build* the `Branch` class: its getters derive
 * `remoteName`, `nameWithoutRemote` and `upstreamRemoteName`, and those are what the UI shows. So the
 * assertions below go through the getters rather than comparing fields — a wire shape that satisfied
 * the type but carried, say, an unprefixed remote ref would pass a field comparison and fail here.
 */
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const {
  getBranches,
  getBranchesDifferingFromUpstream,
  hydrateBranch,
  createBranch,
  renameBranch,
  deleteLocalBranch,
  getBranchesPointedAt,
  getMergedBranches,
  deleteRef,
  getSymbolicRef,
} = await import('./branch-ipc')

// Annotated, not cast: assignability to the ported wire type is the check. `type` is the exception —
// a JSON import widens the numeric enum to `number`.
const localBranch = {
  ...snapshot.branch,
  type: snapshot.branch.type as BranchType,
}
const goneBranch = {
  ...snapshot.goneBranch,
  type: snapshot.goneBranch.type as BranchType,
}
const remoteBranch = {
  ...snapshot.remoteBranch,
  type: snapshot.remoteBranch.type as BranchType,
}
const trackingBranch: ITrackingBranch = snapshot.trackingBranch

const REPO = '/tmp/repo'

describe('the branch wire shape', () => {
  it('builds a local branch, deriving its upstream remote', () => {
    const branch = hydrateBranch(localBranch)

    expect(branch).toBeInstanceOf(Branch)
    expect(branch.name).toBe('main')
    expect(branch.type).toBe(BranchType.Local)
    expect(branch.ref).toBe('refs/heads/main')
    expect(branch.upstream).toBe('origin/main')
    // Derived, and the reason Rust sends constructor arguments rather than a finished object.
    expect(branch.upstreamRemoteName).toBe('origin')
    expect(branch.upstreamWithoutRemote).toBe('main')
    expect(branch.nameWithoutRemote).toBe('main')
    // A local branch has no remote of its own.
    expect(branch.remoteName).toBeNull()
  })

  it('builds a remote branch, deriving the remote from its ref', () => {
    const branch = hydrateBranch(remoteBranch)

    expect(branch.type).toBe(BranchType.Remote)
    // `remoteName` throws unless the ref is `refs/remotes/<remote>/…`, so this exercises the one
    // place the wire shape could satisfy the type and still be wrong.
    expect(branch.remoteName).toBe('origin')
    expect(branch.nameWithoutRemote).toBe('main')
    expect(branch.upstream).toBeNull()
    expect(branch.upstreamRemoteName).toBeNull()
  })

  it('turns the tip date into a Date', () => {
    const branch = hydrateBranch(localBranch)

    expect(branch.tip.author.date).toBeInstanceOf(Date)
    expect(branch.tip.author.date.getTime()).toBe(snapshot.branch.tip.author.date * 1000)
    expect(branch.tip.sha).toHaveLength(40)
  })

  it('sends epoch seconds, not a formatted date', () => {
    // The original asked git for `iso8601` and handed the string to `new Date()`, which is not a
    // format the spec requires an engine to parse. A number leaves nothing to parse.
    expect(typeof snapshot.branch.tip.author.date).toBe('number')
  })

  it('reports a deleted upstream while still saying what was tracked', () => {
    const branch = hydrateBranch(goneBranch)

    expect(branch.isGone).toBe(true)
    expect(branch.upstream).toBe('origin/topic')
  })

  it('sends null rather than omitting an absent upstream', () => {
    // `upstream` is `string | null` on the class, not optional — so the field must be present.
    expect('upstream' in snapshot.remoteBranch).toBe(true)
    expect(snapshot.remoteBranch.upstream).toBeNull()
  })

  it('keeps BranchType numeric, since its values decide sort order', () => {
    expect(snapshot.branch.type).toBe(0)
    expect(snapshot.remoteBranch.type).toBe(1)
    expect(BranchType.Local).toBeLessThan(BranchType.Remote)
  })

  it('describes a tracking branch with both refs and both SHAs', () => {
    // What `fastForwardBranches` needs: it builds `<upstreamRef>:<ref>`.
    expect(trackingBranch.ref).toBe('refs/heads/behind')
    expect(trackingBranch.upstreamRef).toBe('refs/remotes/origin/behind')
    expect(trackingBranch.sha).not.toBe(trackingBranch.upstreamSha)
    expect(`${trackingBranch.upstreamRef}:${trackingBranch.ref}`).toBe(
      'refs/remotes/origin/behind:refs/heads/behind'
    )
  })
})

describe('the branch commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
  })

  it('getBranches defaults to every namespace', async () => {
    await getBranches(REPO)

    expect(invoke).toHaveBeenCalledWith('get_branches', {
      repositoryPath: REPO,
      prefixes: [],
    })
  })

  it('getBranches passes the prefixes through and hydrates the result', async () => {
    invoke.mockResolvedValue([localBranch, remoteBranch])

    const branches = await getBranches(REPO, ['refs/heads'])

    expect(invoke).toHaveBeenCalledWith('get_branches', {
      repositoryPath: REPO,
      prefixes: ['refs/heads'],
    })
    expect(branches).toHaveLength(2)
    expect(branches[0]).toBeInstanceOf(Branch)
    expect(branches[1].remoteName).toBe('origin')
  })

  it('getBranches resolves to an empty array outside a repository', async () => {
    invoke.mockResolvedValue([])
    await expect(getBranches(REPO)).resolves.toEqual([])
  })

  it('getBranchesDifferingFromUpstream needs only the path and no hydration', async () => {
    invoke.mockResolvedValue([trackingBranch])

    const branches = await getBranchesDifferingFromUpstream(REPO)

    expect(invoke).toHaveBeenCalledWith('get_branches_differing_from_upstream', {
      repositoryPath: REPO,
    })
    // Four strings, so what Rust sent is what the caller gets.
    expect(branches).toEqual([trackingBranch])
  })
})

describe('the branch operations', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
  })

  it('createBranch sends the start point and noTrack', async () => {
    await createBranch(REPO, 'topic', 'main', true)

    expect(invoke).toHaveBeenCalledWith('create_branch', {
      repositoryPath: REPO,
      name: 'topic',
      startPoint: 'main',
      noTrack: true,
    })
  })

  it('createBranch defaults noTrack to false and omits the start point', async () => {
    await createBranch(REPO, 'topic')

    expect(invoke).toHaveBeenCalledWith('create_branch', {
      repositoryPath: REPO,
      name: 'topic',
      startPoint: undefined,
      noTrack: false,
    })
  })

  it('renameBranch distinguishes an omitted force from false', async () => {
    // Omitted allows a case-only rename by retrying with -M; false refuses every collision. Sending `false`
    // for an absent argument would quietly break renaming `Topic` to `topic`.
    await renameBranch(REPO, 'Topic', 'topic')
    expect(invoke).toHaveBeenLastCalledWith('rename_branch', {
      repositoryPath: REPO,
      currentName: 'Topic',
      newName: 'topic',
      force: undefined,
    })

    await renameBranch(REPO, 'a', 'b', false)
    expect(invoke).toHaveBeenLastCalledWith(
      'rename_branch',
      expect.objectContaining({ force: false })
    )
  })

  it('deleteLocalBranch sends the branch name', async () => {
    await deleteLocalBranch(REPO, 'topic')

    expect(invoke).toHaveBeenCalledWith('delete_local_branch', {
      repositoryPath: REPO,
      branchName: 'topic',
    })
  })

  it('getBranchesPointedAt distinguishes no branches from an unresolvable committish', async () => {
    invoke.mockResolvedValue([])
    await expect(getBranchesPointedAt(REPO, 'HEAD')).resolves.toEqual([])

    invoke.mockResolvedValue(null)
    await expect(getBranchesPointedAt(REPO, 'nope')).resolves.toBeNull()
  })

  it('getMergedBranches turns pairs into a Map', async () => {
    // Pairs on the wire because a ref name is an arbitrary string; a Map accepts any string as a key.
    invoke.mockResolvedValue([
      ['refs/heads/topic', 'a'.repeat(40)],
      ['refs/heads/constructor', 'b'.repeat(40)],
    ])

    const merged = await getMergedBranches(REPO, 'main')

    expect(merged).toBeInstanceOf(Map)
    expect(merged.get('refs/heads/topic')).toHaveLength(40)
    expect(merged.get('refs/heads/constructor')).toHaveLength(40)
    expect(merged.size).toBe(2)
  })

  it('deleteRef sends an optional reason', async () => {
    await deleteRef(REPO, 'refs/remotes/origin/topic')
    expect(invoke).toHaveBeenLastCalledWith('delete_ref', {
      repositoryPath: REPO,
      refName: 'refs/remotes/origin/topic',
      reason: undefined,
    })

    await deleteRef(REPO, 'refs/heads/topic', 'branch deleted')
    expect(invoke).toHaveBeenLastCalledWith(
      'delete_ref',
      expect.objectContaining({ reason: 'branch deleted' })
    )
  })

  it('getSymbolicRef resolves to null for a ref that is not symbolic', async () => {
    invoke.mockResolvedValue(null)

    await expect(getSymbolicRef(REPO, 'refs/heads/main')).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith('get_symbolic_ref', {
      repositoryPath: REPO,
      refName: 'refs/heads/main',
    })
  })
})
