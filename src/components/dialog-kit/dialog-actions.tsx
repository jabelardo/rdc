import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";

type DialogActionsProps = {
  readonly confirmLabel: string;
  /** Shown in place of `confirmLabel` while the operation runs. */
  readonly busyLabel?: string;
  readonly busy?: boolean;
  /** Independent of `busy` — a form is invalid long before it is running. */
  readonly confirmDisabled?: boolean;
  readonly cancelLabel?: string;
  /** `submit` lets the form's own onSubmit fire, so Enter in a field confirms. */
  readonly confirmType?: "submit" | "button";
  readonly onConfirm?: () => void;
  readonly onCancel: () => void;
};

/**
 * A dialog's Cancel and confirm buttons, in the platform's order.
 *
 * The same job `ConfirmDialog` does for `AlertDialog`, for the ordinary `Dialog` form dialogs that
 * cannot use it. Convention 2's ordering was being hand-written per dialog, which is how it drifts:
 * two copies of a `__DARWIN__` ternary in one file are two chances to get the order backwards.
 *
 * Convention 1 does not apply here. These dialogs have no destructive action, so the affirmative
 * button is the safe one and is allowed to be the default.
 */
export function DialogActions({
  confirmLabel,
  busyLabel,
  busy = false,
  confirmDisabled = false,
  cancelLabel = "Cancel",
  confirmType = "submit",
  onConfirm,
  onCancel,
}: DialogActionsProps) {
  const cancel = (
    <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
      {cancelLabel}
    </Button>
  );
  const confirm = (
    <Button type={confirmType} disabled={busy || confirmDisabled} onClick={onConfirm}>
      {busy && busyLabel !== undefined ? busyLabel : confirmLabel}
    </Button>
  );

  return (
    <DialogFooter>
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
    </DialogFooter>
  );
}
