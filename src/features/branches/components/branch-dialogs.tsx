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

  readonly branchToRename: Branch | null;
  readonly renameName: string;
  readonly onRenameNameChange: (value: string) => void;
  readonly onConfirmRename: () => void;
  readonly onCancelRename: () => void;

  readonly branchToDelete: Branch | null;
  readonly deleteRefusal: string | null;
  readonly deleteUnmerged: boolean;
  readonly deletePruneTrackingRef: boolean;
  readonly onDeletePruneChange: (value: boolean) => void;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;

  readonly mergePickerOpen: boolean;
  readonly mergeTarget: string | null;
  readonly onMergeTargetChange: (value: string) => void;
  readonly mergeMessage: string | null;
  readonly mergeRunning: boolean;
  readonly mergeStatus: MergeTreeResult | null;
  readonly mergeCommitCount: number;
  readonly mergeProgress: Extract<BranchState["progress"], { kind: "generic" }> | null;
  readonly mergeStrategy: MergeStrategy;
  readonly onMergeStrategyChange: (value: MergeStrategy) => void;
  readonly mergePreviewError: string | null;
  readonly mergedBranches: ReadonlyMap<string, string>;
  readonly onConfirmMerge: () => void;
  readonly onCancelMerge: () => void;

  readonly rebasePickerOpen: boolean;
  readonly rebaseTarget: string | null;
  readonly onRebaseTargetChange: (value: string) => void;
  readonly rebaseMessage: string | null;
  readonly rebaseRunning: boolean;
  readonly rebaseProgress: Extract<
    BranchState["progress"],
    { kind: "multiCommitOperation" }
  > | null;
  readonly rebasePreview: RebasePreview | null;
  readonly rebasePreviewError: string | null;
  readonly onConfirmRebase: () => void;
  readonly onCancelRebase: () => void;

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
  branchToRename,
  renameName,
  onRenameNameChange,
  onConfirmRename,
  onCancelRename,
  branchToDelete,
  deleteRefusal,
  deleteUnmerged,
  deletePruneTrackingRef,
  onDeletePruneChange,
  onConfirmDelete,
  onCancelDelete,
  mergePickerOpen,
  mergeTarget,
  onMergeTargetChange,
  mergeMessage,
  mergeRunning,
  mergeStatus,
  mergeCommitCount,
  mergeProgress,
  mergeStrategy,
  onMergeStrategyChange,
  mergePreviewError,
  mergedBranches,
  onConfirmMerge,
  onCancelMerge,
  rebasePickerOpen,
  rebaseTarget,
  onRebaseTargetChange,
  rebaseMessage,
  rebaseRunning,
  rebaseProgress,
  rebasePreview,
  rebasePreviewError,
  onConfirmRebase,
  onCancelRebase,
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
  onDismissOperation,
}: BranchDialogsProps) {
  return (
    <>
      {/*
       * A rebase's progress belongs to the picker while the picker is open — it swaps to the shared
       * progress dialog in place. This covers the other route in, a rebase continued from the
       * conflict surface, where there is no picker to swap.
       */}
      {operationViewModel?.operation === "rebase" && !rebasePickerOpen && (
        <OperationProgressDialog
          viewModel={operationViewModel}
          onCancel={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
          onClose={onDismissOperation}
        />
      )}

      {branchToRename !== null && (
        <RenameBranchDialog
          branch={branchToRename}
          name={renameName}
          existingNames={branchState.branches
            .filter((branch) => branch.type === BranchType.Local)
            .map((branch) => branch.name)}
          busy={branchState.operation === "renaming"}
          failure={branchState.dialogError}
          onNameChange={onRenameNameChange}
          onConfirm={onConfirmRename}
          onCancel={onCancelRename}
        />
      )}

      {deleteRefusal !== null ? (
        <NoticeDialog title="Cannot delete branch" onDismiss={onCancelDelete}>
          {deleteRefusal}
        </NoticeDialog>
      ) : (
        branchToDelete !== null && (
          <ConfirmDialog
            title="Delete branch"
            description={
              <>
                Delete <strong>{branchToDelete.name}</strong>?
                {branchToDelete.upstream !== null &&
                  ` This branch tracks ${branchToDelete.upstream}.`}
              </>
            }
            confirmLabel="Delete branch"
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          >
            {deleteUnmerged && (
              <p className="rounded-[var(--radius-small)] border border-[var(--warning-border)] bg-[var(--warning-surface)] px-2.5 py-2 text-[var(--warning-text)]">
                This branch has commits that are not in the current branch. Deleting it will
                permanently remove them.
              </p>
            )}
            {branchToDelete.upstream !== null && (
              <label className="flex w-fit items-center gap-2">
                <Checkbox
                  checked={deletePruneTrackingRef}
                  onCheckedChange={(value) => onDeletePruneChange(value === true)}
                />
                Also remove the local record of the remote branch ({branchToDelete.upstream})
              </label>
            )}
          </ConfirmDialog>
        )
      )}

      {mergePickerOpen && (
        <MergeBranchDialog
          currentBranch={branchState.currentBranch ?? "—"}
          candidates={mergeCandidates(
            branchState.branches,
            branchState.currentBranch,
            mergedBranches,
          )}
          defaultBranch={branchState.defaultBranch}
          recentBranches={branchState.recentBranches}
          selected={branchState.branches.find((branch) => branch.name === mergeTarget) ?? null}
          strategy={mergeStrategy}
          status={mergeStatus}
          commitCount={mergeCommitCount}
          running={mergeRunning}
          progress={mergeProgress}
          failure={mergeMessage ?? mergePreviewError}
          onSelect={(branch) => onMergeTargetChange(branch.name)}
          onStrategyChange={onMergeStrategyChange}
          onConfirm={onConfirmMerge}
          onCancel={onCancelMerge}
          operationViewModel={
            operationViewModel?.operation === "merge" ? operationViewModel : undefined
          }
          onCancelOperation={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
        />
      )}

      {rebasePickerOpen && (
        <RebaseBranchDialog
          currentBranch={branchState.currentBranch ?? "—"}
          candidates={rebaseCandidates(branchState.branches, branchState.currentBranch)}
          defaultBranch={branchState.defaultBranch}
          recentBranches={branchState.recentBranches}
          selected={branchState.branches.find((branch) => branch.name === rebaseTarget) ?? null}
          preview={rebasePreview}
          running={rebaseRunning}
          progress={rebaseProgress}
          failure={rebaseMessage ?? rebasePreviewError}
          onSelect={(branch) => onRebaseTargetChange(branch.name)}
          onConfirm={onConfirmRebase}
          onCancel={onCancelRebase}
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
