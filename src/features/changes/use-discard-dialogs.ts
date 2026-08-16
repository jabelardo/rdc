import { useEffect, useState } from "react";
import type {
  WorkingTreeState,
  WorkingTreeStore,
} from "@/features/changes/stores/working-tree-store";

type DiscardDialogsOptions = {
  readonly repositoryPath: string | null;
  readonly workingTreeState: WorkingTreeState;
  readonly workingTreeStore: WorkingTreeStore;
  /**
   * Whether to confirm, and how to stop asking.
   *
   * Four callbacks rather than the preferences store, because a feature may not import another
   * feature — the app knows both and supplies the wiring. Functions rather than booleans because
   * the reads happen when the command runs: the native menu controller is installed once, so a
   * value captured at render time would be the preference as it stood at first mount.
   */
  readonly confirmations: {
    readonly beforeDiscard: () => boolean;
    readonly beforePermanentDiscard: () => boolean;
    readonly stopAskingBeforeDiscard: () => void;
    readonly stopAskingBeforePermanentDiscard: () => void;
  };
};

/**
 * Discarding: one file, a selection of lines, or the whole tree.
 *
 * Extracted from `use-app-controller.ts`. Both confirmations are one dialog with two shapes, which
 * is why they share a hook and a single busy flag — a discard of either kind blocks the other.
 */
