/**
 * Linked worktrees, across the IPC boundary.
 *
 * `crates/git-ops/src/worktree.rs` parses git's porcelain listing; the `WorktreeEntry` shape it sends is the
 * one `src/models/worktree.ts` already declares, so nothing needs hydrating — every field is plain data.
 */

import { invoke } from '@tauri-apps/api/core'
import type { WorktreeEntry } from '../models/worktree'

/**
 * The worktrees a repository has.
 *
 * The main worktree is included, and git lists it first — so a repository with no linked worktrees still
 * reports one entry rather than none.
 */
export async function listWorktrees(
  repositoryPath: string
): Promise<ReadonlyArray<WorktreeEntry>> {
  return invoke<ReadonlyArray<WorktreeEntry>>('list_worktrees', {
    repositoryPath,
  })
}

/**
 * The same, for a repository named by its **git directory**.
 *
 * A linked worktree's `.git` is a file pointing elsewhere, so there are situations — a worktree whose working
 * directory has been deleted, for instance — where the git directory is the only handle left.
 */
export async function listWorktreesFromGitDir(
  gitDir: string
): Promise<ReadonlyArray<WorktreeEntry>> {
  return invoke<ReadonlyArray<WorktreeEntry>>('list_worktrees_from_git_dir', {
    gitDir,
  })
}

/**
 * The same again, reading git's administrative files directly.
 *
 * For a git directory git itself can no longer enumerate — see `git_ops::worktree` for exactly when that
 * happens.
 */
export async function listWorktreesFromGitDirFallback(
  gitDir: string
): Promise<ReadonlyArray<WorktreeEntry>> {
  return invoke<ReadonlyArray<WorktreeEntry>>(
    'list_worktrees_from_git_dir_fallback',
    { gitDir }
  )
}

/**
 * Creates a linked worktree.
 *
 * `createBranch` and `commitish` mean different things: the first checks out a *new* branch there, the second
 * an existing revision. Neither means git picks `HEAD`.
 */
export async function addWorktree(
  repositoryPath: string,
  path: string,
  options: { createBranch?: string; commitish?: string } = {}
): Promise<void> {
  await invoke('add_worktree', {
    repositoryPath,
    path,
    createBranch: options.createBranch,
    commitish: options.commitish,
  })
}

/**
 * Removes a linked worktree.
 *
 * `force` removes one with changes in it; without it git refuses, which is the behaviour to keep unless the
 * user has been asked.
 */
export async function removeWorktree(
  repositoryPath: string,
  worktree: string,
  force = false
): Promise<void> {
  await invoke('remove_worktree', { repositoryPath, worktree, force })
}

/** Moves a linked worktree to a new path. */
export async function moveWorktree(
  repositoryPath: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  await invoke('move_worktree', { repositoryPath, oldPath, newPath })
}
