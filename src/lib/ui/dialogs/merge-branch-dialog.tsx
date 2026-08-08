import type { Branch } from "../../../models/branch";
import { ComputedAction } from "../../../models/computed-action";
import type { MergeTreeResult } from "../../../models/merge";
import {
  MergeStrategyDescription,
  MergeStrategyLabel,
  type MergeStrategy,
} from "../../../models/merge-strategy";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { formatNumber } from "../../format-number";
import { BranchPicker } from "./branch-picker";
import { DialogMessage, type DialogMessageTone } from "./dialog-message";
import { StrategyActions } from "./strategy-actions";

const MessageID = "merge-branch-message";

type MergeBranchDialogProps = {
  readonly currentBranch: string;
  readonly candidates: ReadonlyArray<Branch>;
  readonly defaultBranch: string | null;
  readonly recentBranches: ReadonlyArray<string>;
  readonly selected: Branch | null;
  readonly strategy: MergeStrategy;
  /** Mergeability of `selected` into `currentBranch`, or null before one is picked. */
  readonly status: MergeTreeResult | null;
  readonly commitCount: number;
  readonly running: boolean;
  readonly failure: string | null;
  readonly onSelect: (branch: Branch) => void;
  readonly onStrategyChange: (strategy: MergeStrategy) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/**
 * Combine another branch into the current one, by merge commit or squash.
 *
 * Rebase is deliberately not here. It inverts the direction — the picked branch would become the
 * base rather than the source — so it is its own dialog rather than a third value on the strategy
 * control. See `BRANCH_OPERATIONS_PLAN.md` § "Amended scope".
 */
export function MergeBranchDialog({
  currentBranch,
  candidates,
  defaultBranch,
  recentBranches,
  selected,
  strategy,
  status,
  commitCount,
  running,
  failure,
  onSelect,
  onStrategyChange,
  onConfirm,
  onCancel,
}: MergeBranchDialogProps) {
  const nothingToMerge = status?.kind === ComputedAction.Clean && commitCount === 0;
  // Conflicts do not block: desktop-plus starts anyway and resolves afterwards, and rdc has the
  // conflict recovery flow for exactly that. Loading does block — until mergeability is known,
  // "can this proceed" has no answer yet.
  const canMerge =
    selected !== null &&
    status !== null &&
    status.kind !== ComputedAction.Loading &&
    status.kind !== ComputedAction.Invalid &&
    !nothingToMerge;

  let tone: DialogMessageTone = "info";
  let message: React.ReactNode = null;
  if (failure !== null) {
    tone = "error";
    message = failure;
  } else if (selected === null || status === null) {
    // The slot holds its height either way, so leaving it blank read as an unexplained gap between
    // the list and the buttons. Saying what the space is for costs nothing and answers "why here".
    message = "Choose a branch to see what merging it will do.";
  } else if (status.kind === ComputedAction.Loading) {
    message = "Checking whether these branches can be combined automatically…";
  } else if (status.kind === ComputedAction.Invalid) {
    tone = "error";
    message = "These branches have unrelated histories and cannot be combined.";
  } else if (status.kind === ComputedAction.Conflicts) {
    tone = "warning";
    message = (
      <>
        This will leave <strong>{formatNumber(status.conflictedFiles)}</strong>{" "}
        {status.conflictedFiles === 1 ? "file" : "files"} conflicted, which you resolve before the{" "}
        {strategy === "squash" ? "squash" : "merge"} completes.
      </>
    );
  } else if (nothingToMerge) {
    message = (
      <>
        <strong>{currentBranch}</strong> is already up to date with <strong>{selected.name}</strong>
        .
      </>
    );
  } else if (strategy === "squash") {
    message = (
      <>
        Combines <strong>{formatNumber(commitCount)}</strong>{" "}
        {commitCount === 1 ? "commit" : "commits"} from <strong>{selected.name}</strong> into one
        commit on <strong>{currentBranch}</strong>.
      </>
    );
  } else {
    message = (
      <>
        Brings <strong>{formatNumber(commitCount)}</strong>{" "}
        {commitCount === 1 ? "commit" : "commits"} from <strong>{selected.name}</strong> into{" "}
        <strong>{currentBranch}</strong> via a merge commit.
      </>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) {
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-[520px]" aria-describedby={MessageID}>
        <DialogHeader>
          <DialogTitle>
            Merge a branch into <strong>{currentBranch}</strong>
          </DialogTitle>
        </DialogHeader>
        {candidates.length === 0 ? (
          <>
            <DialogMessage id={MessageID}>There are no other branches to merge.</DialogMessage>
            <StrategyActions
              strategy={strategy}
              currentBranch={currentBranch}
              busy={false}
              confirmDisabled
              dismissOnly
              onStrategyChange={onStrategyChange}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          </>
        ) : (
          <>
            <BranchPicker
              branches={candidates}
              defaultBranch={defaultBranch}
              recentBranches={recentBranches}
              selectedBranch={selected}
              label="Branch to merge in"
              onSelect={onSelect}
            />
            <DialogMessage tone={tone} id={MessageID}>
              {message}
            </DialogMessage>
            <StrategyActions
              strategy={strategy}
              currentBranch={currentBranch}
              busy={running}
              confirmDisabled={!canMerge}
              onStrategyChange={onStrategyChange}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { MergeStrategyDescription, MergeStrategyLabel };
