import type { Repository } from "@/models/repository";
import type { WorkingDirectoryFileChange } from "@/models/status";
import type {
  PreferencesState,
  PreferencesStore,
} from "@/features/preferences/stores/preferences-store";
import type { Architecture } from "@/platform/paths";
import type {
  HookFailureState,
  RunningHookState,
  WorkingTreeStore,
} from "@/features/changes/stores/working-tree-store";
import { ConfirmDialog } from "@/components/dialog-kit/confirm-dialog";
import { ConfirmOptOut } from "@/components/dialog-kit/confirm-opt-out";
import {
  DiscardFileList,
  discardAllQuestion,
} from "@/features/changes/components/discard-file-list";
import { OperationProgressDialog } from "@/components/dialog-kit/operation-progress-dialog";
import { PreferencesDialog } from "@/features/preferences/components/preferences-dialog";
import { TerminalOutput } from "@/components/terminal-output";
import type { OperationProgressViewModel } from "@/lib/operations/operation-presentation";
import { AboutDialog } from "./about-dialog";
import { HookFailureDialog } from "@/features/changes/components/hook-failure-dialog";

type AppDialogsProps = {
  readonly discardFile: WorkingDirectoryFileChange | null;
  readonly permanentlyDiscard: boolean;
  readonly discardSelection: boolean;
  readonly discardAll: {
    readonly permanent: boolean;
    readonly paths: ReadonlyArray<string>;
  } | null;
  readonly discardOptOut: boolean;
  readonly onDiscardOptOutChange: (value: boolean) => void;
  readonly discarding: boolean;
  readonly workingTreeError: string | null;
  readonly hookFailure: HookFailureState | null;
  readonly runningHook: RunningHookState | null;
  readonly commitLoading: boolean;
  readonly commitTerminalOutput: string;
  readonly operationViewModel: OperationProgressViewModel | undefined;
  readonly onCancelOperation: () => void;
  readonly onAdoptCancellation: () => void;
  readonly onDismissOperation: () => void;
  readonly workingTreeStore: WorkingTreeStore;
  readonly repositoryToRemove: Repository | null;
  readonly showAboutDialog: boolean;
  readonly appArchitecture: Architecture | null;
  readonly showPreferencesDialog: boolean;
  readonly preferencesState: PreferencesState;
  readonly preferencesStore: PreferencesStore;
  readonly onCancelDiscard: () => void;
  readonly onConfirmDiscard: () => void;
  readonly onCancelDiscardAll: () => void;
  readonly onConfirmDiscardAll: () => void;
  readonly confirmingAbortMerge: boolean;
  readonly abortingMerge: boolean;
  readonly abortMergeError: string | null;
  readonly onCancelAbortMerge: () => void;
  readonly onConfirmAbortMerge: () => void;
  readonly onCancelRemoveRepository: () => void;
  readonly removeRepositoryError: string | null;
  readonly removingRepository: boolean;
  readonly onConfirmRemoveRepository: () => void;
  readonly onDismissAbout: () => void;
  readonly onDismissPreferences: () => void;
};

/**
 * The application's modal layer.
 *
 * Keeping these workflows together is intentional: only one can be actionable at a time, they
 * own focus restoration through their dialog primitives, and none participates in the repository
 * workspace's layout. Extracting them prevents modal state changes from obscuring the main shell
 * structure.
 */