export function useDiscardDialogs({
  repositoryPath,
  workingTreeState,
  workingTreeStore,
  confirmations,
}: DiscardDialogsOptions) {
  const [discardFileID, setDiscardFileID] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [permanentlyDiscard, setPermanentlyDiscard] = useState(false);
  const [discardSelection, setDiscardSelection] = useState(false);
  const [selectedLinesDiscard, setSelectedLinesDiscard] = useState<Awaited<
    ReturnType<WorkingTreeStore["getSelectedLinesDiscard"]>
  > | null>(null);
  const [discardAll, setDiscardAll] = useState<{
    readonly permanent: boolean;
    readonly paths: ReadonlyArray<string>;
  } | null>(null);
  const [discardOptOut, setDiscardOptOut] = useState(false);

  // Selecting a different repository closes these dialogs. Keyed on the path rather than the
  // Repository object, so a background refresh that replaces the object does not close them.
  useEffect(() => {
    setDiscardFileID(null);
    setDiscarding(false);
    setPermanentlyDiscard(false);
    setDiscardSelection(false);
    setSelectedLinesDiscard(null);
    setDiscardAll(null);
  }, [repositoryPath]);

  const discardFile =
    workingTreeState.workingDirectory?.files.find((file) => file.id === discardFileID) ?? null;

  function requestDiscard(fileID: string, selection: boolean): void {
    if (selection || confirmations.beforeDiscard()) {
      const selectedLines = selection ? workingTreeStore.getSelectedLinesDiscard() : null;
      if (selection && selectedLines === null) {
        return;
      }
      setDiscardOptOut(false);
      setDiscardFileID(fileID);
      setDiscardSelection(selection);
      setSelectedLinesDiscard(selectedLines);
      setPermanentlyDiscard(false);
      return;
    }
    void discardWholeFile(fileID, false);
  }

  async function discardWholeFile(fileID: string, permanent: boolean): Promise<void> {
    setDiscarding(true);
    let result = await workingTreeStore.discardFile(fileID, permanent);
    if (result === "trash-failed" && !confirmations.beforePermanentDiscard()) {
      result = await workingTreeStore.discardFile(fileID, true);
    }
    setDiscarding(false);
    if (result === "discarded") {
      setDiscardFileID(null);
      setPermanentlyDiscard(false);
      setSelectedLinesDiscard(null);
    } else if (result === "trash-failed") {
      setDiscardFileID(fileID);
      setPermanentlyDiscard(true);
      setDiscardSelection(false);
      setSelectedLinesDiscard(null);
    }
  }

  /**
   * Write the "do not show this message again" choice, if the user made one.
   *
   * Called from the confirm paths only. The permanent variant has its own preference because it is
   * the more dangerous of the two and worth switching off separately.
   */
  function applyDiscardOptOut(permanent: boolean): void {
    if (!discardOptOut) {
      return;
    }
    if (permanent) {
      confirmations.stopAskingBeforePermanentDiscard();
    } else {
      confirmations.stopAskingBeforeDiscard();
    }
  }

  async function confirmDiscard(): Promise<void> {
    if (discardFile === null) {
      return;
    }
    applyDiscardOptOut(permanentlyDiscard);
    if (discardSelection) {
      setDiscarding(true);
      const discarded = await workingTreeStore.discardSelectedLines(selectedLinesDiscard);
      setDiscarding(false);
      if (discarded) {
        setDiscardFileID(null);
        setDiscardSelection(false);
        setSelectedLinesDiscard(null);
      }
      return;
    }
    await discardWholeFile(discardFile.id, permanentlyDiscard);
  }

  function cancelDiscard(): void {
    if (discarding) {
      return;
    }
    setDiscardFileID(null);
    setPermanentlyDiscard(false);
    setDiscardSelection(false);
    setSelectedLinesDiscard(null);
    setDiscardAll(null);
  }

  function requestDiscardAll(permanent: boolean): void {
    // The native menu controller is installed once, so a render-time read here would be the
    // working tree as it looked at first mount — empty, before any repository was selected — and
    // the menu item would silently do nothing.
    const files = workingTreeStore.state.workingDirectory?.files ?? [];
    if (files.length === 0) {
      return;
    }
    const shouldConfirm = permanent
      ? confirmations.beforePermanentDiscard()
      : confirmations.beforeDiscard();
    if (shouldConfirm) {
      setDiscardOptOut(false);
      setDiscardAll({ permanent, paths: files.map((file) => file.path) });
      return;
    }
    void discardAllWorkingChanges(permanent);
  }

  async function discardAllWorkingChanges(permanent: boolean): Promise<void> {
    setDiscarding(true);
    let result = await workingTreeStore.discardAllChanges(permanent);
    if (result === "trash-failed" && !confirmations.beforePermanentDiscard()) {
      result = await workingTreeStore.discardAllChanges(true);
    }
    setDiscarding(false);
    if (result === "discarded") {
      setDiscardAll(null);
    } else if (result === "trash-failed") {
      // Re-read the working tree rather than reusing the first list: the failed trash attempt may
      // already have removed some files, so the earlier snapshot is stale.
      const remaining = workingTreeStore.state.workingDirectory?.files ?? [];
      setDiscardAll({ permanent: true, paths: remaining.map((file) => file.path) });
    }
  }

  async function confirmDiscardAll(): Promise<void> {
    if (discardAll === null) {
      return;
    }
    applyDiscardOptOut(discardAll.permanent);
    await discardAllWorkingChanges(discardAll.permanent);
  }

  function cancelDiscardAll(): void {
    if (discarding) {
      return;
    }
    setDiscardAll(null);
  }

  return {
    /** `null` while both dialogs are closed; `file` and `all` say which shape is showing. */
    discardDialog:
      discardFile === null && discardAll === null
        ? null
        : {
            file: discardFile,
            all: discardAll,
            permanently: permanentlyDiscard,
            selectionOnly: discardSelection,
            optOut: discardOptOut,
            onOptOutChange: setDiscardOptOut,
            discarding,
            failure: workingTreeState.discardError,
            onConfirm: discardFile === null ? confirmDiscardAll : confirmDiscard,
            onCancel: discardFile === null ? cancelDiscardAll : cancelDiscard,
          },
    /** Opened from the changed-files list, its context menu, and the Repository menu. */
    requestDiscard,
    requestDiscardAll,
    /** Help → Show Dialog → Discard file: shows the dialog for whichever file the stub injected. */
    showDiscardFilePreview: (fileID: string) => {
      setDiscardFileID(fileID);
      setDiscardSelection(false);
      setPermanentlyDiscard(false);
    },
  };
}
