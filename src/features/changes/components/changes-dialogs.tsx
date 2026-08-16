import type { WorkingDirectoryFileChange } from "@/models/status";
import type {
  HookFailureState,
  RunningHookState,
  WorkingTreeStore,
} from "@/features/changes/stores/working-tree-store";
import type { OperationProgressViewModel } from "@/lib/operations/operation-presentation";
import { ConfirmDialog } from "@/components/dialog-kit/confirm-dialog";
import { ConfirmOptOut } from "@/components/dialog-kit/confirm-opt-out";
import { OperationProgressDialog } from "@/components/dialog-kit/operation-progress-dialog";
import { TerminalOutput } from "@/components/terminal-output";
import { DiscardFileList, discardAllQuestion } from "./discard-file-list";
import { HookFailureDialog } from "./hook-failure-dialog";

type ChangesDialogsProps = {
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
  readonly onCancelDiscard: () => void;
  readonly onConfirmDiscard: () => void;
  readonly onCancelDiscardAll: () => void;
  readonly onConfirmDiscardAll: () => void;

  readonly commitLoading: boolean;
  readonly commitTerminalOutput: string;
  readonly hookFailure: HookFailureState | null;
  readonly runningHook: RunningHookState | null;
  readonly workingTreeStore: WorkingTreeStore;

  readonly operationViewModel: OperationProgressViewModel | undefined;
  readonly onCancelOperation: () => void;
  readonly onAdoptCancellation: () => void;
};

/**
 * Every dialog the changes feature owns: discarding, the commit's progress, and the hook decision.
 *
 * The commit progress dialog is here rather than with the other operation progress because its
 * content is a commit's — the running-hook stop button and the terminal stream — and because it is
 * suppressed while a hook failure is being decided, which only this feature knows.
 */
export function ChangesDialogs({
  discardFile,
  permanentlyDiscard,
  discardSelection,
  discardAll,
  discardOptOut,
  onDiscardOptOutChange,
  discarding,
  workingTreeError,
  onCancelDiscard,
  onConfirmDiscard,
  onCancelDiscardAll,
  onConfirmDiscardAll,
  commitLoading,
  commitTerminalOutput,
  hookFailure,
  runningHook,
  workingTreeStore,
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
}: ChangesDialogsProps) {
  return (
    <>
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
    </>
  );
}
