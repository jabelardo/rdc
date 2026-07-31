/**
 * The smaller git operations: tags, revert, reflog, description, identity and clean.
 *
 * Grouped as the Rust command module is; the `git-ops` side keeps one module per original file.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import type { IRevertProgress } from '../models/progress'
import { CommitIdentity } from '../models/commit-identity'
import type { MergeTreeResult } from '../models/merge'
import type { RepositoryType } from '../models/repository-type'
import type { ITrailer } from '../models/trailer'
import type { IRebaseInternalState } from './git-ipc'
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
export async function getDescription(repositoryPath: string): Promise<string> {
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

// --- configuration ---

/**
 * Reads a config value, or `null` when the key isn't set.
 *
 * `onlyLocal` restricts the lookup to the repository's own config, ignoring the global and system files;
 * omitted means the full cascade, which is what git itself answers with.
 *
 * `null` is not an error — git exits 1 for an unset key, and "not configured" is an answer.
 */
export async function getConfigValue(
  repositoryPath: string,
  name: string,
  onlyLocal = false
): Promise<string | null> {
  return invoke<string | null>('get_config_value', {
    repositoryPath,
    name,
    onlyLocal,
  })
}

/** Returns the user's global git config path, creating the file if necessary. */
export async function getGlobalConfigPath(): Promise<string> {
  return invoke<string>('get_global_config_path')
}

// --- .gitignore ---

/** The repository's root `.gitignore`, or `null` if there isn't one. */
export async function readGitignoreAtRoot(
  repositoryPath: string
): Promise<string | null> {
  return invoke<string | null>('read_gitignore_at_root', { repositoryPath })
}

/**
 * Writes the repository's root `.gitignore`.
 *
 * Empty text **removes the file** rather than leaving an empty one: the two mean the same thing to git, and an
 * empty file shows up as a change the user didn't make. Line endings follow `core.autocrlf`/`core.safecrlf`, so
 * the file matches the rest of the repository.
 */
export async function saveGitIgnore(
  repositoryPath: string,
  text: string
): Promise<void> {
  await invoke('save_gitignore', { repositoryPath, text })
}

/**
 * Appends ignore *patterns*, as written.
 *
 * Nothing is escaped, because `*` and `?` are what make a pattern a pattern. For file names, use
 * {@linkcode appendIgnoreFiles}.
 */
export async function appendIgnoreRules(
  repositoryPath: string,
  patterns: ReadonlyArray<string>
): Promise<void> {
  await invoke('append_ignore_rules', { repositoryPath, patterns })
}

/**
 * Appends *file names*, escaping them.
 *
 * The counterpart to {@linkcode appendIgnoreRules}: these are names rather than patterns, so glob characters in
 * them are escaped — otherwise ignoring `weird[1].txt` would quietly ignore something else.
 */
export async function appendIgnoreFiles(
  repositoryPath: string,
  paths: ReadonlyArray<string>
): Promise<void> {
  await invoke('append_ignore_files', { repositoryPath, paths })
}

// --- Git LFS ---

/**
 * Installs LFS's global filters, so `git lfs` works for every repository.
 *
 * Takes no repository, because the operation isn't about one. `force` overwrites filters someone else
 * configured; without it git refuses rather than silently taking them over.
 */
export async function installGlobalLFSFilters(force = false): Promise<void> {
  await invoke('install_global_lfs_filters', { force })
}

/** Installs LFS's hooks in one repository. */
export async function installLFSHooks(
  repositoryPath: string,
  force = false
): Promise<void> {
  await invoke('install_lfs_hooks', { repositoryPath, force })
}

/** Whether the repository has any LFS-tracked patterns configured. */
export async function isUsingLFS(repositoryPath: string): Promise<boolean> {
  return invoke<boolean>('is_using_lfs', { repositoryPath })
}

// --- mergeability and operation state ---

/**
 * Whether two revisions would merge cleanly.
 *
 * Answered in the object database with `merge-tree --write-tree`, so asking has **no side effects** — the
 * user's index and working tree are untouched. `invalid` covers unrelated histories, which have no merge to
 * describe.
 */
export async function determineMergeability(
  repositoryPath: string,
  ours: string,
  theirs: string
): Promise<MergeTreeResult> {
  return invoke<MergeTreeResult>('determine_mergeability', {
    repositoryPath,
    ours,
    theirs,
  })
}

/**
 * What kind of repository — if any — is at `path`.
 *
 * A path that isn't a repository is an **answer**, not a rejection: the caller is usually asking exactly that.
 * `unsafe` means git refused it for dubious ownership, and {@linkcode addSafeDirectory} is the way out.
 */
export async function getRepositoryType(path: string): Promise<RepositoryType> {
  return invoke<RepositoryType>('get_repository_type', { path })
}

/** Whether a cherry-pick is in progress. */
export async function isCherryPickHeadFound(
  repositoryPath: string
): Promise<boolean> {
  return invoke<boolean>('is_cherry_pick_head_found', { repositoryPath })
}

/** The branch and tips a rebase is replaying, or `null` when none is in progress. */
export async function getRebaseInternalState(
  repositoryPath: string
): Promise<IRebaseInternalState | null> {
  return invoke<IRebaseInternalState | null>('get_rebase_internal_state', {
    repositoryPath,
  })
}

/**
 * Copies the given paths out of the index into the working tree.
 *
 * An empty `paths` is a no-op rather than "check out everything", which is what the bare command would do.
 */
export async function checkoutIndex(
  repositoryPath: string,
  paths: ReadonlyArray<string>
): Promise<void> {
  await invoke('checkout_index', { repositoryPath, paths })
}

// --- commit message trailers ---

/**
 * The characters this repository accepts between a trailer's token and its value.
 *
 * `trailer.separators`, defaulting to `:`. Needed before a message can be parsed, since the separator decides
 * what counts as a trailer at all.
 */
export async function getTrailerSeparatorCharacters(
  repositoryPath: string
): Promise<string> {
  return invoke<string>('get_trailer_separator_characters', { repositoryPath })
}

/** The trailers in a commit message. */
export async function parseTrailers(
  repositoryPath: string,
  commitMessage: string
): Promise<ReadonlyArray<ITrailer>> {
  return invoke<ReadonlyArray<ITrailer>>('parse_trailers', {
    repositoryPath,
    commitMessage,
  })
}

/**
 * A commit message with `trailers` merged in, as git would write them.
 *
 * Asking git rather than concatenating is what gets the blank line, the ordering and any existing trailers
 * right — `interpret-trailers` owns those rules.
 */
export async function mergeTrailers(
  repositoryPath: string,
  commitMessage: string,
  trailers: ReadonlyArray<ITrailer>,
  unfold = false
): Promise<string> {
  return invoke<string>('merge_trailers', {
    repositoryPath,
    commitMessage,
    trailers,
    unfold,
  })
}
