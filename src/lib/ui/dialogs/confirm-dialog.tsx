import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { DialogFailure } from "./dialog-failure";

type ConfirmDialogProps = {
  readonly title: string;
  /** Rendered as the dialog's accessible description. */
  readonly description: ReactNode;
  /** Label for the affirmative action. */
  readonly confirmLabel: string;
  /** Shown in place of `confirmLabel` while the operation runs. */
  readonly busyLabel?: string;
  readonly cancelLabel?: string;
  /** True while the confirmed operation is in flight. Blocks every dismissal path. */
  readonly busy?: boolean;
  /**
   * A failure from the confirmed operation, rendered inline with the dialog left open.
   *
   * Convention 17: the dialog owns the failure of the action it confirmed. Passing this obliges the
   * caller to keep Cancel reachable once the operation is no longer in flight.
   */
  readonly error?: string | null;
  /** Extra content between the description and the footer — a file list, a checkbox, a warning. */
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/**
 * The shared shape of a destructive confirmation.
 *
 * Conventions 1, 2, 4 and 5 of `COMPONENT_MIGRATION_PROCESS.md` are encoded here rather than
 * restated in each dialog: the safe action is `AlertDialogCancel` so Radix focuses it on open, the
 * button order is platform-specific, the affirmative action is tinted and bordered, and the footer
 * carries no separator.
 *
 * Dismissal is funnelled through `onOpenChange` so Escape, the Cancel button and any future
 * dismissal path share one guard. While `busy` is true every one of them is refused — losing the
 * dialog mid-operation would leave the user with no idea whether it completed.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  busy = false,
  error = null,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancel = <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>;
  const confirm = (
    <AlertDialogAction
      variant="destructive"
      disabled={busy}
      onClick={(event) => {
        // Radix's Action is a Dialog.Close, and its close runs through composeEventHandlers, which
        // skips it when the event is already default-prevented. Preventing here keeps the dialog
        // mounted while the operation runs, so it can show progress and report a failure in place.
        event.preventDefault();
        onConfirm();
      }}
    >
      {busy && busyLabel !== undefined ? busyLabel : confirmLabel}
    </AlertDialogAction>
  );

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onCancel();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="flex items-center gap-2">
            <CircleAlert className="text-[var(--warning-text)]" aria-hidden />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <DialogFailure error={error ?? null} />
        <AlertDialogFooter>
          {__DARWIN__ ? (
            <>
              {cancel}
              {confirm}
            </>
          ) : (
            <>
              {confirm}
              {cancel}
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
