/**
 * Typed wrappers over the Rust git commands.
 *
 * rdc uses Tauri's native IPC — `invoke` from `@tauri-apps/api/core` — rather than a binding
 * generator, so the types here are hand-written to match the Rust side, and
 * `crates/git-ops/tests/wire_contract.rs` pins the exact JSON of everything that crosses.
 *
 * **Domain types are re-used from `models/status.ts`, never redeclared here.** That rule exists
 * because breaking it caused a real bug: this module used to declare its own `AppFileStatus` with
 * the conflict details flattened, while the ported `models/status.ts` nests them under `entry`.
 * Both the Rust and the wire-contract test agreed with the flattened version, so everything passed
 * — but `src/lib/status.ts`, which consumes the ported `AppFileStatus`, could never have accepted
 * the result of `getStatus()`. Two definitions of one domain concept will drift, and the tests
 * guarding the boundary can't see it, because they only compare Rust to JSON.
 *
 * So: if a type already exists in `models/`, import it. Only genuinely new wire types belong here.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import type { AppFileStatus, GitStatusEntry } from '../models/status'
import type { ManualConflictResolution } from '../models/manual-conflict-resolution'
import { GitErrorKind } from '../models/git-error-kind'
import type {
  ICheckoutProgress,
  IMultiCommitOperationProgress,
} from '../models/progress'
import type { CommitOneLine } from '../models/commit'

/** How far ahead/behind a branch is relative to its upstream. */
export interface IAheadBehind {
  readonly ahead: number
  readonly behind: number
}

/** What git records about an in-progress rebase. */
export interface IRebaseInternalState {
  readonly targetBranch: string
  readonly baseBranchTip: string
  readonly originalBranchTip: string
}

/** One changed path, as git sees it. */
export interface IStatusFileChange {
  readonly path: string
  readonly status: AppFileStatus
  /**
   * Whether the UI should start with this file unticked — a dirty submodule whose own commit
   * hasn't changed, where committing in the superproject would record nothing.
   */
  readonly startsUnselected: boolean
}

/** The status of a repository. */
export interface IStatusResult {
  readonly currentBranch?: string
  readonly currentUpstreamBranch?: string
  readonly currentTip?: string
  readonly branchAheadBehind?: IAheadBehind
  readonly mergeHeadFound: boolean
  readonly squashMsgFound: boolean
  readonly rebaseInternalState?: IRebaseInternalState
  readonly isCherryPickingHeadFound: boolean
  readonly files: ReadonlyArray<IStatusFileChange>
  readonly doConflictedFilesExist: boolean
}

/**
 * A command failure.
 *
 * `kind` is the classified git error, so the UI can branch on e.g. an authentication failure
 * without parsing `message`. User-facing wording belongs here in the frontend, not in Rust — see
 * the `getDescriptionForError` note in MIGRATION_MAP.md.
 */
export interface ICommandError {
  readonly message: string
  readonly kind?: GitErrorKind
  readonly isAuthFailure: boolean
}

/** Whether a rejected `invoke` gave us a structured command error. */
export function isCommandError(error: unknown): error is ICommandError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    'isAuthFailure' in error
  )
}

/**
 * Reads the status of the repository at `repositoryPath`, or `null` if that path isn't a git
 * repository.
 *
 * `listUntrackedFilesIndividually` does **not** mean "include untracked files": passing `false`
 * still reports them, it just collapses untracked directories into a single entry.
 */
export async function getStatus(
  repositoryPath: string,
  listUntrackedFilesIndividually = true
): Promise<IStatusResult | null> {
  return invoke<IStatusResult | null>('get_status', {
    repositoryPath,
    listUntrackedFilesIndividually,
  })
}

/**
 * A file the user has selected for staging, in full.
 *
 * `oldPath` and `deleted` both have defaults on the Rust side, so a plain added or modified file is
 * just `{ path }`.
 *
 * Partially-selected files can't be sent yet — the Rust side stages whole files only, because
 * per-line staging needs the patch formatter ported first.
 */
