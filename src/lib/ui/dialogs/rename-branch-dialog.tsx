import type { Branch } from "../../../models/branch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { validateBranchName } from "../../validate-branch-name";
import { DialogActions } from "./dialog-actions";
import { DialogMessage, type DialogMessageTone } from "./dialog-message";

const MessageID = "rename-branch-message";

type RenameBranchDialogProps = {
  readonly branch: Branch;
  readonly name: string;
  /** Local branch names, for catching a collision before git does. */
  readonly existingNames: ReadonlyArray<string>;
  readonly busy: boolean;
  /** A rename that was attempted and refused. */
  readonly failure: string | null;
  readonly onNameChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

export function RenameBranchDialog({
  branch,
  name,
  existingNames,
  busy,
  failure,
  onNameChange,
  onConfirm,
  onCancel,
}: RenameBranchDialogProps) {
  const validation = validateBranchName(name, {
    currentName: branch.name,
    // The branch's own name is not a collision with itself; `unchanged` already covers that case.
    existingNames: existingNames.filter((existing) => existing !== branch.name),
  });

  // One slot, so the most urgent thing wins. A failed attempt outranks a rule the user is still
  // typing their way past, and both outrank the tracking note, which is context rather than news.
  let tone: DialogMessageTone = "info";
  let message: string | null = null;
  if (failure !== null) {
    tone = "error";
    message = failure;
  } else if (validation.kind === "invalid") {
    tone = "error";
    message = validation.message;
  } else if (branch.upstream !== null) {
    tone = "warning";
    message = `This branch tracks ${branch.upstream}. Only the local branch is renamed; the remote keeps its current name.`;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onCancel();
        }
      }}
    >
      {/* No separate description: the title and the field's own label say what this is, and the
       * input points at the message slot instead, so a validation failure is announced against the
       * field it belongs to rather than as a property of the whole dialog. */}
      <DialogContent className="sm:max-w-[420px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Rename branch</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (validation.kind === "valid" && !busy) {
              onConfirm();
            }
          }}
        >
          <Label htmlFor="rename-branch-name">
            New name for <strong>{branch.name}</strong>
          </Label>
          <Input
            id="rename-branch-name"
            value={name}
            autoFocus
            disabled={busy}
            aria-describedby={MessageID}
            aria-invalid={validation.kind === "invalid"}
            onChange={(event) => onNameChange(event.currentTarget.value)}
            // Selected on open so typing replaces the old name, which is the common intent, while
            // the existing name stays visible and editable for a small correction.
            onFocus={(event) => event.currentTarget.select()}
          />
          <DialogMessage tone={tone} id={MessageID}>
            {message}
          </DialogMessage>
          <DialogActions
            confirmLabel="Rename"
            busyLabel="Renaming…"
            busy={busy}
            confirmDisabled={validation.kind !== "valid"}
            onCancel={onCancel}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
