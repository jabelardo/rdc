import type { Branch } from "@/models/branch";
import { ComputedAction } from "@/models/computed-action";
import type { MergeTreeResult } from "@/models/merge";
import type { IGenericProgress } from "@/models/progress";
import {
  MergeStrategyDescription,
  MergeStrategyLabel,
  type MergeStrategy,
} from "@/models/merge-strategy";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatNumber } from "@/lib/format-number";
import { BranchPicker } from "./branch-picker";
import { DialogMessage, type DialogMessageTone } from "./dialog-message";
import { OperationProgressDialog } from "./operation-progress-dialog";
import type { OperationProgressViewModel } from "@/lib/operation-presentation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MessageID = "merge-branch-message";

const Strategies: ReadonlyArray<MergeStrategy> = ["merge", "squash"];

type StrategyActionsProps = {
  readonly strategy: MergeStrategy;
  readonly busy: boolean;
  readonly confirmDisabled: boolean;
  readonly dismissOnly?: boolean;
  readonly onStrategyChange: (strategy: MergeStrategy) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

function StrategyActions({
  strategy,
  busy,
  confirmDisabled,
  dismissOnly = false,
  onStrategyChange,
  onConfirm,
  onCancel,
}: StrategyActionsProps) {
  if (dismissOnly) {
    return (
      <DialogFooter>
        <Button type="button" onClick={onCancel}>
          Close
        </Button>
      </DialogFooter>
    );
  }

  const verb = strategy === "squash" ? "Squash" : "Merge";
  const busyLabel = strategy === "squash" ? "Squashing…" : "Merging…";

  const cancel = (
    <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
      Cancel
    </Button>
  );

  const confirm = (
    <div className="flex">
      <Button
        type="button"
        className="rounded-r-none"
        disabled={busy || confirmDisabled}
        onClick={onConfirm}
      >
        {busy ? busyLabel : `${verb}`}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            className="rounded-l-none border-l border-l-[color-mix(in_oklch,var(--primary-foreground),transparent_70%)] px-1.5"
            disabled={busy || confirmDisabled}
            aria-label="Choose how to combine the branches"
          >
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[22rem]">
          <DropdownMenuRadioGroup
            value={strategy}
            onValueChange={(value) => onStrategyChange(value as MergeStrategy)}
          >
            {Strategies.map((option) => (
              <DropdownMenuRadioItem key={option} value={option} className="items-start">
                <span className="grid gap-0.5">
                  <span className="font-medium">{MergeStrategyLabel[option]}</span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {MergeStrategyDescription[option]}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
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
  );
}

export function mergeCandidates(
  branches: ReadonlyArray<Branch>,
  currentBranch: string | null,
  merged: ReadonlyMap<string, string>,
): ReadonlyArray<Branch> {
  const mergedShas = new Set(merged.values());
  const currentTip = branches.find((branch) => branch.name === currentBranch)?.tip.sha;
  if (currentTip !== undefined) {
    mergedShas.add(currentTip);
  }

  return branches.filter(
    (branch) =>
      branch.name !== currentBranch &&
      !merged.has(`refs/heads/${branch.name}`) &&
      !mergedShas.has(branch.tip.sha),
  );
}

type MergeBranchDialogProps = {
  readonly currentBranch: string;
  readonly candidates: ReadonlyArray<Branch>;
  readonly defaultBranch: string | null;
  readonly recentBranches: ReadonlyArray<string>;
  readonly selected: Branch | null;
  readonly strategy: MergeStrategy;
  readonly status: MergeTreeResult | null;
  readonly commitCount: number;
  readonly running: boolean;
  readonly progress: IGenericProgress | null;
  readonly failure: string | null;
  readonly operationViewModel?: OperationProgressViewModel;
  readonly onCancelOperation?: () => void;
  readonly onAdoptCancellation?: () => void;
  readonly onSelect: (branch: Branch) => void;
  readonly onStrategyChange: (strategy: MergeStrategy) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

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
  progress,
  failure,
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
  onSelect,
  onStrategyChange,
  onConfirm,
  onCancel,
}: MergeBranchDialogProps) {
  if (running) {
    return (
      <OperationProgressDialog
        viewModel={operationViewModel}
        operation={strategy === "squash" ? "Squashing" : "Merging"}
        progress={progress ?? { value: 0 }}
        onCancel={onCancelOperation}
        onAdoptCancellation={onAdoptCancellation}
      />
    );
  }

  const nothingToMerge = status?.kind === ComputedAction.Clean && commitCount === 0;
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
            Merge into <strong>{currentBranch}</strong>
          </DialogTitle>
        </DialogHeader>
        {candidates.length === 0 ? (
          <>
            <DialogMessage id={MessageID}>There are no other branches to merge.</DialogMessage>
            <StrategyActions
              strategy={strategy}
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
