/**
 * How the merge dialog combines the selected branch into the current one.
 *
 * Rebase is deliberately absent. It inverts the direction — the branch you pick is the base your
 * commits are replayed onto, not the source of commits coming in — so it is a separate dialog rather
 * than a third value here. See `BRANCH_OPERATIONS_PLAN.md` § "Amended scope".
 */
export type MergeStrategy = "merge" | "squash";

export const MergeStrategyLabel: Readonly<Record<MergeStrategy, string>> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
};

export const MergeStrategyDescription: Readonly<Record<MergeStrategy, string>> = {
  merge: "The commits from the selected branch are added to the current branch via a merge commit.",
  squash: "The commits in the selected branch are combined into one commit on the current branch.",
};
