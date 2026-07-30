import { describe, expect, it, vi } from 'vitest'
import {
  DiffSelection,
  DiffSelectionType,
} from '../models/diff'
import { GitResetMode } from '../models/git-reset-mode'
import { IndexStatus } from '../models/index-status'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../models/status'
import {
  discardChanges,
  TrashDiscardError,
} from './discard-changes'

function file(
  path: string,
  status: WorkingDirectoryFileChange['status']
): WorkingDirectoryFileChange {
  return new WorkingDirectoryFileChange(
    path,
    status,
    DiffSelection.fromInitialSelection(DiffSelectionType.All)
  )
}

function dependencies() {
  return {
    resolvePath: vi.fn(async (repositoryPath, path) =>
      `${repositoryPath}/${path}`
    ),
    moveItemToTrash: vi.fn(async () => undefined),
    permanentlyDeleteRepositoryPath: vi.fn(async () => undefined),
    getIndexChanges: vi.fn(async () => [
      ['new-name.ts', IndexStatus.Added] as const,
      ['old-name.ts', IndexStatus.Deleted] as const,
      ['module', IndexStatus.Modified] as const,
    ]),
    listSubmodules: vi.fn(async () => [
      { path: 'module', sha: 'a'.repeat(40), describe: null },
    ]),
    resetSubmodulePaths: vi.fn(async () => undefined),
    resetPaths: vi.fn(async () => undefined),
    checkoutIndex: vi.fn(async () => undefined),
  }
}

describe('discardChanges', () => {
  it('trashes recoverable files and restores Git and submodule paths', async () => {
    const deps = dependencies()
    const files = [
      file('modified.ts', { kind: AppFileStatusKind.Modified }),
      file('deleted.ts', { kind: AppFileStatusKind.Deleted }),
      file('untracked.ts', { kind: AppFileStatusKind.Untracked }),
      file('new-name.ts', {
        kind: AppFileStatusKind.Renamed,
        oldPath: 'old-name.ts',
        renameIncludesModifications: false,
      }),
      file('module', {
        kind: AppFileStatusKind.Modified,
        submoduleStatus: {
          commitChanged: true,
          modifiedChanges: true,
          untrackedChanges: false,
        },
      }),
    ]

    await discardChanges('/repo', files, {}, deps)

    expect(deps.moveItemToTrash.mock.calls).toEqual([
      ['/repo/modified.ts'],
      ['/repo/untracked.ts'],
      ['/repo/new-name.ts'],
    ])
    expect(deps.resetSubmodulePaths).toHaveBeenCalledWith('/repo', [
      'module',
    ])
    expect(deps.resetPaths).toHaveBeenCalledWith(
      '/repo',
      GitResetMode.Mixed,
      'HEAD',
      ['new-name.ts', 'old-name.ts', 'module']
    )
    expect(deps.checkoutIndex).toHaveBeenCalledWith('/repo', [
      'modified.ts',
      'deleted.ts',
      'untracked.ts',
      'old-name.ts',
      'module',
    ])
  })

  it('does not make an unrecoverable fallback when trash fails', async () => {
    const deps = dependencies()
    deps.moveItemToTrash.mockRejectedValue(new Error('trash unavailable'))

    await expect(
      discardChanges(
        '/repo',
        [
          file('untracked.ts', {
            kind: AppFileStatusKind.Untracked,
          }),
        ],
        {},
        deps
      )
    ).rejects.toBeInstanceOf(TrashDiscardError)

    expect(deps.permanentlyDeleteRepositoryPath).not.toHaveBeenCalled()
    expect(deps.resetPaths).not.toHaveBeenCalled()
    expect(deps.checkoutIndex).not.toHaveBeenCalled()
  })

  it('permanently removes only untracked files after explicit confirmation', async () => {
    const deps = dependencies()
    deps.getIndexChanges.mockResolvedValue([])

    await discardChanges(
      '/repo',
      [
        file('modified.ts', { kind: AppFileStatusKind.Modified }),
        file('untracked.ts', { kind: AppFileStatusKind.Untracked }),
        file('deleted.ts', { kind: AppFileStatusKind.Deleted }),
      ],
      { permanentlyDelete: true },
      deps
    )

    expect(deps.moveItemToTrash).not.toHaveBeenCalled()
    expect(deps.resolvePath).not.toHaveBeenCalled()
    expect(deps.permanentlyDeleteRepositoryPath).toHaveBeenCalledOnce()
    expect(deps.permanentlyDeleteRepositoryPath).toHaveBeenCalledWith(
      '/repo',
      'untracked.ts'
    )
    expect(deps.checkoutIndex).toHaveBeenCalledWith('/repo', [
      'modified.ts',
      'untracked.ts',
      'deleted.ts',
    ])
  })
})
