import { useState } from "react";
import { join } from "@tauri-apps/api/path";
import type { CloneState, CloneStore } from "@/features/remotes/stores/clone-store";
import { getCloneDirectoryName } from "@/features/remotes/clone-destination";
import { currentMenuPlatform } from "@/models/menu-platform";
import { showOpenDialog, showSaveDialog } from "@/platform/dialogs";
import { reportError } from "@/lib/messages/report";

type CloneDialogOptions = {
  readonly cloneState: CloneState;
  readonly cloneStore: CloneStore;
  /**
   * Registers the freshly cloned repository. Adding it to the list is the repositories feature's
   * job, so the app passes it in rather than this hook reaching across.
   */
  readonly onCloned: (path: string) => Promise<unknown>;
};

/**
 * Cloning a repository: the URL, the destination, and choosing that destination natively.
 *
 * Extracted from `use-app-controller.ts`. It has no repository-change reset, unlike every other
 * dialog hook — cloning is what produces a repository, so it is the one dialog that does not belong
 * to the selected one.
 */
export function useCloneDialog({ cloneState, cloneStore, onCloned }: CloneDialogOptions) {
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [cloneURL, setCloneURL] = useState("");
  const [clonePath, setClonePath] = useState("");

  function openCloneDialog(): void {
    cloneStore.reset();
    setShowCloneDialog(true);
  }

  function dismissCloneDialog(): void {
    if (cloneState.operation !== null) {
      return;
    }
    cloneStore.reset();
    setShowCloneDialog(false);
  }

  async function chooseCloneDestination(): Promise<void> {
    // macOS names the target directory in a save panel; elsewhere the user picks a parent and the
    // directory name is derived from the URL, matching each platform's own convention.
    const platform = currentMenuPlatform();
    if (platform === "macos") {
      const selected = await showSaveDialog({
        title: "Choose a clone destination",
        defaultPath: clonePath || undefined,
        properties: ["createDirectory"],
      });
      if (selected !== null) {
        setClonePath(selected);
      }
      return;
    }

    const parent = await showOpenDialog({
      title: "Choose a parent directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (parent === null) {
      return;
    }
    const name = getCloneDirectoryName(cloneURL);
    setClonePath(name === null ? parent : await join(parent, name));
  }

  async function submitClone(): Promise<void> {
    const clonedPath = await cloneStore.clone(cloneURL, clonePath);
    if (clonedPath === null) {
      return;
    }
    try {
      await onCloned(clonedPath);
      setCloneURL("");
      setClonePath("");
      setShowCloneDialog(false);
    } catch (error) {
      reportError(error);
    }
  }

  return {
    /** `null` while closed, so the dialog's state and its openness cannot disagree. */
    cloneDialog: !showCloneDialog
      ? null
      : {
          state: cloneState,
          url: cloneURL,
          path: clonePath,
          onURLChange: setCloneURL,
          onPathChange: setClonePath,
          onChooseDestination: chooseCloneDestination,
          onConfirm: submitClone,
          onCancelOperation: () => void cloneStore.requestCancellation(),
          onDismiss: dismissCloneDialog,
        },
    /** Opened from the File menu, the empty state, and Help → Show Dialog. */
    openCloneDialog,
    /**
     * Shows or hides the dialog without touching the store.
     *
     * Only for Help → Show Dialog → Clone in progress, which injects a canned in-flight clone and
     * would lose it to `openCloneDialog`'s reset.
     */
    setCloneDialogVisible: setShowCloneDialog,
  };
}