export interface IFileToStage {
  readonly path: string
  /** The path this file was renamed *from*, when the change is a rename or a copy. */
  readonly oldPath?: string
  /** Whether the file is gone from the working tree. */
  readonly deleted?: boolean
}

/** Options for {@linkcode createCommit}. Every flag defaults to off. */
export interface ICommitOptions {
  readonly amend?: boolean
  readonly noVerify?: boolean
  readonly signOff?: boolean
  readonly allowEmpty?: boolean
}

/** The outcome of merging a branch into the current branch. */
export enum MergeResult {
  Success = 'Success',
  AlreadyUpToDate = 'AlreadyUpToDate',
  Failed = 'Failed',
}

export interface IMergeOptions {
  readonly squash?: boolean
  readonly noVerify?: boolean
}

/** The outcome of starting or continuing a rebase. */
export enum RebaseResult {
  CompletedWithoutError = 'CompletedWithoutError',
  AlreadyUpToDate = 'AlreadyUpToDate',
  ConflictsEncountered = 'ConflictsEncountered',
  OutstandingFilesNotStaged = 'OutstandingFilesNotStaged',
  Aborted = 'Aborted',
  Error = 'Error',
}

/** A manual conflict choice to apply before continuing a rebase. */
export interface IRebaseConflictResolution {
  readonly path: string
  readonly resolution: ManualConflictResolution
  readonly entries?: readonly [GitStatusEntry, GitStatusEntry]
}

export interface IRebaseSnapshot {
  readonly progress: IMultiCommitOperationProgress
  readonly commits: ReadonlyArray<CommitOneLine>
}

/**
 * Creates a commit containing exactly `files`, and resolves to its full SHA.
 *
 * The SHA is the full 40 characters. The original returned git's abbreviation — and returned the
 * string `'(root-commit)'` for a repository's first commit, a bug its own tests had pinned as
 * expected. See MIGRATION_MAP.md §8.
 */
export async function createCommit(
  repositoryPath: string,
  message: string,
  files: ReadonlyArray<IFileToStage>,
  options?: ICommitOptions
): Promise<string> {
  return invoke<string>('create_commit', {
    repositoryPath,
    message,
    files,
    options,
  })
}

/**
 * Creates the commit that concludes an in-progress merge, and resolves to its full SHA.
 *
 * Unlike {@linkcode createCommit} this does **not** clear the index first: a merge's staged state is
 * what git built while merging, and discarding it would throw away the resolution.
 *
 * `manualResolutions` is a list of `[path, resolution]` pairs rather than a record, because a
 * repository path is an arbitrary string and so isn't a safe object key.
 */
export async function createMergeCommit(
  repositoryPath: string,
  files: ReadonlyArray<IFileToStage>,
  manualResolutions: ReadonlyArray<
    readonly [string, ManualConflictResolution]
  > = []
): Promise<string> {
  return invoke<string>('create_merge_commit', {
    repositoryPath,
    files,
    manualResolutions,
  })
}

/** Checks out an existing local branch. */
export async function checkoutBranch(
  repositoryPath: string,
  name: string,
  progressCallback?: (progress: ICheckoutProgress) => void
): Promise<void> {
  const onProgress = new Channel<ICheckoutProgress>(progressCallback)
  return invoke<void>('checkout_branch', { repositoryPath, name, onProgress })
}

/**
 * Checks out a remote-tracking branch by creating a local branch from it.
 *
 * Rejects if `localName` already exists — git won't repoint an existing branch, and the UI needs
 * that failure in order to prompt.
 */
export async function checkoutRemoteBranch(
  repositoryPath: string,
  remoteRef: string,
  localName: string,
  progressCallback?: (progress: ICheckoutProgress) => void
): Promise<void> {
  const onProgress = new Channel<ICheckoutProgress>(progressCallback)
  return invoke<void>('checkout_remote_branch', {
    repositoryPath,
    remoteRef,
    localName,
    onProgress,
  })
}

