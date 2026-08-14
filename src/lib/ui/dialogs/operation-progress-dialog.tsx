import { useEffect, useRef, type ReactNode } from "react";
import type { IProgress } from "../../../models/progress";
import type { OperationProgressViewModel } from "../../operation-presentation";
import type { OperationState } from "../../../models/operation";
import { Button } from "../../../components/ui/button";
import { Progress } from "../../../components/ui/progress";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";

const StatusID = "operation-progress-status";

/**
 * The state of the commit a multi-commit operation (rebase, cherry-pick, squash, reorder) is
 * currently applying, for the "commit N of M" line.
 */
export type OperationProgressCommit = {
  readonly position: number;
  readonly totalCommitCount: number;
  readonly summary: string;
};

export type OperationProgressDialogProps = {
  /** The native operation view model. New consumers should pass this instead of loose props. */
  readonly viewModel?: OperationProgressViewModel;
  /** Capitalized operation name; the title reads "<operation> in progress". */
  readonly operation?: string;
  /** Any git progress event: a 0–1 value plus title and description where git provides them. */
  readonly progress?: Pick<IProgress, "value"> & Partial<Pick<IProgress, "title" | "description">>;
  /** Which commit a multi-commit operation is applying, shown as "commit N of M" + summary. */
  readonly currentCommit?: OperationProgressCommit;
  /** Extra content mounted under the status, e.g. hook terminal output for a commit. */
  readonly children?: ReactNode;
  /** Requests cancellation through the owning operation store. */
  readonly onCancel?: () => void;
  /** Explicitly adopts cancellation authority after the original owner is gone. */
  readonly onAdoptCancellation?: () => void;
  /** Retries only when the operation policy explicitly marks retry as safe. */
  readonly onRetry?: () => void;
  /** Closes a terminal operation after its recovery/outcome is understood. */
  readonly onClose?: () => void;
};

export type OperationProgressBodyProps = {
  readonly viewModel: Pick<
    OperationProgressViewModel,
    "operationLabel" | "progress" | "statusText" | "contextText" | "error"
  >;
  readonly currentCommit?: OperationProgressCommit;
  readonly children?: ReactNode;
  readonly statusID?: string;
};

function legacyViewModel(
  operation: string,
  progress: OperationProgressDialogProps["progress"],
): Pick<
  OperationProgressViewModel,
  | "operationLabel"
  | "state"
  | "progress"
  | "statusText"
  | "contextText"
  | "cancellationAvailable"
  | "cancellationLabel"
  | "adoptionAvailable"
  | "adoptionLabel"
  | "error"
  | "outcome"
  | "role"
  | "recoveryRequired"
  | "retryAvailable"
> {
  return {
    operationLabel: operation,
    state: "running" as OperationState,
    progress: progress ?? { value: 0 },
    statusText: progress?.description ?? progress?.title ?? `${operation} in progress`,
    contextText: null,
    cancellationAvailable: false,
    cancellationLabel: null,
    adoptionAvailable: false,
    adoptionLabel: null,
    error: null,
    outcome: null,
    role: "owner",
    recoveryRequired: false,
    retryAvailable: false,
  };
}

function progressStatusLine(
  model: OperationProgressBodyProps["viewModel"],
  currentCommit: OperationProgressCommit | undefined,
): string {
  return currentCommit
    ? `Commit ${currentCommit.position} of ${currentCommit.totalCommitCount}${
        currentCommit.summary === "" ? "" : ` — ${currentCommit.summary}`
      }`
    : model.statusText;
}

/** Shared lifecycle content for modal and future embedded progress surfaces. */
export function OperationProgressBody({
  viewModel,
  currentCommit,
  children,
  statusID,
}: OperationProgressBodyProps) {
  const value = Math.max(0, Math.min(1, viewModel.progress.value));
  const statusLine = progressStatusLine(viewModel, currentCommit);
  const showSeparateError = viewModel.error !== null && viewModel.error.message !== statusLine;

  return (
    <div className="grid gap-3">
      <div id={statusID} role="status" aria-live="polite" className="grid gap-2">
        <Progress value={value * 100} />
        <p className="text-muted-foreground text-xs">{statusLine}</p>
        {viewModel.contextText !== null && (
          <p className="text-muted-foreground text-xs">{viewModel.contextText}</p>
        )}
        {showSeparateError && (
          <p role="alert" className="text-destructive text-xs">
            {viewModel.error?.message}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The shared progress dialog every category-1 operation mounts (category 1 = the operation is the
 * point: history moves, clone, commit — see `COMPONENT_MIGRATION_PROCESS.md` § Progress
 * presentation).
 *
 * rdc's translation of desktop-plus's `multi-commit-operation/dialog/progress-dialog.tsx`: an
 * **undismissable** `AlertDialog` that replaces the action dialog the moment the operation starts.
 * Escape, the backdrop and every close request are refused — the user cannot leave until the
 * operation resolves — and there is deliberately **no abort inside**: abort belongs to the conflict
 * step / abort-confirmation, never here. The operation name and the live status ("commit N of M",
 * the latest git line) come from props, so clone, commit and every history operation mount the same
 * component; `children` is the per-operation extension point.
 */
export function OperationProgressDialog({
  viewModel,
  operation,
  progress,
  currentCommit,
  children,
  onCancel,
  onAdoptCancellation,
  onRetry,
  onClose,
}: OperationProgressDialogProps) {
  const model = viewModel ?? legacyViewModel(operation ?? "Operation", progress);
  const terminal = ["completed", "cancelled", "timedOut", "failed"].includes(model.state);
  const title = terminal ? `${model.operationLabel}` : `${model.operationLabel} in progress`;
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (terminal && onClose !== undefined) {
      closeButton.current?.focus();
    }
  }, [onClose, terminal]);
  const showCancel = model.cancellationAvailable && onCancel !== undefined;
  const showAdopt = model.adoptionAvailable && onAdoptCancellation !== undefined;
  const showRetry = model.retryAvailable && onRetry !== undefined;
  const showClose = terminal && onClose !== undefined;

  return (
    <AlertDialog
      open
      onOpenChange={() => {
        // Refuse every dismissal request (Escape, backdrop, a future close affordance). The only
        // way out is the caller unmounting this dialog once the operation resolves.
      }}
    >
      <AlertDialogContent
        className="sm:max-w-[440px]"
        aria-describedby={StatusID}
        // Escape is the one dismissal Radix exposes here; refuse it. A backdrop click routes
        // through the internal DismissableLayer, which fires onOpenChange(false) — and the Root's
        // onOpenChange above refuses that too, so the dialog stays put either way.
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <div className="grid gap-3">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {/* The status element is both the accessible description and the polite live region. */}
          <OperationProgressBody
            viewModel={model}
            currentCommit={currentCommit}
            statusID={StatusID}
          >
            {children}
          </OperationProgressBody>
          {(showCancel || showAdopt || showRetry || showClose) && (
            <div className="flex justify-end gap-2">
              {showCancel && (
                <Button type="button" onClick={onCancel} disabled={model.state === "cancelling"}>
                  {model.cancellationLabel ?? "Cancel"}
                </Button>
              )}
              {showAdopt && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onAdoptCancellation}
                  disabled={model.state === "cancelling"}
                >
                  {model.adoptionLabel ?? "Take control and cancel"}
                </Button>
              )}
              {showRetry && (
                <Button type="button" variant="outline" onClick={onRetry}>
                  Retry
                </Button>
              )}
              {showClose && (
                <Button ref={closeButton} type="button" onClick={onClose}>
                  Close
                </Button>
              )}
            </div>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
