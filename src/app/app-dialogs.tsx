import type { Repository } from "@/models/repository";
import type {
  PreferencesState,
  PreferencesStore,
} from "@/features/preferences/stores/preferences-store";
import type { Architecture } from "@/platform/paths";
import { ConfirmDialog } from "@/components/dialog-kit/confirm-dialog";
import { OperationProgressDialog } from "@/components/dialog-kit/operation-progress-dialog";
import { PreferencesDialog } from "@/features/preferences/components/preferences-dialog";
import type { OperationProgressViewModel } from "@/lib/operations/operation-presentation";
import { AboutDialog } from "./about-dialog";

type AppDialogsProps = {
  readonly operationViewModel: OperationProgressViewModel | undefined;
  readonly onCancelOperation: () => void;
  readonly onAdoptCancellation: () => void;
  readonly onDismissOperation: () => void;
  readonly repositoryToRemove: Repository | null;
  readonly showAboutDialog: boolean;
  readonly appArchitecture: Architecture | null;
  readonly showPreferencesDialog: boolean;
  readonly preferencesState: PreferencesState;
  readonly preferencesStore: PreferencesStore;
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
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
  onDismissOperation,
  repositoryToRemove,
  showAboutDialog,
  appArchitecture,
  showPreferencesDialog,
  preferencesState,
  preferencesStore,
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
