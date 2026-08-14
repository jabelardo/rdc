import type { Commit } from "../models/commit";

/** Returns selected commits in the repository's newest-to-oldest history order. */
export function orderSelectedCommits(
  history: ReadonlyArray<Commit>,
  selected: ReadonlyArray<Commit>,
): ReadonlyArray<Commit> {
  const selectedSHAs = new Set(selected.map((commit) => commit.sha));
  return history.filter((commit) => selectedSHAs.has(commit.sha));
}

/** Squash is only safe for one contiguous range in the displayed history. */
export function isContiguousSelection(
  history: ReadonlyArray<Commit>,
  selected: ReadonlyArray<Commit>,
): boolean {
  if (selected.length < 2) {
    return false;
  }
  const ordered = orderSelectedCommits(history, selected);
  const first = history.findIndex((commit) => commit.sha === ordered[0]?.sha);
  return ordered.length === selected.length && ordered.every((_, index) => index === 0 || first + index === history.findIndex((commit) => commit.sha === ordered[index].sha));
}