/** Checks out a commit, leaving `HEAD` detached. */
export async function checkoutCommit(
  repositoryPath: string,
  commit: string,
  progressCallback?: (progress: ICheckoutProgress) => void
): Promise<void> {
  const onProgress = new Channel<ICheckoutProgress>(progressCallback)
  return invoke<void>('checkout_commit', {
    repositoryPath,
    commit,
    onProgress,
  })
}

/**
 * Restores the given paths from `HEAD`.
 *
 * **This discards the user's working-tree changes to those paths.** An empty list is a no-op rather
 * than meaning "everything".
 */
export async function checkoutPaths(
  repositoryPath: string,
  paths: ReadonlyArray<string>
): Promise<void> {
  return invoke<void>('checkout_paths', { repositoryPath, paths })
}

/**
 * Stages a conflicted file according to the side the user chose.
 *
 * `entries` is the conflict's `[us, them]` pair, from the file's `status.entry`. Passing it is what
 * allows a side that *deleted* the file to resolve to a deletion instead of staging working-tree
 * content, so prefer to supply it whenever the status is to hand.
 */
export async function stageManualConflictResolution(
  repositoryPath: string,
  path: string,
  resolution: ManualConflictResolution,
  entries?: readonly [GitStatusEntry, GitStatusEntry]
): Promise<void> {
  return invoke<void>('stage_manual_conflict_resolution', {
    repositoryPath,
    path,
    resolution,
    entries,
  })
}

/** Merges `branch` into the current branch. */
export async function mergeBranch(
  repositoryPath: string,
  branch: string,
  options?: IMergeOptions
): Promise<MergeResult> {
  return invoke<MergeResult>('merge_branch', {
    repositoryPath,
    branch,
    options,
  })
}

/** Finds the best common ancestor of two refs. */
export async function getMergeBase(
  repositoryPath: string,
  firstCommitish: string,
  secondCommitish: string
): Promise<string | null> {
  return invoke<string | null>('get_merge_base', {
    repositoryPath,
    firstCommitish,
    secondCommitish,
  })
}

/** Aborts an in-progress merge. */
export async function abortMerge(repositoryPath: string): Promise<void> {
  return invoke<void>('abort_merge', { repositoryPath })
}

/** Rebases `targetBranch` onto `baseBranch`. */
export async function rebaseBranch(
  repositoryPath: string,
  baseBranch: string,
  targetBranch: string,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void
): Promise<RebaseResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(
    progressCallback
  )
  return invoke<RebaseResult>('rebase_branch', {
    repositoryPath,
    baseBranch,
    targetBranch,
    onProgress,
  })
}

/**
 * Stages fully-selected files and manual resolutions, then continues the active rebase.
 *
 * Do not include untracked or partially-selected files. Partial selections remain gated on the
 * patch formatter, as they are for commits.
 */
export async function continueRebase(
  repositoryPath: string,
  files: ReadonlyArray<IFileToStage>,
  manualResolutions: ReadonlyArray<IRebaseConflictResolution> = [],
  noVerify = false,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void
): Promise<RebaseResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(
    progressCallback
  )
  return invoke<RebaseResult>('continue_rebase', {
    repositoryPath,
    files,
    manualResolutions,
    noVerify,
    onProgress,
  })
}

/** Aborts an in-progress rebase. */
export async function abortRebase(repositoryPath: string): Promise<void> {
  return invoke<void>('abort_rebase', { repositoryPath })
}

/** Recovers progress for a rebase started by rdc or another Git client. */
export async function getRebaseSnapshot(
  repositoryPath: string
): Promise<IRebaseSnapshot | null> {
  return invoke<IRebaseSnapshot | null>('get_rebase_snapshot', {
    repositoryPath,
  })
}
