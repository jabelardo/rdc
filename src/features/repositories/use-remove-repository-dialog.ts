import { useState } from "react";
import type { Repository } from "@/models/repository";
import { describeError } from "@/utils/format-error";

type RemoveRepositoryDialogOptions = {
  /** Removes the repository from the list. Rejects with the reason if it cannot. */
  readonly removeRepository: (repository: Repository) => Promise<unknown>;
  /** Whether to confirm first. A function, so the current preference is read when asked. */
  readonly confirmBeforeRemoving: () => boolean;
  /** Runs an unconfirmed removal through the app's ordinary repository-action guard. */
  readonly runUnconfirmed: (remove: () => Promise<void>) => void;
};

/** Removing a repository from rdc, and the confirmation that guards it. */
export function useRemoveRepositoryDialog({
  removeRepository,
  confirmBeforeRemoving,
  runUnconfirmed,
}: RemoveRepositoryDialogOptions) {
  const [repositoryToRemove, setRepositoryToRemove] = useState<Repository | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // No repository-change reset, deliberately: this dialog is about a repository the user is
  // removing, which is often the selected one, and closing it as the selection moves would cancel
  // the very action being confirmed.

  function requestRemoveRepository(repository: Repository): void {
    if (confirmBeforeRemoving()) {
      setRepositoryToRemove(repository);
    } else {
      runUnconfirmed(async () => {
        await removeRepository(repository);
      });
    }
  }

  function cancelRemoveRepository(): void {
    if (removing) {
      return;
    }
    setRepositoryToRemove(null);
    setFailure(null);
  }

  /**
   * Removes the repository the confirmation dialog is asking about.
   *
   * The dialog stays open until the removal settles, and closes only on success. It used to close
   * first and then run, which made every failure ownerless — Convention 17 in
   * `COMPONENT_MIGRATION_PROCESS.md`. Cancel stays enabled whenever the removal is not in flight,
   * so a repository that cannot be removed does not trap the user in a dialog that keeps failing.
   */
  async function confirmRemoveRepository(): Promise<void> {
    if (repositoryToRemove === null || removing) {
      return;
    }
    const repository = repositoryToRemove;
    setFailure(null);
    setRemoving(true);
    try {
      await removeRepository(repository);
      setRepositoryToRemove(null);
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setRemoving(false);
    }
  }

  return {
    /** `null` while closed, so the dialog's state and its openness cannot disagree. */
    removeRepositoryDialog:
      repositoryToRemove === null
        ? null
        : {
            repository: repositoryToRemove,
            removing,
            failure,
            onConfirm: confirmRemoveRepository,
            onCancel: cancelRemoveRepository,
          },
    /** Offered by the Repository menu and the repository context menu. */
    requestRemoveRepository,
    /** Help → Show Dialog → Remove repository: skips the preference check. */
    showRemoveRepositoryPreview: (repository: Repository) => setRepositoryToRemove(repository),
  };
}
