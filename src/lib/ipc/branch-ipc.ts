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

import { invoke } from "@tauri-apps/api/core";
import { Branch, BranchType, type IBranchTip, type ITrackingBranch } from "@/models/branch";

/** An {@linkcode IBranchTip} as it arrives over IPC. */
export interface IBranchTipData {
  readonly sha: string;
  readonly author: {
    /** Seconds since the Unix epoch; the `Date` is built here. */
    readonly date: number;
  };
}

/** A {@linkcode Branch} as it arrives over IPC: the constructor's arguments. */
export interface IBranchData {
  readonly name: string;
  /** `null` rather than absent when the branch tracks nothing. */
  readonly upstream: string | null;
  readonly tip: IBranchTipData;
  readonly type: BranchType;
  readonly ref: string;
  readonly isGone: boolean;
}

function hydrateBranchTip(data: IBranchTipData): IBranchTip {
  return {
    sha: data.sha,
    // The wire carries seconds; `Date` takes milliseconds.
    author: { date: new Date(data.author.date * 1000) },
  };
}

/** Builds a {@linkcode Branch}, whose getters derive the remote and short names. */
export function hydrateBranch(data: IBranchData): Branch {
  return new Branch(
    data.name,
    data.upstream,
    hydrateBranchTip(data.tip),
    data.type,
    data.ref,
    data.isGone,
  );
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
  prefixes: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<Branch>> {
  const branches = await invoke<ReadonlyArray<IBranchData>>("get_branches", {
    repositoryPath,
    prefixes,
  });

  return branches.map(hydrateBranch);
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
  repositoryPath: string,
): Promise<ReadonlyArray<ITrackingBranch>> {
  return await invoke<ReadonlyArray<ITrackingBranch>>("get_branches_differing_from_upstream", {
    repositoryPath,
  });
}

/**
 * Creates a branch, without checking it out.
 *
 * `startPoint` defaults to `HEAD`. `noTrack` matters when branching from a *remote* branch: without it git
 * sets that remote branch as the upstream, which makes the rest of the app treat it as the push target —
 * likely a fork's upstream rather than the user's own.
 */
export async function createBranch(
  repositoryPath: string,
  name: string,
  startPoint?: string,
  noTrack = false,
): Promise<void> {
  await invoke("create_branch", { repositoryPath, name, startPoint, noTrack });
}

/**
 * Renames a branch.
 *
 * **Omitting `force` is not the same as `false`.** Omitted lets a *case-only* rename through — `Topic` to
 * `topic` on a case-insensitive filesystem — by retrying once with `-M` after confirming no different branch
 * holds the name. `false` refuses any collision; `true` forces every one.
 */
export async function renameBranch(
  repositoryPath: string,
  currentName: string,
  newName: string,
  force?: boolean,
): Promise<void> {
  await invoke("rename_branch", {
    repositoryPath,
    currentName,
    newName,
    force,
  });
}

/**
 * Deletes a local branch, merged or not.
 *
 * Uses `-D`: the app asks the user before calling this, so git's own refusal would arrive as a failure the UI
 * has already ruled out.
 */
export async function deleteLocalBranch(repositoryPath: string, branchName: string): Promise<void> {
  await invoke("delete_local_branch", { repositoryPath, branchName });
}

/**
 * Branch names whose tip is `committish`.
 *
 * `null` means the committish didn't resolve, which differs from an empty array: no branch pointing at a
 * commit that exists is an answer, and asking about one that doesn't is a mistake.
 */
export async function getBranchesPointedAt(
  repositoryPath: string,
  committish: string,
): Promise<ReadonlyArray<string> | null> {
  return invoke<ReadonlyArray<string> | null>("get_branches_pointed_at", {
    repositoryPath,
    committish,
  });
}

/**
 * Branches merged into `branchName`, as a `Map` from canonical ref to tip SHA.
 *
 * Pairs on the wire, because a ref name is an arbitrary string and so isn't a safe object key — a `Map`
 * accepts any string, unlike a plain object. `branchName` itself is excluded: it is trivially merged into
 * itself.
 */
export async function getMergedBranches(
  repositoryPath: string,
  branchName: string,
): Promise<Map<string, string>> {
  const pairs = await invoke<ReadonlyArray<[string, string]>>("get_merged_branches", {
    repositoryPath,
    branchName,
  });

  return new Map(pairs);
}

/**
 * Deletes a ref.
 *
 * Deleting one that doesn't exist **succeeds** — git treats it as idempotent, so no need to check first.
 * `reason` goes into the reflog of the ref being deleted, which is removed with it, so it has no observable
 * effect; it exists because the original passed one.
 */
export async function deleteRef(
  repositoryPath: string,
  refName: string,
  reason?: string,
): Promise<void> {
  await invoke("delete_ref", { repositoryPath, refName, reason });
}

/** What a symbolic ref points at, or `null` if it isn't one. */
export async function getSymbolicRef(
  repositoryPath: string,
  refName: string,
): Promise<string | null> {
  return invoke<string | null>("get_symbolic_ref", { repositoryPath, refName });
}
