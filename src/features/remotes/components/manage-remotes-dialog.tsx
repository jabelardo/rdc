import { Plus, Server, Trash2 } from "lucide-react";
import type { IRemote } from "@/models/remote";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Tooltip } from "@/components/tooltip";

type ManageRemotesDialogProps = {
  readonly remotes: ReadonlyArray<IRemote>;
  readonly filter: string;
  /** A remote is being added or removed; the dialog refuses to close and disables its actions. */
  readonly busy: boolean;
  readonly onFilterChange: (value: string) => void;
  readonly onNewRemote: () => void;
  readonly onRemoveRemote: (name: string) => void;
  readonly onDismiss: () => void;
};

/**
 * The repository's remotes, as a list that can grow.
 *
 * **The list is a fixed-height scroll region, not a growing column.** A repository can have any
 * number of remotes, and a dialog that grows with its content changes size as the user adds and
 * removes them. The rows are divided rather than gapped: contiguous rows inside a border read as
 * one list, which is what a scroll boundary needs to look like.
 *
 * **Row actions are icons.** desktop-plus uses an icon-only remove per row, and so does rdc's own
 * changed-files list — the difference here is that this one is always visible rather than revealed
 * on hover. Removing a remote is destructive and rare; an action nobody can find until they move a
 * mouse over the right row is the wrong trade for that, and hover does not exist on touch. Each
 * carries a `Tooltip` and an `aria-label` naming the remote, so "which one am I deleting" is
 * answerable without counting rows.
 */
export function ManageRemotesDialog({
  remotes,
  filter,
  busy,
  onFilterChange,
  onNewRemote,
  onRemoveRemote,
  onDismiss,
}: ManageRemotesDialogProps) {
  const needle = filter.trim().toLowerCase();
  const filtered = remotes.filter(
    (remote) =>
      remote.name.toLowerCase().includes(needle) || remote.url.toLowerCase().includes(needle),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onDismiss();
        }
      }}
    >
      <DialogContent className="sm:max-w-[600px]">
        <DialogTitle>Manage remotes</DialogTitle>
        <div className="mt-4 flex items-center gap-2">
          <input
            type="search"
            className="grow"
            aria-label="Filter remotes"
            placeholder="Filter remotes"
            value={filter}
            disabled={busy}
            onChange={(event) => onFilterChange(event.currentTarget.value)}
          />
          <Tooltip label="Add a remote">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Add a remote"
              disabled={busy}
              onClick={onNewRemote}
            >
              <Plus aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>

        {remotes.length === 0 ? (
          <p className="mt-4">This repository has no remotes.</p>
        ) : filtered.length === 0 ? (
          <p className="mt-4">No remotes match your filter.</p>
        ) : (
          <ul
            className="mt-4 max-h-60 min-h-24 list-none divide-y divide-[var(--border)] overflow-y-auto rounded-[var(--radius-small)] border border-[var(--border)] p-0"
            aria-label="Remotes"
          >
            {filtered.map((remote) => (
              <li key={remote.name} className="flex items-center gap-2 px-2.5 py-2">
                <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                {/*
                 * Both halves truncate, and the name is capped rather than merely `shrink-0`:
                 * `shrink-0` alone gives a long name its full intrinsic width and leaves the URL a
                 * sliver of ellipsis, which is the wrong thing to sacrifice — the URL is what
                 * distinguishes two remotes with similar names. The cap only binds on a name long
                 * enough to need it; ordinary names still size to their content. The tooltip then
                 * carries whatever the row had to cut, the same way the branch picker's rows do.
                 *
                 * `tabIndex` is what makes that tooltip the escape hatch it claims to be. Once a
                 * URL is ellipsised the tooltip is the *only* way to read it, and a bare div takes
                 * no focus — the row's remove button names the remote but not its URL, so without
                 * this a keyboard user simply cannot. It costs a tab stop per row, which is the
                 * right trade for a list whose rows are the dialog's content.
                 */}
                <Tooltip label={`${remote.name}\n${remote.url}`}>
                  <div tabIndex={0} className="flex min-w-0 grow items-center gap-2">
                    <span className="max-w-[45%] shrink-0 truncate font-semibold">
                      {remote.name}
                    </span>
                    <span className="min-w-0 grow truncate text-muted-foreground">
                      {remote.url}
                    </span>
                  </div>
                </Tooltip>
                <Tooltip label={`Remove the "${remote.name}" remote`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove the "${remote.name}" remote`}
                    disabled={busy}
                    onClick={() => onRemoveRemote(remote.name)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button type="button" disabled={busy} onClick={onDismiss}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
