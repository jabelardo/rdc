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

import { invoke } from '@tauri-apps/api/core'
import type { AppFileStatus } from '../models/status'
import { GitErrorKind } from '../models/git-error-kind'

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
