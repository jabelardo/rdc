import { BranchType, type Branch } from "@/models/branch";
import type { BranchState } from "@/features/branches/stores/branch-store";
import type { MergeTreeResult } from "@/models/merge";
import type { MergeStrategy } from "@/models/merge-strategy";
import type { RebasePreview } from "@/models/rebase-preview";
import type { OperationProgressViewModel } from "@/lib/operations/operation-presentation";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/dialog-kit/confirm-dialog";
import { NoticeDialog } from "@/components/dialog-kit/notice-dialog";
import { OperationProgressDialog } from "@/components/dialog-kit/operation-progress-dialog";
import { MergeBranchDialog, mergeCandidates } from "./merge-branch-dialog";
import { RebaseBranchDialog, rebaseCandidates } from "./rebase-branch-dialog";
import { RenameBranchDialog } from "./rename-branch-dialog";

type BranchDialogsProps = {
  readonly branchState: BranchState;
  /** Each is `null` while its dialog is closed, so state and openness cannot disagree. */
  readonly rename: {
    readonly branch: Branch;
    readonly name: string;
    readonly onNameChange: (value: string) => void;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly deletion: {
    readonly branch: Branch | null;
    readonly refusal: string | null;
    readonly unmerged: boolean;
    readonly pruneTrackingRef: boolean;
    readonly onPruneChange: (value: boolean) => void;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly merge: {
    readonly target: string | null;
    readonly onTargetChange: (value: string) => void;
    readonly message: string | null;
    readonly running: boolean;
    readonly status: MergeTreeResult | null;
    readonly commitCount: number;
    readonly strategy: MergeStrategy;
    readonly onStrategyChange: (value: MergeStrategy) => void;
    readonly previewError: string | null;
    readonly mergedBranches: ReadonlyMap<string, string>;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly rebase: {
    readonly target: string | null;
    readonly onTargetChange: (value: string) => void;
    readonly message: string | null;
    readonly running: boolean;
    readonly preview: RebasePreview | null;
    readonly previewError: string | null;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly operationViewModel: OperationProgressViewModel | undefined;
  readonly onCancelOperation: () => void;
  readonly onAdoptCancellation: () => void;
  readonly onDismissOperation: () => void;
};

/**
 * Every dialog the branch feature owns: rename, delete, merge, rebase.
 *
 * Split out of `app-dialogs.tsx`, which reached 103 props by being the one signature every
 * dialog's state passed through. Moving these here does not by itself reduce how much state is
 * threaded — it stops it all arriving in one place. A field added to the merge dialog now touches
 * this type, and the shell composes hosts rather than owning every dialog's wiring.
 */
export function BranchDialogs({
  branchState,
  rename,
  deletion,
  merge,
  rebase,
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
  onDismissOperation,
}: BranchDialogsProps) {
  // Derived rather than passed: both were `branchState.progress` narrowed by kind at the call
  // site, which made them two props carrying no information the host did not already have.
  const mergeProgress = branchState.progress?.kind === "generic" ? branchState.progress : null;
  const rebaseProgress =
    branchState.progress?.kind === "multiCommitOperation" ? branchState.progress : null;

  return (
    <>
      {/*
       * A rebase's progress belongs to the picker while the picker is open — it swaps to the shared
       * progress dialog in place. This covers the other route in, a rebase continued from the
       * conflict surface, where there is no picker to swap.
       */}
      {operationViewModel?.operation === "rebase" && rebase === null && (
        <OperationProgressDialog
          viewModel={operationViewModel}
          onCancel={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
          onClose={onDismissOperation}
        />
      )}

      {rename !== null && (
        <RenameBranchDialog
          branch={rename.branch}
          name={rename.name}
          existingNames={branchState.branches
            .filter((branch) => branch.type === BranchType.Local)
            .map((branch) => branch.name)}
          busy={branchState.operation === "renaming"}
          failure={branchState.dialogError}
          onNameChange={rename.onNameChange}
          onConfirm={rename.onConfirm}
          onCancel={rename.onCancel}
        />
      )}

      {deletion?.refusal != null ? (
        <NoticeDialog title="Cannot delete branch" onDismiss={deletion.onCancel}>
          {deletion.refusal}
        </NoticeDialog>
      ) : (
        deletion?.branch != null && (
          <ConfirmDialog
            title="Delete branch"
            description={
              <>
                Delete <strong>{deletion.branch.name}</strong>?
                {deletion.branch.upstream !== null &&
                  ` This branch tracks ${deletion.branch.upstream}.`}
              </>
            }
            confirmLabel="Delete branch"
            onConfirm={deletion.onConfirm}
            onCancel={deletion.onCancel}
          >
            {deletion.unmerged && (
              <p className="rounded-[var(--radius-small)] border border-[var(--warning-border)] bg-[var(--warning-surface)] px-2.5 py-2 text-[var(--warning-text)]">
                This branch has commits that are not in the current branch. Deleting it will
                permanently remove them.
              </p>
            )}
            {deletion.branch.upstream !== null && (
              <label className="flex w-fit items-center gap-2">
                <Checkbox
                  checked={deletion.pruneTrackingRef}
                  onCheckedChange={(value) => deletion.onPruneChange(value === true)}
                />
                Also remove the local record of the remote branch ({deletion.branch.upstream})
              </label>
            )}
          </ConfirmDialog>
        )
      )}

      {merge !== null && (
        <MergeBranchDialog
          currentBranch={branchState.currentBranch ?? "—"}
          candidates={mergeCandidates(
            branchState.branches,
            branchState.currentBranch,
            merge.mergedBranches,
          )}
          defaultBranch={branchState.defaultBranch}
          recentBranches={branchState.recentBranches}
          selected={branchState.branches.find((branch) => branch.name === merge.target) ?? null}
          strategy={merge.strategy}
          status={merge.status}
          commitCount={merge.commitCount}
          running={merge.running}
          progress={mergeProgress}
          failure={merge.message ?? merge.previewError}
          onSelect={(branch) => merge.onTargetChange(branch.name)}
          onStrategyChange={merge.onStrategyChange}
          onConfirm={merge.onConfirm}
          onCancel={merge.onCancel}
          operationViewModel={
            operationViewModel?.operation === "merge" ? operationViewModel : undefined
          }
          onCancelOperation={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
        />
      )}

      {rebase !== null && (
        <RebaseBranchDialog
          currentBranch={branchState.currentBranch ?? "—"}
          candidates={rebaseCandidates(branchState.branches, branchState.currentBranch)}
          defaultBranch={branchState.defaultBranch}
          recentBranches={branchState.recentBranches}
          selected={branchState.branches.find((branch) => branch.name === rebase.target) ?? null}
          preview={rebase.preview}
          running={rebase.running}
          progress={rebaseProgress}
          failure={rebase.message ?? rebase.previewError}
          onSelect={(branch) => rebase.onTargetChange(branch.name)}
          onConfirm={rebase.onConfirm}
          onCancel={rebase.onCancel}
          operationViewModel={
            operationViewModel?.operation === "rebase" ? operationViewModel : undefined
          }
          onCancelOperation={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
        />
      )}
    </>
  );
}
