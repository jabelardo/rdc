import type { IRemote } from "@/models/remote";
import type { CloneState } from "@/features/remotes/stores/clone-store";
import { operationProgressViewModel } from "@/lib/operations/operation-presentation";
import { AddRemoteDialog } from "./add-remote-dialog";
import { CloneRepositoryDialog } from "./clone-repository-dialog";
import { ManageRemotesDialog } from "./manage-remotes-dialog";

type RemoteDialogsProps = {
  readonly showManageRemotes: boolean;
  readonly remotes: ReadonlyArray<IRemote>;
  readonly remoteFilter: string;
  readonly onRemoteFilterChange: (value: string) => void;
  readonly onNewRemote: () => void;
  readonly onConfirmRemoveRemote: (name: string) => void;
  readonly onCloseManageRemotes: () => void;

  readonly showAddRemote: boolean;
  readonly addRemoteName: string;
  readonly addRemoteURL: string;
  readonly onAddRemoteNameChange: (value: string) => void;
  readonly onAddRemoteURLChange: (value: string) => void;
  readonly onConfirmAddRemote: () => void;
  readonly onCloseAddRemote: () => void;

  /** Shared by both remote dialogs: an add or a remove is in flight. */
  readonly manageRemoteError: string | null;
  readonly manageRunning: boolean;

  readonly showCloneDialog: boolean;
  readonly cloneState: CloneState;
  readonly cloneURL: string;
  readonly clonePath: string;
  readonly onCloneURLChange: (value: string) => void;
  readonly onClonePathChange: (value: string) => void;
  readonly onChooseCloneDestination: () => void;
  readonly onSubmitClone: () => void;
  readonly onCancelCloneOperation: () => void;
  readonly onDismissClone: () => void;
};

/** Every dialog the remotes feature owns: manage, add, clone. */
export function RemoteDialogs({
  showManageRemotes,
  remotes,
  remoteFilter,
  onRemoteFilterChange,
  onNewRemote,
  onConfirmRemoveRemote,
  onCloseManageRemotes,
  showAddRemote,
  addRemoteName,
  addRemoteURL,
  onAddRemoteNameChange,
  onAddRemoteURLChange,
  onConfirmAddRemote,
  onCloseAddRemote,
  manageRemoteError,
  manageRunning,
  showCloneDialog,
  cloneState,
  cloneURL,
  clonePath,
  onCloneURLChange,
  onClonePathChange,
  onChooseCloneDestination,
  onSubmitClone,
  onCancelCloneOperation,
  onDismissClone,
}: RemoteDialogsProps) {
  return (
    <>
      {showManageRemotes && (
        <ManageRemotesDialog
          remotes={remotes}
          filter={remoteFilter}
          busy={manageRunning}
          onFilterChange={onRemoteFilterChange}
          onNewRemote={onNewRemote}
          onRemoveRemote={onConfirmRemoveRemote}
          onDismiss={onCloseManageRemotes}
        />
      )}

      {showAddRemote && (
        <AddRemoteDialog
          name={addRemoteName}
          url={addRemoteURL}
          remotes={remotes}
          busy={manageRunning}
          error={manageRemoteError}
          onNameChange={onAddRemoteNameChange}
          onURLChange={onAddRemoteURLChange}
          onConfirm={onConfirmAddRemote}
          onDismiss={onCloseAddRemote}
        />
      )}

      {showCloneDialog && (
        <CloneRepositoryDialog
          url={cloneURL}
          path={clonePath}
          onUrlChange={onCloneURLChange}
          onPathChange={onClonePathChange}
          running={cloneState.operation !== null}
          progress={cloneState.progress}
          error={cloneState.error}
          operationViewModel={
            cloneState.nativeOperation == null
              ? undefined
              : operationProgressViewModel(
                  cloneState.nativeOperation,
                  cloneState.nativeOperation.ownerWindow ?? "",
                  cloneState.nativeOperation.ownerWindow === null ? "unowned" : "owner",
                )
          }
          onCancelOperation={onCancelCloneOperation}
          onChooseDestination={onChooseCloneDestination}
          onConfirm={onSubmitClone}
          onCancel={onDismissClone}
        />
      )}
    </>
  );
}
