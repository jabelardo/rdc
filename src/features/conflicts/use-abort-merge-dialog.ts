import { useEffect, useState } from "react";
import type { ConflictState, ConflictStore } from "@/features/conflicts/stores/conflict-store";

type AbortMergeDialogOptions = {
  readonly repositoryPath: string | null;
  readonly conflictState: ConflictState;
  readonly conflictStore: ConflictStore;
  /**
   * Reloads what a successful abort invalidated.
   *
   * Aborting moves `HEAD` and the index, not just the conflict state, so the working tree and the
   * branch list are both stale afterwards. Reloading them belongs to those features; the app knows
   * all three and supplies the callback.
   */
  readonly onAborted: (repositoryPath: string) => Promise<unknown>;
};

/** Abandoning an in-progress merge, and the confirmation that guards it. */
export function useAbortMergeDialog({
  repositoryPath,
  conflictState,
  conflictStore,
  onAborted,
}: AbortMergeDialogOptions) {
  const [confirming, setConfirming] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Selecting a different repository closes the dialog. Keyed on the path rather than the
  // Repository object, so a background refresh that replaces the object does not close it.
  useEffect(() => {
    setConfirming(false);
    setAborting(false);
    setFailure(null);
  }, [repositoryPath]);

  function requestAbortMerge(): void {
    if (repositoryPath === null || !conflictState.mergeInProgress) {
      return;
    }
    setFailure(null);
    setConfirming(true);
  }

  function cancelAbortMerge(): void {
    if (aborting) {
      return;
    }
    setConfirming(false);
    setFailure(null);
  }

  /**
   * Abandons the merge after the user has confirmed.
   *
   * The dialog stays open until the abort settles and keeps its failure inline — Convention 17 —
   * and Cancel stays enabled whenever the abort is not in flight. Clearing `aborting` before
   * setting the failure is what keeps that true: a dialog showing a failure with every exit
   * disabled is a trap, and the order of these two lines is the whole guarantee.
   */
  async function confirmAbortMerge(): Promise<void> {
    if (repositoryPath === null || aborting) {
      return;
    }
    setFailure(null);
    setAborting(true);
    const abortFailure = await conflictStore.abortMerge();
    setAborting(false);
    if (abortFailure !== null) {
      setFailure(abortFailure);
      return;
    }
    setConfirming(false);
    await onAborted(repositoryPath);
  }

  return {
    /** `null` while closed, so the dialog's state and its openness cannot disagree. */
    abortMergeDialog: !confirming
      ? null
      : { aborting, failure, onConfirm: confirmAbortMerge, onCancel: cancelAbortMerge },
    /** Offered by the conflict banner and the Branch menu. */
    requestAbortMerge,
    /** Help → Show Dialog → Abort merge, with and without a failure. */
    showAbortMergePreview: (previewFailure: string | null) => {
      setFailure(previewFailure);
      setConfirming(true);
    },
  };
}
