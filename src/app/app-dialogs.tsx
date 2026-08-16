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

  /** Each is `null` while its dialog is closed, so state and openness cannot disagree. */
  readonly abortMerge: {
    readonly aborting: boolean;
    readonly failure: string | null;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly removeRepository: {
    readonly repository: Repository;
    readonly removing: boolean;
    readonly failure: string | null;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly about: {
    readonly architecture: Architecture | null;
    readonly onDismiss: () => void;
  } | null;
  readonly preferences: {
    readonly state: PreferencesState;
    readonly store: PreferencesStore;
    readonly onDismiss: () => void;
  } | null;
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
  abortMerge,
  removeRepository,
  about,
  preferences,
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

      {abortMerge !== null && (
        <ConfirmDialog
          title="Abort merge"
          description="Abort the in-progress merge?"
          confirmLabel="Abort merge"
          busyLabel="Aborting…"
          busy={abortMerge.aborting}
          error={abortMerge.failure}
          onConfirm={abortMerge.onConfirm}
          onCancel={abortMerge.onCancel}
        >
          <p>
            Any conflict resolutions you have not committed will be discarded, and the branch
            returns to where it was before the merge started.
          </p>
        </ConfirmDialog>
      )}

      {removeRepository !== null && (
        <ConfirmDialog
          title="Remove repository"
          description={
            <>
              Remove <strong>{removeRepository.repository.name}</strong> from rdc?
            </>
          }
          confirmLabel="Remove repository"
          busyLabel="Removing…"
          busy={removeRepository.removing}
          error={removeRepository.failure}
          onConfirm={removeRepository.onConfirm}
          onCancel={removeRepository.onCancel}
        >
          <p>Files in the repository will not be deleted.</p>
        </ConfirmDialog>
      )}

      {about !== null && (
        <AboutDialog architecture={about.architecture} onDismiss={about.onDismiss} />
      )}

      {preferences !== null && (
        <PreferencesDialog
          state={preferences.state}
          store={preferences.store}
          onDismiss={preferences.onDismiss}
        />
      )}
    </>
  );
}
