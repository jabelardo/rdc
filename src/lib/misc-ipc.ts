/**
 * The smaller git operations: tags, revert, reflog, description, identity and clean.
 *
 * Grouped as the Rust command module is; the `git-ops` side keeps one module per original file.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import type { IRevertProgress } from '../models/progress'
import { CommitIdentity } from '../models/commit-identity'
import { hydrateCommitIdentity, type ICommitIdentityData } from './log-ipc'

/** Creates an annotated tag on a commit. */
export async function createTag(
  repositoryPath: string,
  name: string,
  targetCommit: string
): Promise<void> {
  return invoke<void>('create_tag', { repositoryPath, name, targetCommit })
}

/** Deletes a local tag. */
export async function deleteTag(
  repositoryPath: string,
  name: string
): Promise<void> {
  return invoke<void>('delete_tag', { repositoryPath, name })
}

/**
 * Every local tag, mapped to the commit it points at.
 *
 * An **annotated** tag maps to its commit, not to its tag object — git reports both and the backend keeps
 * the dereferenced one.
 *
 * Arrives as pairs, because a tag name is an arbitrary string, and is turned into a `Map` here: a `Map`
 * accepts any string key where a plain object would collide with `Object.prototype` members.
 */
export async function getAllTags(
  repositoryPath: string
): Promise<Map<string, string>> {
  const pairs = await invoke<ReadonlyArray<readonly [string, string]>>(
    'get_all_tags',
    { repositoryPath }
  )

  return new Map(pairs)
}

/**
 * The tags a push would send, without sending them.
 *
 * Contacts the remote, so it can fail for the usual authentication reasons.
 */
export async function fetchTagsToPush(
  repositoryPath: string,
  remoteName: string,
  branchName: string,
  isBackgroundTask = false
): Promise<ReadonlyArray<string>> {
  return invoke<ReadonlyArray<string>>('fetch_tags_to_push', {
    repositoryPath,
    remoteName,
    branchName,
    isBackgroundTask,
  })
}

/**
 * Creates a commit undoing another.
 *
 * `parentCount` comes from the commit's `parentSHAs`. A merge commit needs it: undoing one is ambiguous
 * without saying which side is the mainline, and git refuses rather than guessing.
 *
 * Progress `value` is always `0`. That is faithful rather than broken — the upstream parser was a no-op
 * by construction, so a revert has only text to report, never a percentage.
 */
export async function revertCommit(
  repositoryPath: string,
  commit: string,
  parentCount: number,
  progressCallback?: (progress: IRevertProgress) => void
): Promise<void> {
  const onProgress = new Channel<IRevertProgress>(progressCallback)

  return invoke<void>('revert_commit', {
    repositoryPath,
    commit,
    parentCount,
    onProgress,
  })
}

/**
 * The most recently checked-out branches, newest first.
 *
 * A branch that was renamed away is excluded: it no longer exists, so offering it would give the user a
 * name nothing can check out.
 */
export async function getRecentBranches(
  repositoryPath: string,
  limit: number
): Promise<ReadonlyArray<string>> {
  return invoke<ReadonlyArray<string>>('get_recent_branches', {
    repositoryPath,
    limit,
  })
}

/**
 * When each branch was last checked out, for checkouts at or after `after`.
 *
 * Times cross as epoch **seconds** and become `Date`s here, matching the other timestamps on this
 * boundary.
 */
export async function getBranchCheckouts(
  repositoryPath: string,
  after: Date
): Promise<Map<string, Date>> {
  const pairs = await invoke<ReadonlyArray<readonly [string, number]>>(
    'get_branch_checkouts',
    { repositoryPath, after: Math.floor(after.getTime() / 1000) }
  )

  return new Map(pairs.map(([branch, when]) => [branch, new Date(when * 1000)]))
}

/**
 * The repository's description, or an empty string if it has none.
 *
 * The placeholder `git init` writes counts as none, since it isn't something the user chose.
 */
export async function getDescription(
  repositoryPath: string
): Promise<string> {
  return invoke<string>('get_description', { repositoryPath })
}

/** Writes the repository's description. */
export async function writeDescription(
  repositoryPath: string,
  description: string
): Promise<void> {
  return invoke<void>('write_description', { repositoryPath, description })
}

/**
 * The identity a commit made now would carry.
 *
 * Different from reading `user.name`/`user.email`: git synthesises one from the system user when those
 * aren't set, and this reports what it would *actually* use.
 *
 * `null` means git declined to invent one, so a commit will fail the same way — prompt rather than
 * proceed.
 */
export async function getAuthorIdentity(
  repositoryPath: string
): Promise<CommitIdentity | null> {
  const identity = await invoke<ICommitIdentityData | null>(
    'get_author_identity',
    { repositoryPath }
  )

  return identity === null ? null : hydrateCommitIdentity(identity)
}

/**
 * Deletes untracked files and directories.
 *
 * **Irreversible** — these files are not in git, so nothing can restore them. Ignored files are left
 * alone.
 */
export async function cleanUntrackedFiles(
  repositoryPath: string
): Promise<void> {
  return invoke<void>('clean_untracked_files', { repositoryPath })
}

/**
 * Vouches for a repository git refuses to work in because it's owned by someone else.
 *
 * Takes a **path rather than a repository**, and writes the user's *global* config, because git won't
 * read a repository's own configuration until it trusts the path. That is also why this is the only way
 * out of git's "dubious ownership" refusal — the caller reaches it after `getRepositoryType` reports the
 * path as unsafe.
 *
 * Safe to call more than once: an identical entry is never added twice.
 */
export async function addSafeDirectory(path: string): Promise<void> {
  await invoke('add_safe_directory', { path })
}
