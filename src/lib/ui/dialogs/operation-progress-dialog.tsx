import type { ReactNode } from "react";
import type { IProgress } from "../../../models/progress";
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

type OperationProgressDialogProps = {
  /** Capitalized operation name; the title reads "<operation> in progress". */
  readonly operation: string;
  /** Any git progress event: a 0–1 value plus title and description where git provides them. */
  readonly progress: Pick<IProgress, "value"> & Partial<Pick<IProgress, "title" | "description">>;
  /** Which commit a multi-commit operation is applying, shown as "commit N of M" + summary. */
  readonly currentCommit?: OperationProgressCommit;
  /** Extra content mounted under the status, e.g. hook terminal output for a commit. */
  readonly children?: ReactNode;
};

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
  operation,
  progress,
  currentCommit,
  children,
}: OperationProgressDialogProps) {
  const value = Math.max(0, Math.min(1, progress.value));
  const statusLine = currentCommit
    ? `Commit ${currentCommit.position} of ${currentCommit.totalCommitCount}${
        currentCommit.summary === "" ? "" : ` — ${currentCommit.summary}`
      }`
    : (progress.description ?? progress.title ?? `${operation} in progress`);

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
          <AlertDialogTitle>{operation} in progress</AlertDialogTitle>
          {/* One element is both the accessible description (announced on open, via
           * aria-describedby) and the live region (re-announced as git reports progress). */}
          <div id={StatusID} role="status" aria-live="polite" className="grid gap-2">
            <Progress value={value * 100} />
            <p className="text-muted-foreground text-xs">{statusLine}</p>
          </div>
          {children}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