export function AppDialogs({
  discardFile,
  permanentlyDiscard,
  discardSelection,
  discardAll,
  discardOptOut,
  onDiscardOptOutChange,
  discarding,
  workingTreeError,
  hookFailure,
  runningHook,
  commitLoading,
  commitTerminalOutput,
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
  onDismissOperation,
  workingTreeStore,
  repositoryToRemove,
  showAboutDialog,
  appArchitecture,
  showPreferencesDialog,
  preferencesState,
  preferencesStore,
  onCancelDiscard,
  onConfirmDiscard,
  onCancelDiscardAll,
  onConfirmDiscardAll,
  confirmingAbortMerge,
  abortingMerge,
  abortMergeError,
  onCancelAbortMerge,
  onConfirmAbortMerge,
  onCancelRemoveRepository,
  removeRepositoryError,
  removingRepository,
  onConfirmRemoveRepository,
  onDismissAbout,
  onDismissPreferences,
}: AppDialogsProps) {
  return (
    <>
      {operationViewModel !== undefined &&
        (operationViewModel.operation === "fetch" ||
          operationViewModel.operation === "push" ||
          operationViewModel.operation === "pull") && (
          <OperationProgressDialog
            viewModel={operationViewModel}
            onCancel={onCancelOperation}
            onAdoptCancellation={onAdoptCancellation}
            onClose={onDismissOperation}
          />
        )}

      {commitLoading && hookFailure === null && (
        <OperationProgressDialog
          viewModel={operationViewModel?.operation === "commit" ? operationViewModel : undefined}
          operation="Committing"
          progress={{ value: 0, title: "Committing changes" }}
          onCancel={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
        >
          {runningHook != null && (
            <button type="button" onClick={() => void workingTreeStore.stopHook()}>
              Stop {runningHook.hook} hook
            </button>
          )}
          {commitTerminalOutput.length > 0 && (
            <TerminalOutput output={commitTerminalOutput} aria-label="Commit terminal output" />
          )}
        </OperationProgressDialog>
      )}

      {operationViewModel !== undefined &&
        (operationViewModel.operation === "cherryPick" ||
          operationViewModel.operation === "revert") && (
          <OperationProgressDialog
            viewModel={operationViewModel}
            onCancel={onCancelOperation}
            onAdoptCancellation={onAdoptCancellation}
            onClose={onDismissOperation}
          />
        )}

      {discardFile !== null && (
        <ConfirmDialog
          title={permanentlyDiscard ? "Permanently discard changes" : "Confirm discard changes"}
          description={
            <>
              Are you sure you want to discard{" "}
              {discardSelection ? "the selected changes to " : "all changes to "}
              <strong className="font-mono [overflow-wrap:anywhere]">{discardFile.path}</strong>?
            </>
          }
          confirmLabel={permanentlyDiscard ? "Permanently discard changes" : "Discard changes"}
          busyLabel="Discarding…"
          busy={discarding}
          error={workingTreeError}
          onConfirm={onConfirmDiscard}
          onCancel={onCancelDiscard}
        >
          <p>
            {discardSelection
              ? "Selected changes cannot be restored from the operating system trash."
              : permanentlyDiscard
                ? "Changes cannot be restored after deletion."
                : "Changes can be restored from the operating system trash."}
          </p>
          {!discardSelection && (
            <ConfirmOptOut checked={discardOptOut} onChange={onDiscardOptOutChange} />
          )}
        </ConfirmDialog>
      )}

      {discardAll !== null && (
        <ConfirmDialog
          title={discardAll.permanent ? "Permanently discard all changes" : "Discard all changes"}
          description={discardAllQuestion(discardAll.paths.length)}
          confirmLabel={discardAll.permanent ? "Permanently discard changes" : "Discard changes"}
          busyLabel="Discarding…"
          busy={discarding}
          error={workingTreeError}
          onConfirm={onConfirmDiscardAll}
          onCancel={onCancelDiscardAll}
        >
          <DiscardFileList paths={discardAll.paths} />
          <p>
            {discardAll.permanent
              ? "These changes cannot be recovered."
              : "Untracked files can be recovered from the operating system trash, but changes to tracked files cannot be restored."}
          </p>
          <ConfirmOptOut checked={discardOptOut} onChange={onDiscardOptOutChange} />
        </ConfirmDialog>
      )}

      {hookFailure !== null && (
        <HookFailureDialog
          failure={hookFailure}
          onResolve={(resolution) => workingTreeStore.resolveHookFailure(resolution)}
        />
      )}

      {confirmingAbortMerge && (
        <ConfirmDialog
          title="Abort merge"
          description="Abort the in-progress merge?"
          confirmLabel="Abort merge"
          busyLabel="Aborting…"
          busy={abortingMerge}
          error={abortMergeError}
          onConfirm={onConfirmAbortMerge}
          onCancel={onCancelAbortMerge}
        >
          <p>
            Any conflict resolutions you have not committed will be discarded, and the branch
            returns to where it was before the merge started.
          </p>
        </ConfirmDialog>
      )}

      {repositoryToRemove !== null && (
        <ConfirmDialog
          title="Remove repository"
          description={
            <>
              Remove <strong>{repositoryToRemove.name}</strong> from rdc?
            </>
          }
          confirmLabel="Remove repository"
          busyLabel="Removing…"
          busy={removingRepository}
          error={removeRepositoryError}
          onConfirm={onConfirmRemoveRepository}
          onCancel={onCancelRemoveRepository}
        >
          <p>Files in the repository will not be deleted.</p>
        </ConfirmDialog>
      )}

      {showAboutDialog && <AboutDialog architecture={appArchitecture} onDismiss={onDismissAbout} />}

      {showPreferencesDialog && (
        <PreferencesDialog
          state={preferencesState}
          store={preferencesStore}
          onDismiss={onDismissPreferences}
        />
      )}
    </>
  );
}
