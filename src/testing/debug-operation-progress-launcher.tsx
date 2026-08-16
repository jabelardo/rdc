import { useState } from "react";
import type { GitOperationKind, OperationPresentationRole } from "@/models/operation";
import {
  OperationPreviewLabel,
  OperationPreviewStates,
  type OperationPreviewState,
} from "@/testing/operation-progress-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const operations: ReadonlyArray<GitOperationKind> = [
  "fetch",
  "push",
  "pull",
  "clone",
  "commit",
  "merge",
  "rebase",
  "cherryPick",
  "revert",
  "checkout",
];

const roles: ReadonlyArray<OperationPresentationRole> = ["owner", "observer", "unowned"];

type DebugOperationProgressLauncherProps = {
  readonly onShow: (
    state: OperationPreviewState,
    operation: GitOperationKind,
    role: OperationPresentationRole,
  ) => void;
  readonly onDismiss: () => void;
};

/**
 * Debug-only chooser for `OperationProgressDialog`'s lifecycle states.
 *
 * **The selector lives here, not in the dialog under test.** Slice 16 gave the progress dialog
 * roughly a dozen states across three presentation roles, and most cannot be reached by hand in
 * any reasonable time — a hard timeout is two minutes of inactivity, a recovery failure needs Git
 * to fail *while* recovering. Previewing them one menu item each would bury the Show Dialog
 * submenu; putting a picker inside the dialog would mean reviewing a component that does not ship.
 * So this is a separate parent: choose, press Show, and the genuine dialog appears with nothing
 * added to it.
 */
export function DebugOperationProgressLauncher({
  onShow,
  onDismiss,
}: DebugOperationProgressLauncherProps) {
  const [state, setState] = useState<OperationPreviewState>("running");
  const [operation, setOperation] = useState<GitOperationKind>("fetch");
  const [role, setRole] = useState<OperationPresentationRole>("owner");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Operation progress preview</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
          <label htmlFor="debug-progress-state">State</label>
          <select
            id="debug-progress-state"
            value={state}
            onChange={(event) => setState(event.currentTarget.value as OperationPreviewState)}
          >
            {OperationPreviewStates.map((value) => (
              <option key={value} value={value}>
                {OperationPreviewLabel[value]}
              </option>
            ))}
          </select>

          <label htmlFor="debug-progress-operation">Operation</label>
          <select
            id="debug-progress-operation"
            value={operation}
            onChange={(event) => setOperation(event.currentTarget.value as GitOperationKind)}
          >
            {operations.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label htmlFor="debug-progress-role">Role</label>
          <select
            id="debug-progress-role"
            value={role}
            onChange={(event) => setRole(event.currentTarget.value as OperationPresentationRole)}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onShow(state, operation, role)}>
            Show
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
