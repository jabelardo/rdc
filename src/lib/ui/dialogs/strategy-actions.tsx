import { ChevronDown } from "lucide-react";
import {
  MergeStrategyDescription,
  MergeStrategyLabel,
  type MergeStrategy,
} from "../../../models/merge-strategy";
import { Button } from "../../../components/ui/button";
import { DialogFooter } from "../../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";

const Strategies: ReadonlyArray<MergeStrategy> = ["merge", "squash"];

type StrategyActionsProps = {
  readonly strategy: MergeStrategy;
  readonly currentBranch: string;
  readonly busy: boolean;
  readonly confirmDisabled: boolean;
  /** No branches to act on, so the only sensible action is leaving. */
  readonly dismissOnly?: boolean;
  readonly onStrategyChange: (strategy: MergeStrategy) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/**
 * The merge dialog's footer: a confirm button whose label *is* the chosen strategy, plus a caret
 * that changes it.
 *
 * The label names both the strategy and the destination — "Merge into main", not "Merge" — because
 * the one thing users get wrong about these operations is which direction they run. Atlassian has an
 * open issue about exactly that for SourceTree's rebase wording (SRCTREE-1578), so the button says
 * the whole sentence rather than relying on the dialog title being remembered.
 *
 * The dropdown changes the strategy in place. It does not switch operations the way desktop-plus's
 * does, because rdc's two strategies share a direction; rebase, which does not, is its own dialog.
 */
export function StrategyActions({
  strategy,
  currentBranch,
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

  const verb = strategy === "squash" ? "Squash into" : "Merge into";
  const busyLabel = strategy === "squash" ? "Squashing…" : "Merging…";

  const cancel = (
    <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
      Cancel
    </Button>
  );
  const confirm = (
    // A single group so the caret reads as part of one control rather than a second button.
    <div className="flex">
      <Button
        type="button"
        className="rounded-r-none"
        disabled={busy || confirmDisabled}
        onClick={onConfirm}
      >
        {busy ? busyLabel : `${verb} ${currentBranch}`}
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
