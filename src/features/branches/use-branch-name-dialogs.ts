import { useEffect, useState } from "react";
import { BranchType, type Branch } from "@/models/branch";
import type { BranchState, BranchStore } from "@/features/branches/stores/branch-store";
import { getMergedBranches } from "@/lib/ipc/branch-ipc";
import { deleteBranchRefusal } from "@/features/branches/delete-branch-refusal";

type BranchNameDialogsOptions = {
  readonly repositoryPath: string | null;
  readonly branchState: BranchState;
  readonly branchStore: BranchStore;
  /**
   * Runs a branch mutation and refreshes whatever it invalidated.
   *
   * Supplied rather than reached for: renaming or deleting a branch also moves the working tree and
   * the history, and reloading those is not the branch feature's business.
   */
  readonly refreshAfterBranchChange: (mutate: () => Promise<boolean>) => Promise<boolean>;
};

/**
 * Renaming and deleting a branch — the two dialogs that act on a branch's name.
 *
 * Extracted from `use-app-controller.ts`. Merge and rebase live in their own hook: they share a
 * picker, a preview and a running state, and none of that is shared with these two.
 */
export function useBranchNameDialogs({
  repositoryPath,
  branchState,
  branchStore,
  refreshAfterBranchChange,
}: BranchNameDialogsOptions) {
  const [branchToRename, setBranchToRename] = useState<Branch | null>(null);
  const [renameName, setRenameName] = useState("");
  const [branchToDelete, setBranchToDelete] = useState<Branch | null>(null);
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const [deleteUnmerged, setDeleteUnmerged] = useState(false);
  const [deletePruneTrackingRef, setDeletePruneTrackingRef] = useState(false);

  // Selecting a different repository closes these dialogs. Keyed on the path rather than the
  // Repository object, so a background refresh that replaces the object does not close them.
  useEffect(() => {
    setBranchToRename(null);
    setBranchToDelete(null);
    setDeleteRefusal(null);
    setDeleteUnmerged(false);
    setDeletePruneTrackingRef(false);
  }, [repositoryPath]);

  /** The local branch a menu item means when it says "the current branch". */
  function currentLocalBranch(): Branch | undefined {
    const current = branchStore.state.currentBranch;
    if (current === null) {
      return undefined;
    }
    return branchStore.state.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === current,
    );
  }

  function requestRename(branch: Branch): void {
    setBranchToRename(branch);
    setRenameName(branch.name);
  }

  function renameCurrentBranch(): void {
    const branch = currentLocalBranch();
    if (branch !== undefined) {
      requestRename(branch);
    }
  }

  async function confirmRename(): Promise<void> {
    if (branchToRename === null) {
      return;
    }
    const branch = branchToRename;
    await refreshAfterBranchChange(() => branchStore.renameBranch(branch.name, renameName));
    if (branchStore.state.dialogError === null) {
      setBranchToRename(null);
      setRenameName("");
    }
  }

  function cancelRename(): void {
    if (branchStore.state.operation !== null) {
      return;
    }
    setBranchToRename(null);
    setRenameName("");
  }

  function deleteCurrentBranch(): void {
    const branch = currentLocalBranch();
    if (branch !== undefined) {
      void requestDelete(branch);
    }
  }

  async function requestDelete(branch: Branch): Promise<void> {
    const refusal = deleteBranchRefusal(
      branch.name,
      branchState.currentBranch,
      branchState.defaultBranch,
    );
    if (refusal !== null) {
      setDeleteRefusal(refusal);
      return;
    }
    setDeleteRefusal(null);
    setDeletePruneTrackingRef(false);
    setDeleteUnmerged(false);
    if (repositoryPath !== null && branchState.currentBranch !== null) {
      try {
        const merged = await getMergedBranches(repositoryPath, branchState.currentBranch);
        setDeleteUnmerged(!merged.has(`refs/heads/${branch.name}`));
      } catch {
        setDeleteUnmerged(false);
      }
    }
    setBranchToDelete(branch);
  }

  async function confirmDelete(): Promise<void> {
    if (branchToDelete === null) {
      return;
    }
    const branch = branchToDelete;
    await refreshAfterBranchChange(() =>
      branchStore.deleteBranch(branch.name, { pruneTrackingRef: deletePruneTrackingRef }),
    );
    if (branchStore.state.dialogError === null) {
      setBranchToDelete(null);
      setDeleteUnmerged(false);
      setDeletePruneTrackingRef(false);
    }
  }

  function cancelDelete(): void {
    if (branchStore.state.operation !== null) {
      return;
    }
    setBranchToDelete(null);
    setDeleteRefusal(null);
    setDeleteUnmerged(false);
    setDeletePruneTrackingRef(false);
  }

  return {
    /** `null` while closed, so the dialog's state and its openness cannot disagree. */
    renameDialog:
      branchToRename === null
        ? null
        : {
            branch: branchToRename,
            name: renameName,
            onNameChange: setRenameName,
            onConfirm: confirmRename,
            onCancel: cancelRename,
          },
    /** One group for both shapes: the refusal notice and the confirmation. */
    deleteDialog:
      deleteRefusal === null && branchToDelete === null
        ? null
        : {
            branch: branchToDelete,
            refusal: deleteRefusal,
            unmerged: deleteUnmerged,
            pruneTrackingRef: deletePruneTrackingRef,
            onPruneChange: setDeletePruneTrackingRef,
            onConfirm: confirmDelete,
            onCancel: cancelDelete,
          },
    requestRename,
    renameCurrentBranch,
    requestDelete,
    deleteCurrentBranch,
    /** Help → Show Dialog → Cannot delete branch: the notice has no other route in. */
    showDeleteRefusal: (message: string) => setDeleteRefusal(message),
  };
}
