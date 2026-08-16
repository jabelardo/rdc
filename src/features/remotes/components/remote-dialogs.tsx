import type { IRemote } from "@/models/remote";
import type { CloneState } from "@/features/remotes/stores/clone-store";
import { operationProgressViewModel } from "@/lib/operations/operation-presentation";
import { AddRemoteDialog } from "./add-remote-dialog";
import { CloneRepositoryDialog } from "./clone-repository-dialog";
import { ManageRemotesDialog } from "./manage-remotes-dialog";

type RemoteDialogsProps = {
  /** Each is `null` while its dialog is closed, so state and openness cannot disagree. */
  readonly manage: {
    readonly remotes: ReadonlyArray<IRemote>;
    readonly filter: string;
    readonly onFilterChange: (value: string) => void;
    readonly onNewRemote: () => void;
    readonly onRemoveRemote: (name: string) => void;
    readonly onDismiss: () => void;
  } | null;
  readonly add: {
    readonly name: string;
    readonly url: string;
    readonly remotes: ReadonlyArray<IRemote>;
    readonly onNameChange: (value: string) => void;
    readonly onURLChange: (value: string) => void;
    readonly onConfirm: () => void;
    readonly onDismiss: () => void;
  } | null;
  readonly clone: {
    readonly state: CloneState;
    readonly url: string;
    readonly path: string;
    readonly onURLChange: (value: string) => void;
    readonly onPathChange: (value: string) => void;
    readonly onChooseDestination: () => void;
    readonly onConfirm: () => void;
    readonly onCancelOperation: () => void;
    readonly onDismiss: () => void;
  } | null;
  /** Shared by manage and add: an add or a remove is in flight. */
  readonly error: string | null;
  readonly busy: boolean;
};

/** Every dialog the remotes feature owns: manage, add, clone. */
export function RemoteDialogs({ manage, add, clone, error, busy }: RemoteDialogsProps) {
  return (
    <>
      {manage !== null && (
        <ManageRemotesDialog
          remotes={manage.remotes}
          filter={manage.filter}
          busy={busy}
          onFilterChange={manage.onFilterChange}
          onNewRemote={manage.onNewRemote}
          onRemoveRemote={manage.onRemoveRemote}
          onDismiss={manage.onDismiss}
        />
      )}

      {add !== null && (
        <AddRemoteDialog
          name={add.name}
          url={add.url}
          remotes={add.remotes}
          busy={busy}
          error={error}
          onNameChange={add.onNameChange}
          onURLChange={add.onURLChange}
          onConfirm={add.onConfirm}
          onDismiss={add.onDismiss}
        />
      )}

      {clone !== null && (
        <CloneRepositoryDialog
          url={clone.url}
          path={clone.path}
          onUrlChange={clone.onURLChange}
          onPathChange={clone.onPathChange}
          running={clone.state.operation !== null}
          progress={clone.state.progress}
          error={clone.state.error}
          operationViewModel={
            clone.state.nativeOperation == null
              ? undefined
              : operationProgressViewModel(
                  clone.state.nativeOperation,
                  clone.state.nativeOperation.ownerWindow ?? "",
                  clone.state.nativeOperation.ownerWindow === null ? "unowned" : "owner",
                )
          }
          onCancelOperation={clone.onCancelOperation}
          onChooseDestination={clone.onChooseDestination}
          onConfirm={clone.onConfirm}
          onCancel={clone.onDismiss}
        />
      )}
    </>
  );
}
