import { Branch } from "@/models/branch";
import {
  ChooseBranchStep,
  conflictSteps,
  MultiCommitOperationStepKind,
} from "@/models/multi-commit-operation";
import { TipState } from "@/models/tip";
import { IBranchesState } from "@/lib/app-state/branches-state";

/**
 * MIGRATION NOTE — the two parameter types below were **narrowed to the subset each function
 * actually reads**, instead of naming the whole state objects from `lib/app-state.ts`.
 *
 * The originals declared `IRepositoryState` and `IMultiCommitOperationState`, but
 * `getMultiCommitOperationChooseBranchStep` touches only `state.branchesState` and `isConflictsFlow`
 * only `state.step.kind`. Naming the god-module types meant depending on all 1,319 lines of it —
 * and through it on `lib/git/config` and `ui/lib/application-theme` — for two field reads.
 *
 * TypeScript is structurally typed, so **callers are unaffected**: a full `IRepositoryState` still
 * satisfies `RepositoryStateForChooseBranch`. The narrower types also document the real contract.
 */

/** The part of the repository state needed to choose a base branch. */
type RepositoryStateForChooseBranch = {
  readonly branchesState: IBranchesState;
};

/** The part of a multi-commit-operation's state needed to tell whether it is in a conflicts step. */
type OperationStateForConflictsFlow = {
  readonly step: { readonly kind: MultiCommitOperationStepKind };
};

/**
 * Setup the multi commit operation state when the user needs to select a branch as the
 * base for the operation.
 */
export function getMultiCommitOperationChooseBranchStep(
  state: RepositoryStateForChooseBranch,
  initialBranch?: Branch | null,
  sourceBranch?: Branch,
): ChooseBranchStep {
  const { defaultBranch, allBranches, recentBranches, tip } = state.branchesState;
  let currentBranch: Branch | null = null;

  if (tip.kind === TipState.Valid) {
    currentBranch = tip.branch;
  } else {
    throw new Error(
      "Tip is not in a valid state, which is required to start the multi commit operation",
    );
  }

  return {
    kind: MultiCommitOperationStepKind.ChooseBranch,
    defaultBranch,
    currentBranch: sourceBranch ?? currentBranch,
    allBranches,
    recentBranches,
    initialBranch: initialBranch !== null ? initialBranch : undefined,
  };
}

export function isConflictsFlow(
  isMultiCommitOperationPopupOpen: boolean,
  multiCommitOperationState: OperationStateForConflictsFlow | null,
): boolean {
  return (
    isMultiCommitOperationPopupOpen &&
    multiCommitOperationState !== null &&
    conflictSteps.includes(multiCommitOperationState.step.kind)
  );
}
