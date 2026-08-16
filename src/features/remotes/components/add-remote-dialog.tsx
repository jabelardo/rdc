import type { IRemote } from "@/models/remote";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { DialogFailure } from "@/components/dialog-kit/dialog-failure";

type AddRemoteDialogProps = {
  readonly name: string;
  readonly url: string;
  /** Existing remotes, so a duplicate name can be refused before the command runs. */
  readonly remotes: ReadonlyArray<IRemote>;
  /** A remote operation is in flight; the dialog refuses to close and disables its actions. */
  readonly busy: boolean;
  readonly error: string | null;
  readonly onNameChange: (value: string) => void;
  readonly onURLChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
};

/**
 * Adds a remote to the repository.
 *
 * Extracted from `app-dialogs.tsx`, where it was written inline. Being a component rather than a
 * branch of a switchboard is what lets it be tested and previewed at all — an inline dialog cannot
 * be rendered from Help → Show Dialog, and cannot be given a failing state without provoking a real
 * failure.
 */
export function AddRemoteDialog({
  name,
  url,
  remotes,
  busy,
  error,
  onNameChange,
  onURLChange,
  onConfirm,
  onDismiss,
}: AddRemoteDialogProps) {
  // Refused before the command runs, because Git's own error for each of these is worse than
  // saying so here: an empty name is a usage dump, and a duplicate is "remote already exists".
  const invalid =
    busy ||
    name.trim() === "" ||
    /\s/.test(name) ||
    url.trim() === "" ||
    remotes.some((remote) => remote.name === name.trim());

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onDismiss();
        }
      }}
    >
      <DialogContent className="w-[min(30rem,calc(100vw-2rem))]">
        <DialogTitle>Add a remote</DialogTitle>
        <DialogFailure error={error} />
        <form
          className="manage-remotes-add mt-4 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <label htmlFor="add-remote-name">Name</label>
          <input
            id="add-remote-name"
            autoFocus
            placeholder="upstream"
            value={name}
            disabled={busy}
            onChange={(event) => onNameChange(event.currentTarget.value)}
          />
          <label htmlFor="add-remote-url">URL</label>
          <input
            id="add-remote-url"
            placeholder="https://github.com/user/repo.git"
            value={url}
            disabled={busy}
            onChange={(event) => onURLChange(event.currentTarget.value)}
          />
          <DialogFooter>
            <button type="button" disabled={busy} onClick={onDismiss}>
              Cancel
            </button>
            <button type="submit" disabled={invalid}>
              {busy ? "Adding…" : "Add remote"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
