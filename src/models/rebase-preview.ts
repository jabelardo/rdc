import { ComputedAction } from "./computed-action";

/**
 * What rebasing the current branch onto a chosen base branch would do.
 *
 * Ported from `desktop-plus/app/src/models/rebase.ts`'s `RebasePreview`. Like the merge dialog,
 * the operation is previewed before it starts. Rebase conflicts are deliberately not in this union:
 * upstream never produces a `Conflicts` kind here — conflict detection is unimplemented
 * (desktop#6960) — so the dialog only ever distinguishes loading, a clean rebase, and an
 * impossible one.
 *
 * Counts are between the **current** branch and the **base** (picked) branch:
 * - `commitsAhead` — commits the current branch has that the base does not; these are the ones a
 *   rebase replays on top of the base.
 * - `commitsBehind` — commits the base has that the current branch does not; how far the current
 *   branch is behind the base. A rebase can only start when this is positive.
 */
export type RebasePreview =
  | { readonly kind: ComputedAction.Loading }
  | { readonly kind: ComputedAction.Invalid }
  | {
      readonly kind: ComputedAction.Clean;
      readonly commitsAhead: number;
      readonly commitsBehind: number;
    };
