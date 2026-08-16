/**
 * Counting commits across a range.
 *
 * `crates/git-ops/src/rev_list.rs` runs `rev-list --left-right --count`; this types the answer and adds the
 * branch-shaped convenience on top of it.
 */

import { invoke } from "@tauri-apps/api/core";
import { BranchType, type Branch, type IAheadBehind } from "@/models/branch";
import { revSymmetricDifference } from "./rev-range";

/**
 * How many commits each side of `range` has that the other does not.
 *
 * `null` means the question cannot be asked — a ref in the range no longer exists, most often a deleted
 * upstream. That is an answer rather than an error: a caller with nothing to put in a label shouldn't be
 * handling a rejection.
 */
export async function getAheadBehind(
  repositoryPath: string,
  range: string,
): Promise<IAheadBehind | null> {
  return invoke<IAheadBehind | null>("get_ahead_behind", {
    repositoryPath,
    range,
  });
}

/**
 * How far `branch` is ahead of and behind its upstream.
 *
 * TypeScript rather than a second command, because everything specific to a branch here is a decision the
 * frontend can make from data it already holds: a remote branch has no upstream of its own, a local one
 * without an upstream has nothing to compare against, and the range is string concatenation. Only the
 * counting needs git.
 *
 * The **three-dot** range is deliberate, and upstream called it out: it goes back to the merge base, so the
 * counts see "through" a merge instead of counting everything since the branches last touched.
 */
export async function getBranchAheadBehind(
  repositoryPath: string,
  branch: Branch,
): Promise<IAheadBehind | null> {
  if (branch.type === BranchType.Remote) {
    return null;
  }

  if (!branch.upstream) {
    return null;
  }

  return getAheadBehind(repositoryPath, revSymmetricDifference(branch.name, branch.upstream));
}
