import { useEffect, useRef } from "react";
import type { ICloneProgress } from "../../../models/progress";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { DialogActions } from "./dialog-actions";
import { DialogMessage } from "./dialog-message";
import { OperationProgressDialog } from "./operation-progress-dialog";
import type { OperationProgressViewModel } from "../../operation-presentation";

const MessageID = "clone-repository-message";

type CloneRepositoryDialogProps = {
  readonly url: string;
  readonly path: string;
  readonly running: boolean;
  /** Present only while a clone is in flight; drives the progress dialog. */
  readonly progress: ICloneProgress | null;
  /** A clone that was attempted and refused, or failed partway. */
  readonly error: string | null;
  readonly operationViewModel?: OperationProgressViewModel;
  readonly onCancelOperation?: () => void;
  readonly onUrlChange: (value: string) => void;
  readonly onPathChange: (value: string) => void;
  readonly onChooseDestination: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/**
 * Clone a repository into a chosen local path.
 *
 * Clone is a **category-1** operation (see `COMPONENT_MIGRATION_PROCESS.md` § Progress
 * presentation): the moment it starts it stops being a form and becomes the shared, undismissable
 * `OperationProgressDialog` ("Cloning in progress"), replacing the form in place. There is no bar
 * embedded in the form — the whole dialog *is* the progress step while the clone runs.
 *
 * There is no account tab bar: rdc has no accounts, so the URL form *is* the whole dialog. A future
 * accounts slice reintroduces the tabs there, not here.
 */
export function CloneRepositoryDialog({
  url,
  path,
  running,
  progress,
  error,
  operationViewModel,
  onCancelOperation,
  onUrlChange,
  onPathChange,
  onChooseDestination,
  onConfirm,
  onCancel,
}: CloneRepositoryDialogProps) {
  const valid = url.trim().length > 0 && path.trim().length > 0;

  // The dialog is opened from a visible toolbar button, so dismissing it must return focus there;
  // that is what the old hand-rolled `Modal` did (capture `previouslyFocused` on mount, restore on
  // unmount). Kept on the outer component so it survives the form→progress swap below.
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previouslyFocused.current?.focus();
    };
  }, []);

  if (running) {
    return (
      <OperationProgressDialog
        viewModel={operationViewModel}
        operation="Cloning"
        progress={progress ?? { value: 0 }}
        currentCommit={undefined}
        onCancel={onCancelOperation}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-[440px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Clone a repository</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              onConfirm();
            }
          }}
        >
          <Label htmlFor="clone-url">Repository URL</Label>
          <Input
            id="clone-url"
            // Clone accepts local paths and SSH-style Git URLs as well as https URLs, so browser
            // URL constraint validation would incorrectly reject valid local bare remotes.
            type="text"
            placeholder="https://github.com/user/repository.git"
            value={url}
            autoFocus
            aria-describedby={MessageID}
            onChange={(event) => onUrlChange(event.currentTarget.value)}
          />

          <Label htmlFor="clone-path">Destination path</Label>
          <div className="grid gap-2 [grid-template-columns:minmax(0,1fr)_auto]">
            <Input
              id="clone-path"
              value={path}
              aria-describedby={MessageID}
              onChange={(event) => onPathChange(event.currentTarget.value)}
            />
            <Button type="button" variant="outline" onClick={onChooseDestination}>
              Browse…
            </Button>
          </div>

          {/* The one message slot (Convention 12): a failure outranks the "what to do" help, and
           * both hold their height so the buttons below never move under the cursor. */}
          {error !== null ? (
            <DialogMessage tone="error" id={MessageID}>
              {error}
            </DialogMessage>
          ) : (
            <DialogMessage id={MessageID}>
              {valid
                ? "Ready to clone into the chosen path."
                : "Enter a repository URL and a destination path to clone."}
            </DialogMessage>
          )}

          <DialogActions
            confirmLabel="Clone"
            busyLabel="Cloning…"
            confirmDisabled={!valid}
            onCancel={onCancel}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
