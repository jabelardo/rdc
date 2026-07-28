/**
 * The branch-listing side of the IPC boundary.
 *
 * `crates/git-ops/src/for_each_ref.rs` reads branches with `git for-each-ref`; this module types that
 * payload and builds the `models/branch` classes from it.
 *
 * Same hydration split as {@link ./log-ipc.ts}: `Branch` is a class whose getters *derive*
 * `upstreamRemoteName`, `remoteName`, `upstreamWithoutRemote` and `nameWithoutRemote` from the fields
 * below. The wire therefore carries the constructor's arguments and the getters stay in one place —
 * sending the derived names from Rust would be a second implementation of rules that already exist
 * here.
 *
 * `BranchType` is a **numeric** enum, so it arrives as `0` or `1`. Those values are load bearing
 * beyond the wire: `models/branch.ts` notes they sort local branches ahead of remote ones.
 */

import { invoke } from '@tauri-apps/api/core'
import {
  Branch,
  BranchType,
  type IBranchTip,
  type ITrackingBranch,
} from '../models/branch'

/** An {@linkcode IBranchTip} as it arrives over IPC. */
export interface IBranchTipData {
  readonly sha: string
  readonly author: {
    /** Seconds since the Unix epoch; the `Date` is built here. */
    readonly date: number
  }
}

/** A {@linkcode Branch} as it arrives over IPC: the constructor's arguments. */
export interface IBranchData {
  readonly name: string
  /** `null` rather than absent when the branch tracks nothing. */
  readonly upstream: string | null
  readonly tip: IBranchTipData
  readonly type: BranchType
  readonly ref: string
  readonly isGone: boolean
}

function hydrateBranchTip(data: IBranchTipData): IBranchTip {
  return {
    sha: data.sha,
    // The wire carries seconds; `Date` takes milliseconds.
    author: { date: new Date(data.author.date * 1000) },
  }
}

/** Builds a {@linkcode Branch}, whose getters derive the remote and short names. */
export function hydrateBranch(data: IBranchData): Branch {
  return new Branch(
    data.name,
    data.upstream,
    hydrateBranchTip(data.tip),
    data.type,
    data.ref,
    data.isGone
  )
}

/**
 * Lists branches, in the order git reports them (alphabetical by ref).
 *
 * `prefixes` narrows which ref namespaces are searched; omit it for `refs/heads` and `refs/remotes`.
 *
 * A path that isn't a repository resolves to an empty array rather than rejecting — asking what
 * branches a plain directory has is a question with an answer.
 *
 * Symbolic refs are not included: `refs/remotes/origin/HEAD` points at another branch, so listing it
 * would show the remote's default branch twice.
 */
export async function getBranches(
  repositoryPath: string,
  prefixes: ReadonlyArray<string> = []
): Promise<ReadonlyArray<Branch>> {
  const branches = await invoke<ReadonlyArray<IBranchData>>('get_branches', {
    repositoryPath,
    prefixes,
  })

  return branches.map(hydrateBranch)
}

/**
 * Lists local branches whose tip differs from their upstream's, so they could be fast-forwarded.
 *
 * Needs no hydration — {@linkcode ITrackingBranch} is four strings, and the `(upstreamRef, ref)` pairs
 * `fastForwardBranches` takes are built straight from them.
 *
 * The current branch and any branch checked out in another worktree are excluded, because neither can
 * be moved by a ref update alone.
 */
export async function getBranchesDifferingFromUpstream(
  repositoryPath: string
): Promise<ReadonlyArray<ITrackingBranch>> {
  return await invoke<ReadonlyArray<ITrackingBranch>>(
    'get_branches_differing_from_upstream',
    { repositoryPath }
  )
}
