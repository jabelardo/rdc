import { useEffect, useState } from "react";
import type { IRemote } from "@/models/remote";
import type { RemoteStore } from "@/features/remotes/stores/remote-store";

type RemoteDialogsOptions = {
  readonly repositoryPath: string | null;
  readonly remotes: ReadonlyArray<IRemote>;
  readonly remoteStore: RemoteStore;
  /**
   * Adding or removing a remote invalidates the branch list, and reloading it is the branch
   * feature's job. Passing it in rather than reaching for `branchStore` is what keeps this hook
   * from importing another feature — the app knows both, and it is the only thing that should.
   */
  readonly onRemotesChanged: (repositoryPath: string) => Promise<void>;
};

/**
 * The Manage remotes and Add remote dialogs: their state, their validation, and their commands.
 *
 * Extracted from `use-app-controller.ts`, which had grown to 2,359 lines and 81 pieces of state.
 * The dialogs it returns are the same nullable groups the controller built inline, so nothing above
 * this hook changes shape — only where the state lives.
 */
export function useRemoteDialogs({
  repositoryPath,
  remotes,
  remoteStore,
  onRemotesChanged,
}: RemoteDialogsOptions) {
  const [showManageRemotes, setShowManageRemotes] = useState(false);
  const [remoteFilter, setRemoteFilter] = useState("");
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [addRemoteName, setAddRemoteName] = useState("");
  const [addRemoteURL, setAddRemoteURL] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Selecting a different repository closes these dialogs. This used to be five lines inside the
  // controller's one big reset effect, which had to know every feature's state to do its job — the
  // reason that effect ran to 70 lines. Each feature resetting its own is smaller and safer: a
  // state added here cannot be forgotten there.
  //
  // **Keyed on the path, where the original was keyed on the `Repository` object.** A refresh that
  // replaces the object without changing the path no longer closes an open Manage remotes dialog.
  // That is a deliberate difference and a better answer — losing the dialog to a background refresh
  // would be surprising — but it is a behaviour change, not pure motion.
  useEffect(() => {
    setShowManageRemotes(false);
    setShowAddRemote(false);
    setRemoteFilter("");
    setError(null);
    setBusy(false);
  }, [repositoryPath]);

  function requestManageRemotes(): void {
    setRemoteFilter("");
    setError(null);
    setShowManageRemotes(true);
  }

  function closeManageRemotes(): void {
    if (busy) {
      return;
    }
    setShowManageRemotes(false);
    setShowAddRemote(false);
    setRemoteFilter("");
    setError(null);
  }

  function openAddRemote(): void {
    setAddRemoteName("");
    setAddRemoteURL("");
    setError(null);
    setShowAddRemote(true);
  }

  function closeAddRemote(): void {
    if (busy) {
      return;
    }
    setShowAddRemote(false);
    setError(null);
  }

  async function confirmAddRemote(): Promise<void> {
    if (busy) {
      return;
    }
    const name = addRemoteName.trim();
    const url = addRemoteURL.trim();
    setError(null);
    // Refused here rather than by Git, whose own answers are a usage dump and an "already exists"
    // after the round trip.
    if (name.length === 0 || /\s/.test(name)) {
      setError("Remote names cannot be empty or contain spaces.");
      return;
    }
    if (url.length === 0) {
      setError("Enter a remote URL.");
      return;
    }
    if (remotes.some((remote) => remote.name === name)) {
      setError(`A remote named "${name}" already exists.`);
      return;
    }
    if (repositoryPath === null) {
      return;
    }
    setBusy(true);
    const added = await remoteStore.addRemote(name, url);
    setBusy(false);
    if (added) {
      setShowAddRemote(false);
      setAddRemoteName("");
      setAddRemoteURL("");
      await onRemotesChanged(repositoryPath);
    } else if (remoteStore.state.managementError !== null) {
      setError(remoteStore.state.managementError);
    }
  }

  async function confirmRemoveRemote(name: string): Promise<void> {
    if (busy || repositoryPath === null) {
      return;
    }
    setBusy(true);
    setError(null);
    const removed = await remoteStore.removeRemote(name);
    setBusy(false);
    if (removed) {
      await onRemotesChanged(repositoryPath);
    } else if (remoteStore.state.managementError !== null) {
      setError(remoteStore.state.managementError);
    }
  }

  return {
    /** `null` while closed, so the dialog's state and its openness cannot disagree. */
    manageRemotesDialog: !showManageRemotes
      ? null
      : {
          remotes,
          filter: remoteFilter,
          onFilterChange: setRemoteFilter,
          onNewRemote: openAddRemote,
          onRemoveRemote: confirmRemoveRemote,
          onDismiss: closeManageRemotes,
        },
    addRemoteDialog: !showAddRemote
      ? null
      : {
          name: addRemoteName,
          url: addRemoteURL,
          remotes,
          onNameChange: setAddRemoteName,
          onURLChange: setAddRemoteURL,
          onConfirm: confirmAddRemote,
          onDismiss: closeAddRemote,
        },
    /** Shared by both dialogs: an add or a remove is in flight. */
    manageRemoteError: error,
    manageRunning: busy,
    /** The menu opens Manage remotes; the debug menu opens Add remote on top of it. */
    requestManageRemotes,
    openAddRemote,
    /** Help → Show Dialog → Manage remotes (failed): the preview needs a failure to show. */
    showManageRemotesFailure: (message: string) => {
      requestManageRemotes();
      setError(message);
    },
  };
}
