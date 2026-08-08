import type { Branch } from "../../../models/branch";
import { ComputedAction } from "../../../models/computed-action";
import type { RebasePreview } from "../../../models/rebase-preview";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { formatNumber } from "../../format-number";
import { BranchPicker } from "./branch-picker";
import { DialogMessage, type DialogMessageTone } from "./dialog-message";

const MessageID = "rebase-branch-message";

export function rebaseCandidates(
  branches: ReadonlyArray<Branch>,
  currentBranch: string | null,
): ReadonlyArray<Branch> {
  return branches.filter((branch) => branch.name !== currentBranch);
}

type RebaseBranchDialogProps = {
  readonly currentBranch: string;
  readonly candidates: ReadonlyArray<Branch>;
  readonly defaultBranch: string | null;
  readonly recentBranches: ReadonlyArray<string>;
  readonly selected: Branch | null;
  /** Preview of rebasing `currentBranch` onto `selected`, or null before one is picked. */
  readonly preview: RebasePreview | null;
  readonly running: boolean;
  readonly failure: string | null;
  readonly onSelect: (branch: Branch) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

export function RebaseBranchDialog({
  currentBranch,
  candidates,
  defaultBranch,
  recentBranches,
  selected,
  preview,
  running,
  failure,
  onSelect,
  onConfirm,
  onCancel,
}: RebaseBranchDialogProps) {
  const canRebase =
    selected !== null &&
    preview !== null &&
    preview.kind !== ComputedAction.Loading &&
    preview.kind !== ComputedAction.Invalid &&
    preview.commitsBehind > 0;

  let tone: DialogMessageTone = "info";
  let message: React.ReactNode = null;
  if (failure !== null) {
    tone = "error";
    message = failure;
  } else if (selected === null || preview === null) {
    // The slot holds its height either way, so saying what it is for costs nothing and answers
    // "why is there a gap here".
    message = "Choose a branch to see what rebasing onto it will do.";
  } else if (preview.kind === ComputedAction.Loading) {
    message = "Checking whether these branches can be combined automatically…";
  } else if (preview.kind === ComputedAction.Invalid) {
    tone = "error";
    message = "These branches have unrelated histories and cannot be combined.";
  } else if (preview.commitsBehind === 0) {
    message = (
      <>
        <strong>{currentBranch}</strong> is already up to date with <strong>{selected.name}</strong>
        .
      </>
    );
  } else if (preview.commitsAhead === 0) {
    message = (
      <>
        This will fast-forward <strong>{currentBranch}</strong> by{" "}
        <strong>{formatNumber(preview.commitsBehind)}</strong>{" "}
        {preview.commitsBehind === 1 ? "commit" : "commits"} to match{" "}
        <strong>{selected.name}</strong>.
      </>
    );
  } else {
    message = (
      <>
        This will update <strong>{currentBranch}</strong> by applying its{" "}
        <strong>{formatNumber(preview.commitsAhead)}</strong>{" "}
        {preview.commitsAhead === 1 ? "commit" : "commits"} on top of{" "}
        <strong>{selected.name}</strong>.
      </>
    );
  }

  const cancel = (
    <Button type="button" variant="outline" disabled={running} onClick={onCancel}>
      Cancel
    </Button>
  );
  const confirm = (
    <Button type="button" disabled={running || !canRebase} onClick={onConfirm}>
      {running ? "Rebasing…" : `Rebase`}
    </Button>
  );

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
            Rebase <strong>{currentBranch}</strong>
          </DialogTitle>
        </DialogHeader>
        {candidates.length === 0 ? (
          <>
            <DialogMessage id={MessageID}>
              There are no other branches to rebase onto.
            </DialogMessage>
            <DialogFooter>
              <Button type="button" onClick={onCancel}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <BranchPicker
              branches={candidates}
              defaultBranch={defaultBranch}
              recentBranches={recentBranches}
              selectedBranch={selected}
              label="Branch to rebase onto"
              onSelect={onSelect}
            />
            <DialogMessage tone={tone} id={MessageID}>
              {message}
            </DialogMessage>
            <DialogFooter>
              {__DARWIN__ ? (
                <>
                  {cancel}
                  {confirm}
                </>
              ) : (
                <>
                  {confirm}
                  {cancel}
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
