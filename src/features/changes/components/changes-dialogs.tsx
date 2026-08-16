import type { WorkingDirectoryFileChange } from "@/models/status";
import type {
  HookFailureState,
  RunningHookState,
} from "@/features/changes/stores/working-tree-store";
import type { OperationProgressViewModel } from "@/lib/operations/operation-presentation";
import { ConfirmDialog } from "@/components/dialog-kit/confirm-dialog";
import { ConfirmOptOut } from "@/components/dialog-kit/confirm-opt-out";
import { OperationProgressDialog } from "@/components/dialog-kit/operation-progress-dialog";
import { TerminalOutput } from "@/components/terminal-output";
import { DiscardFileList, discardAllQuestion } from "./discard-file-list";
import { HookFailureDialog } from "./hook-failure-dialog";

type ChangesDialogsProps = {
  /** Each is `null` while its dialog is closed, so state and openness cannot disagree. */
  readonly discard: {
    /** Set for a single file; `null` when the whole tree is being discarded. */
    readonly file: WorkingDirectoryFileChange | null;
    readonly all: {
      readonly permanent: boolean;
      readonly paths: ReadonlyArray<string>;
    } | null;
    readonly permanently: boolean;
    readonly selectionOnly: boolean;
    readonly optOut: boolean;
    readonly onOptOutChange: (value: boolean) => void;
    readonly discarding: boolean;
    readonly failure: string | null;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  } | null;
  readonly commitProgress: {
    readonly terminalOutput: string;
    readonly runningHook: RunningHookState | null;
    readonly onStopHook: () => void;
  } | null;
  readonly hookFailure: {
    readonly failure: HookFailureState;
    readonly onResolve: (resolution: "abort" | "ignore") => void;
  } | null;

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
  discard,
  commitProgress,
  hookFailure,
  operationViewModel,
  onCancelOperation,
  onAdoptCancellation,
}: ChangesDialogsProps) {
  return (
    <>
      {commitProgress !== null && hookFailure === null && (
        <OperationProgressDialog
          viewModel={operationViewModel?.operation === "commit" ? operationViewModel : undefined}
          operation="Committing"
          progress={{ value: 0, title: "Committing changes" }}
          onCancel={onCancelOperation}
          onAdoptCancellation={onAdoptCancellation}
        >
          {commitProgress.runningHook != null && (
            <button type="button" onClick={() => commitProgress.onStopHook()}>
              Stop {commitProgress.runningHook.hook} hook
            </button>
          )}
          {commitProgress.terminalOutput.length > 0 && (
            <TerminalOutput
              output={commitProgress.terminalOutput}
              aria-label="Commit terminal output"
            />
          )}
        </OperationProgressDialog>
      )}

      {discard?.file != null && (
        <ConfirmDialog
          title={discard.permanently ? "Permanently discard changes" : "Confirm discard changes"}
          description={
            <>
              Are you sure you want to discard{" "}
              {discard.selectionOnly ? "the selected changes to " : "all changes to "}
              <strong className="font-mono [overflow-wrap:anywhere]">{discard.file.path}</strong>?
            </>
          }
          confirmLabel={discard.permanently ? "Permanently discard changes" : "Discard changes"}
          busyLabel="Discarding…"
          busy={discard.discarding}
          error={discard.failure}
          onConfirm={discard.onConfirm}
          onCancel={discard.onCancel}
        >
          <p>
            {discard.selectionOnly
              ? "Selected changes cannot be restored from the operating system trash."
              : discard.permanently
                ? "Changes cannot be restored after deletion."
                : "Changes can be restored from the operating system trash."}
          </p>
          {!discard.selectionOnly && (
            <ConfirmOptOut checked={discard.optOut} onChange={discard.onOptOutChange} />
          )}
        </ConfirmDialog>
      )}

      {discard?.all != null && (
        <ConfirmDialog
          title={discard.all.permanent ? "Permanently discard all changes" : "Discard all changes"}
          description={discardAllQuestion(discard.all.paths.length)}
          confirmLabel={discard.all.permanent ? "Permanently discard changes" : "Discard changes"}
          busyLabel="Discarding…"
          busy={discard.discarding}
          error={discard.failure}
          onConfirm={discard.onConfirm}
          onCancel={discard.onCancel}
        >
          <DiscardFileList paths={discard.all.paths} />
          <p>
            {discard.all.permanent
              ? "These changes cannot be recovered."
              : "Untracked files can be recovered from the operating system trash, but changes to tracked files cannot be restored."}
          </p>
          <ConfirmOptOut checked={discard.optOut} onChange={discard.onOptOutChange} />
        </ConfirmDialog>
      )}

      {hookFailure !== null && (
        <HookFailureDialog failure={hookFailure.failure} onResolve={hookFailure.onResolve} />
      )}
    </>
  );
}
