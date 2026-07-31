import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Branch, BranchType } from '../models/branch'

/**
 * Checks the ahead/behind boundary.
 *
 * The interesting part is what *doesn't* reach Rust: `getBranchAheadBehind` answers `null` for a remote branch
 * or one with no upstream without asking git at all, because those are decisions the frontend can make from
 * data it already holds.
 */
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { getAheadBehind, getBranchAheadBehind } = await import('./rev-list-ipc')

const REPO = '/tmp/repo'

function branch(
  name: string,
  upstream: string | null,
  type = BranchType.Local
): Branch {
  return new Branch(
    name,
    upstream,
    { sha: 'a'.repeat(40), author: { date: new Date(0) } },
    type,
    type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/${name}`,
    false
  )
}

describe('getAheadBehind', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ ahead: 1, behind: 2 })
  })

  it('sends the range as the caller built it', async () => {
    await expect(getAheadBehind(REPO, 'main...topic')).resolves.toEqual({
      ahead: 1,
      behind: 2,
    })
    expect(invoke).toHaveBeenCalledWith('get_ahead_behind', {
      repositoryPath: REPO,
      range: 'main...topic',
    })
  })

  it('passes null through, which means the range has a missing ref', async () => {
    // Most often a deleted upstream. An error here would turn a blank label into a failed operation.
    invoke.mockResolvedValue(null)
    await expect(getAheadBehind(REPO, 'main...origin/gone')).resolves.toBeNull()
  })
})

describe('getBranchAheadBehind', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ ahead: 0, behind: 3 })
  })

  it('compares a local branch with its upstream, through the merge base', async () => {
    // The three-dot form is deliberate: it goes back to the merge base, so the counts see through a merge.
    await getBranchAheadBehind(REPO, branch('topic', 'origin/topic'))

    expect(invoke).toHaveBeenCalledWith('get_ahead_behind', {
      repositoryPath: REPO,
      range: 'topic...origin/topic',
    })
  })

  it('answers null for a remote branch without asking git', async () => {
    await expect(
      getBranchAheadBehind(REPO, branch('origin/main', null, BranchType.Remote))
    ).resolves.toBeNull()

    expect(invoke).not.toHaveBeenCalled()
  })

  it('answers null for a local branch with no upstream without asking git', async () => {
    await expect(
      getBranchAheadBehind(REPO, branch('local-only', null))
    ).resolves.toBeNull()

    expect(invoke).not.toHaveBeenCalled()
  })
})
