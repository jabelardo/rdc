import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StashedChangesLoadStates } from '../models/stash-entry'
import { AppFileStatusKind } from '../models/status'
import { ManualConflictResolution } from '../models/manual-conflict-resolution'
import { RebaseResult } from './git-ipc'
import snapshot from './__generated__/wire-snapshot.json'
import { SubmoduleEntry } from '../models/submodule'
import type { ISubmoduleEntryData, IStashEntryData } from './stash-ipc'

/**
 * Checks the stash and cherry-pick boundary.
 *
 * The fixtures come from `wire_contract.rs`. Two things beyond field-matching are worth testing here:
 * a stash entry's `createdAt` crosses as epoch seconds and has to become a `Date`, and its `files`
 * field is a *load state* the backend deliberately doesn't send.
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
  hydrateStashEntry,
  getStashes,
  createStashEntry,
  dropStashEntry,
  popStashEntry,
  getLastStashEntryForBranch,
  renameStashEntry,
  moveStashEntry,
  cherryPick,
  getCherryPickSnapshot,
  continueCherryPick,
  abortCherryPick,
  CherryPickResult,
  listSubmodules,
  resetSubmodulePaths,
  squash,
  reorder,
} = await import('./stash-ipc')

const REPO = '/tmp/repo'

const stashResult = snapshot.stashResult as {
  desktopEntries: ReadonlyArray<IStashEntryData>
  stashEntryCount: number
}
const entryData = stashResult.desktopEntries[0]
const withoutCustomName =
  snapshot.stashEntryWithoutCustomName as IStashEntryData

describe('the stash wire shape', () => {
  it('counts every stash, not one fewer', () => {
    // The upstream off-by-one: with one stash the original reported zero, so the UI saw none.
    expect(stashResult.stashEntryCount).toBe(3)
    expect(stashResult.desktopEntries).toHaveLength(1)
  })

  it('sends createdAt as epoch seconds', () => {
    expect(typeof entryData.createdAt).toBe('number')
    expect(entryData.createdAt).toBe(1475670580)
  })

  it('does not send the frontend-owned files field', () => {
    // It is a load state (NotLoaded/Loading/Loaded), so the backend has nothing to say about it.
    expect('files' in entryData).toBe(false)
  })

  it('sends a null customName rather than omitting it', () => {
    // `string | null` in the model, not optional.
    expect('customName' in withoutCustomName).toBe(true)
    expect(withoutCustomName.customName).toBeNull()
  })

  it('hydrates into a Date and defaults files to NotLoaded', () => {
    const entry = hydrateStashEntry(entryData)

    expect(entry.createdAt).toBeInstanceOf(Date)
    expect(entry.createdAt.getTime()).toBe(1475670580 * 1000)
    expect(entry.files.kind).toBe(StashedChangesLoadStates.NotLoaded)
    expect(entry.customName).toBe('my work')
    expect(entry.branchName).toBe('main')
  })

  it('accepts an already-loaded file list', () => {
    const entry = hydrateStashEntry(entryData, {
      kind: StashedChangesLoadStates.Loaded,
      files: [],
    })
    expect(entry.files.kind).toBe(StashedChangesLoadStates.Loaded)
  })

  it('serializes CherryPickResult as the variant name', () => {
    expect(snapshot.cherryPickResult).toBe(
      CherryPickResult.ConflictsEncountered
    )
  })
})

describe('the stash and cherry-pick commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    channelInstances.length = 0
  })

  it('getStashes hydrates each entry', async () => {
    invoke.mockResolvedValue(stashResult)

    const result = await getStashes(REPO)

    expect(invoke).toHaveBeenCalledWith('get_stashes', {
      repositoryPath: REPO,
    })
    expect(result.stashEntryCount).toBe(3)
    expect(result.desktopEntries[0].createdAt).toBeInstanceOf(Date)
  })

  it('createStashEntry defaults to stashing everything', async () => {
    invoke.mockResolvedValue(true)

    await createStashEntry(REPO, 'main')

    expect(invoke).toHaveBeenCalledWith('create_stash_entry', {
      repositoryPath: REPO,
      branchName: 'main',
      untrackedFilesToStage: [],
      selectedFiles: null,
    })
  })

  it('createStashEntry forwards untracked files and a selection', async () => {
    // Untracked files are separate because stash push with a pathspec ignores them.
    invoke.mockResolvedValue(true)

    await createStashEntry(REPO, 'main', [{ path: 'new.ts' }], ['a.ts'])

    expect(invoke).toHaveBeenCalledWith(
      'create_stash_entry',
      expect.objectContaining({
        untrackedFilesToStage: [{ path: 'new.ts' }],
        selectedFiles: ['a.ts'],
      })
    )
  })

  it('drop and pop send only the sha', async () => {
    await dropStashEntry(REPO, 'abc')
    expect(invoke).toHaveBeenLastCalledWith('drop_stash_entry', {
      repositoryPath: REPO,
      stashSha: 'abc',
    })

    await popStashEntry(REPO, 'abc')
    expect(invoke).toHaveBeenLastCalledWith('pop_stash_entry', {
      repositoryPath: REPO,
      stashSha: 'abc',
    })
  })

  it('getLastStashEntryForBranch distinguishes none with null', async () => {
    invoke.mockResolvedValue(null)
    await expect(getLastStashEntryForBranch(REPO, 'main')).resolves.toBeNull()

    invoke.mockResolvedValue(entryData)
    const entry = await getLastStashEntryForBranch(REPO, 'main')
    expect(entry?.createdAt).toBeInstanceOf(Date)
  })

  it('renameStashEntry sends the entry back without its files, and as epoch seconds', async () => {
    // The backend rebuilds the entry with the same date so it keeps its sort position, so the date has
    // to survive the round trip.
    invoke.mockResolvedValue('newsha')
    const entry = hydrateStashEntry(entryData)

    await renameStashEntry(REPO, entry, 'renamed')

    const sent = invoke.mock.calls[0][1] as {
      entry: Record<string, unknown>
      newName: string
    }
    expect(sent.entry.createdAt).toBe(1475670580)
    expect('files' in sent.entry).toBe(false)
    expect(sent.newName).toBe('renamed')
  })

  it('renameStashEntry resolves to null when nothing changed', async () => {
    // Rebuilding the entry would change its SHA and invalidate what the caller holds.
    invoke.mockResolvedValue(null)
    const entry = hydrateStashEntry(entryData)

    await expect(renameStashEntry(REPO, entry, 'my work')).resolves.toBeNull()
  })

  it('moveStashEntry sends the branch and the dehydrated entry', async () => {
    invoke.mockResolvedValue('newsha')
    const entry = hydrateStashEntry(entryData)

    await moveStashEntry(REPO, entry, 'feature')

    expect(invoke).toHaveBeenCalledWith(
      'move_stash_entry',
      expect.objectContaining({ branchName: 'feature' })
    )
    const sent = invoke.mock.calls[0][1] as { entry: Record<string, unknown> }
    expect('files' in sent.entry).toBe(false)
  })

  it('cherryPick sends the commits and a Channel', async () => {
    invoke.mockResolvedValue(CherryPickResult.CompletedWithoutError)

    const result = await cherryPick(REPO, [{ sha: 'abc', summary: 'a commit' }])

    expect(invoke).toHaveBeenCalledWith('cherry_pick', {
      repositoryPath: REPO,
      commits: [{ sha: 'abc', summary: 'a commit' }],
      onProgress: expect.anything(),
    })
    expect(channelInstances).toHaveLength(1)
    expect(result).toBe(CherryPickResult.CompletedWithoutError)
  })

  it('cherryPick resolves with conflicts rather than rejecting', async () => {
    // Conflicts are an expected outcome the UI drives to resolution, not a failure.
    invoke.mockResolvedValue(CherryPickResult.ConflictsEncountered)

    await expect(cherryPick(REPO, [{ sha: 'a', summary: 's' }])).resolves.toBe(
      CherryPickResult.ConflictsEncountered
    )
  })

  it('getCherryPickSnapshot returns null when nothing is in progress', async () => {
    invoke.mockResolvedValue(null)
    await expect(getCherryPickSnapshot(REPO)).resolves.toBeNull()
    expect(channelInstances).toHaveLength(0)
  })

  it('continueCherryPick sends files and resolutions as pairs', async () => {
    invoke.mockResolvedValue(CherryPickResult.CompletedWithoutError)

    await continueCherryPick(
      REPO,
      [['f.txt', { kind: AppFileStatusKind.Modified }]],
      [['f.txt', ManualConflictResolution.theirs]]
    )

    expect(invoke).toHaveBeenCalledWith('continue_cherry_pick', {
      repositoryPath: REPO,
      files: [['f.txt', { kind: 'Modified' }]],
      manualResolutions: [['f.txt', 'theirs']],
      onProgress: expect.anything(),
    })
  })

  it('continueCherryPick defaults resolutions to empty', async () => {
    invoke.mockResolvedValue(CherryPickResult.CompletedWithoutError)

    await continueCherryPick(REPO, [])

    expect(invoke).toHaveBeenCalledWith(
      'continue_cherry_pick',
      expect.objectContaining({ manualResolutions: [] })
    )
  })

  it('abortCherryPick needs only the path', async () => {
    await abortCherryPick(REPO)
    expect(invoke).toHaveBeenCalledWith('abort_cherry_pick', {
      repositoryPath: REPO,
    })
  })
})

describe('submodules', () => {
  const entry = snapshot.submoduleEntry as ISubmoduleEntryData
  const uninitialized =
    snapshot.uninitializedSubmoduleEntry as ISubmoduleEntryData

  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    channelInstances.length = 0
  })

  it('omits describe for an uninitialized submodule rather than sending null', () => {
    expect(entry.describe).toBe('v1.0')
    expect('describe' in uninitialized).toBe(false)
  })

  it('lists uninitialized submodules, which the original dropped', async () => {
    // The whole point of the fix: this list is what stops a submodule path being trashed, so an
    // omission is a safety issue rather than a display one.
    invoke.mockResolvedValue([entry, uninitialized])

    const submodules = await listSubmodules(REPO)

    expect(invoke).toHaveBeenCalledWith('list_submodules', {
      repositoryPath: REPO,
    })
    expect(submodules).toHaveLength(2)
    expect(submodules[1].path).toBe('other')
  })

  it('normalises a missing describe to null, matching the model', async () => {
    invoke.mockResolvedValue([entry, uninitialized])

    const submodules = await listSubmodules(REPO)

    expect(submodules[0]).toBeInstanceOf(SubmoduleEntry)
    expect(submodules[0].describe).toBe('v1.0')
    expect(submodules[1].describe).toBeNull()
  })

  it('resetSubmodulePaths sends the paths', async () => {
    await resetSubmodulePaths(REPO, ['sub'])

    expect(invoke).toHaveBeenCalledWith('reset_submodule_paths', {
      repositoryPath: REPO,
      paths: ['sub'],
    })
  })
})

describe('squash and reorder', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(RebaseResult.CompletedWithoutError)
    channelInstances.length = 0
  })

  it('squash sends the target separately from the commits being folded', async () => {
    await squash(REPO, ['sha1', 'sha2'], 'sha3', 'sha0', 'combined')

    expect(invoke).toHaveBeenCalledWith('squash', {
      repositoryPath: REPO,
      toSquash: ['sha1', 'sha2'],
      squashOnto: 'sha3',
      lastRetainedCommitRef: 'sha0',
      commitMessage: 'combined',
      onProgress: expect.anything(),
    })
  })

  it('squash sends a null lastRetainedCommitRef to reach the root', async () => {
    // `null` is meaningful — it becomes `--root`, since the first commit has no parent to name.
    await squash(REPO, ['sha1'], 'sha2', null)

    expect(invoke).toHaveBeenCalledWith(
      'squash',
      expect.objectContaining({
        lastRetainedCommitRef: null,
        commitMessage: '',
      })
    )
  })

  it('squash resolves with Error rather than rejecting on a validation failure', async () => {
    // An empty list, a target in the list, or a target missing from the log all land here.
    invoke.mockResolvedValue(RebaseResult.Error)

    await expect(squash(REPO, [], 'sha1', null)).resolves.toBe(
      RebaseResult.Error
    )
  })

  it('reorder sends a null before to move commits to the end', async () => {
    await reorder(REPO, ['sha1'], null, 'sha0')

    expect(invoke).toHaveBeenCalledWith('reorder', {
      repositoryPath: REPO,
      toMove: ['sha1'],
      before: null,
      lastRetainedCommitRef: 'sha0',
      onProgress: expect.anything(),
    })
  })

  it('reorder sends the anchor when there is one', async () => {
    await reorder(REPO, ['sha1', 'sha2'], 'sha3', null)

    expect(invoke).toHaveBeenCalledWith(
      'reorder',
      expect.objectContaining({ before: 'sha3', toMove: ['sha1', 'sha2'] })
    )
  })

  it('both pass a Channel for progress', async () => {
    const callback = vi.fn()

    await squash(REPO, ['a'], 'b', null, '', callback)
    expect(channelInstances).toHaveLength(1)
    expect(channelInstances[0].handler).toBe(callback)

    await reorder(REPO, ['a'], null, null, callback)
    expect(channelInstances).toHaveLength(2)
  })
})
