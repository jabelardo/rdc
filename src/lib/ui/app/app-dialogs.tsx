import { BranchType, type Branch } from "../../../models/branch";
import type { IRemote } from "../../../models/remote";
import type { Repository } from "../../../models/repository";
import type { WorkingDirectoryFileChange } from "../../../models/status";
import type { BranchState } from "../../stores/branch-store";
import type { CloneState } from "../../stores/clone-store";
import type { PreferencesState, PreferencesStore } from "../../stores/preferences-store";
import { setWindowZoomFactor } from "../../platform/window";
import type { HookFailureState, WorkingTreeStore } from "../../stores/working-tree-store";
import { Modal } from "../modal";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";

const confirmationDialogClassName =
  "confirmation-dialog box-border w-[min(30rem,calc(100vw-2rem))] rounded-[var(--radius-medium)] border border-[var(--border)] bg-[var(--popover)] p-6 shadow-[var(--shadow-dialog)]";
const dialogActionsClassName = "confirmation-dialog-actions mt-6 flex justify-end gap-3";

type AppDialogsProps = {
  readonly discardFile: WorkingDirectoryFileChange | null;
  readonly permanentlyDiscard: boolean;
  readonly discardSelection: boolean;
  readonly discardAll: {
    readonly permanent: boolean;
    readonly fileCount: number;
  } | null;
  readonly discarding: boolean;
  readonly workingTreeError: string | null;
  readonly hookFailure: HookFailureState | null;
  readonly workingTreeStore: WorkingTreeStore;
  readonly repositoryToRemove: Repository | null;
  readonly showAboutDialog: boolean;
  readonly showPreferencesDialog: boolean;
  readonly preferencesState: PreferencesState;
  readonly preferencesStore: PreferencesStore;
  readonly showCloneDialog: boolean;
  readonly cloneState: CloneState;
  readonly cloneURL: string;
  readonly clonePath: string;
  readonly onCancelDiscard: () => void;
  readonly onConfirmDiscard: () => void;
  readonly onCancelDiscardAll: () => void;
  readonly onConfirmDiscardAll: () => void;
  readonly onCancelRemoveRepository: () => void;
  readonly onConfirmRemoveRepository: () => void;
  readonly branchToRename: Branch | null;
  readonly renameName: string;
  readonly onRenameNameChange: (value: string) => void;
  readonly onConfirmRename: () => void;
  readonly onCancelRename: () => void;
  readonly branchToDelete: Branch | null;
  readonly deleteRefusal: string | null;
  readonly deleteUnmerged: boolean;
  readonly deletePruneTrackingRef: boolean;
  readonly onDeletePruneChange: (value: boolean) => void;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly branchState: BranchState;
  readonly mergePickerOpen: boolean;
  readonly mergeTarget: string;
  readonly onMergeTargetChange: (value: string) => void;
  readonly mergeMessage: string | null;
  readonly mergeRunning: boolean;
  readonly onConfirmMerge: () => void;
  readonly onCancelMerge: () => void;
  readonly showManageRemotes: boolean;
  readonly remotes: ReadonlyArray<IRemote>;
  readonly remoteFilter: string;
  readonly onRemoteFilterChange: (value: string) => void;
  readonly showAddRemote: boolean;
  readonly addRemoteName: string;
  readonly onAddRemoteNameChange: (value: string) => void;
  readonly addRemoteURL: string;
  readonly onAddRemoteURLChange: (value: string) => void;
  readonly manageRemoteError: string | null;
  readonly manageRunning: boolean;
  readonly onNewRemote: () => void;
  readonly onConfirmAddRemote: () => void;
  readonly onConfirmRemoveRemote: (name: string) => void;
  readonly onCloseAddRemote: () => void;
  readonly onCloseManageRemotes: () => void;
  readonly onDismissAbout: () => void;
  readonly onDismissPreferences: () => void;
  readonly onDismissClone: () => void;
  readonly onChooseCloneDestination: () => void;
  readonly onSubmitClone: () => void;
  readonly onCloneURLChange: (value: string) => void;
  readonly onClonePathChange: (value: string) => void;
};

/**
 * The application's modal layer.
 *
 * Keeping these workflows together is intentional: only one can be actionable at a time, they
 * share focus restoration through `Modal`, and none participates in the repository workspace's
 * layout. Extracting them prevents modal state changes from obscuring the main shell structure.
 */
export function AppDialogs({
  discardFile,
  permanentlyDiscard,
  discardSelection,
  discardAll,
  discarding,
  workingTreeError,
  hookFailure,
  workingTreeStore,
  repositoryToRemove,
  showAboutDialog,
  showPreferencesDialog,
  preferencesState,
  preferencesStore,
  showCloneDialog,
  cloneState,
  cloneURL,
  clonePath,
  onCancelDiscard,
  onConfirmDiscard,
  onCancelDiscardAll,
  onConfirmDiscardAll,
  onCancelRemoveRepository,
  onConfirmRemoveRepository,
  branchToRename,
  renameName,
  onRenameNameChange,
  onConfirmRename,
  onCancelRename,
  branchToDelete,
  deleteRefusal,
  deleteUnmerged,
  deletePruneTrackingRef,
  onDeletePruneChange,
  onConfirmDelete,
  onCancelDelete,
  branchState,
  mergePickerOpen,
  mergeTarget,
  onMergeTargetChange,
  mergeMessage,
  mergeRunning,
  onConfirmMerge,
  onCancelMerge,
  showManageRemotes,
  remotes,
  remoteFilter,
  onRemoteFilterChange,
  showAddRemote,
  addRemoteName,
  onAddRemoteNameChange,
  addRemoteURL,
  onAddRemoteURLChange,
  manageRemoteError,
  manageRunning,
  onNewRemote,
  onConfirmAddRemote,
  onConfirmRemoveRemote,
  onCloseAddRemote,
  onCloseManageRemotes,
  onDismissAbout,
  onDismissPreferences,
  onDismissClone,
  onChooseCloneDestination,
  onSubmitClone,
  onCloneURLChange,
  onClonePathChange,
}: AppDialogsProps) {
  return (
    <>
      {discardFile !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="discard-dialog-title"
          aria-describedby="discard-dialog-message"
          onDismiss={discarding ? undefined : onCancelDiscard}
        >
          <h2 id="discard-dialog-title">
            {permanentlyDiscard ? "Permanently discard changes" : "Confirm discard changes"}
          </h2>
          <p>
            Are you sure you want to discard{" "}
            {discardSelection ? "the selected changes to " : "all changes to "}
            <strong>{discardFile.path}</strong>?
          </p>
          <p id="discard-dialog-message">
            {discardSelection
              ? "Selected changes cannot be restored from the operating system trash."
              : permanentlyDiscard
                ? "Changes cannot be restored after deletion."
                : "Changes can be restored from the operating system trash."}
          </p>
          {workingTreeError !== null && (
            <p className="application-error" role="alert">
              {workingTreeError}
            </p>
          )}
          <div className={dialogActionsClassName}>
            <button type="button" disabled={discarding} onClick={onCancelDiscard}>
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              disabled={discarding}
              onClick={onConfirmDiscard}
            >
              {discarding
                ? "Discarding…"
                : permanentlyDiscard
                  ? "Permanently discard changes"
                  : "Discard changes"}
            </button>
          </div>
        </Modal>
      )}

      {discardAll !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="discard-all-dialog-title"
          aria-describedby="discard-all-dialog-message"
          onDismiss={discarding ? undefined : onCancelDiscardAll}
        >
          <h2 id="discard-all-dialog-title">
            {discardAll.permanent ? "Permanently discard all changes" : "Discard all changes"}
          </h2>
          <p>
            This will {discardAll.permanent ? "permanently " : ""}discard changes to{" "}
            <strong>
              {discardAll.fileCount} {discardAll.fileCount === 1 ? "file" : "files"}
            </strong>
            .
          </p>
          <p id="discard-all-dialog-message">
            {discardAll.permanent
              ? "These changes cannot be recovered."
              : "Untracked files can be recovered from the operating system trash, but changes to tracked files cannot be restored."}
          </p>
          {workingTreeError !== null && (
            <p className="application-error" role="alert">
              {workingTreeError}
            </p>
          )}
          <div className={dialogActionsClassName}>
            <button type="button" disabled={discarding} onClick={onCancelDiscardAll}>
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              disabled={discarding}
              onClick={onConfirmDiscardAll}
            >
              {discarding
                ? "Discarding…"
                : discardAll.permanent
                  ? "Permanently discard changes"
                  : "Discard changes"}
            </button>
          </div>
        </Modal>
      )}

      {branchToRename !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="dialog"
          aria-labelledby="rename-branch-title"
          onDismiss={onCancelRename}
        >
          <h2 id="rename-branch-title">Rename branch</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onConfirmRename();
            }}
          >
            <label htmlFor="rename-branch-name">
              New name for <strong>{branchToRename.name}</strong>
            </label>
            <input
              id="rename-branch-name"
              value={renameName}
              autoFocus
              onChange={(event) => onRenameNameChange(event.currentTarget.value)}
            />
            {branchToRename.upstream !== null && (
              <p>
                This branch tracks <strong>{branchToRename.upstream}</strong>. Only the local branch
                is renamed; the remote branch keeps its current name.
              </p>
            )}
            <div className={dialogActionsClassName}>
              <button type="button" onClick={onCancelRename}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  renameName.trim().length === 0 || renameName.trim() === branchToRename.name
                }
              >
                Rename
              </button>
            </div>
          </form>
        </Modal>
      )}

      {(branchToDelete !== null || deleteRefusal !== null) && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="delete-branch-title"
          onDismiss={onCancelDelete}
        >
          {deleteRefusal !== null ? (
            <>
              <h2 id="delete-branch-title">Cannot delete branch</h2>
              <p>{deleteRefusal}</p>
              <div className={dialogActionsClassName}>
                <button type="button" onClick={onCancelDelete}>
                  Close
                </button>
              </div>
            </>
          ) : (
            branchToDelete !== null && (
              <>
                <h2 id="delete-branch-title">Delete branch</h2>
                <p>
                  Delete <strong>{branchToDelete.name}</strong>?
                  {branchToDelete.upstream !== null &&
                    ` This branch tracks ${branchToDelete.upstream}.`}
                </p>
                {deleteUnmerged && (
                  <p className="application-error" role="alert">
                    This branch has commits that are not in the current branch. Deleting it will
                    permanently remove them.
                  </p>
                )}
                {branchToDelete.upstream !== null && (
                  <label>
                    <input
                      type="checkbox"
                      checked={deletePruneTrackingRef}
                      onChange={(event) => onDeletePruneChange(event.currentTarget.checked)}
                    />
                    Also remove the local record of the remote branch ({branchToDelete.upstream})
                  </label>
                )}
                <div className={dialogActionsClassName}>
                  <button type="button" onClick={onCancelDelete}>
                    Cancel
                  </button>
                  <button type="button" className="destructive-button" onClick={onConfirmDelete}>
                    Delete branch
                  </button>
                </div>
              </>
            )
          )}
        </Modal>
      )}

      {mergePickerOpen && (
        <Modal
          className={confirmationDialogClassName}
          role="dialog"
          aria-labelledby="merge-dialog-title"
          onDismiss={mergeRunning ? undefined : onCancelMerge}
        >
          <h2 id="merge-dialog-title">
            Merge into current branch ({branchState.currentBranch ?? "—"})
          </h2>
          {(() => {
            const candidates = branchState.branches.filter(
              (branch) =>
                branch.type === BranchType.Local && branch.name !== branchState.currentBranch,
            );
            if (candidates.length === 0) {
              return (
                <>
                  <p>There are no other branches to merge.</p>
                  <div className={dialogActionsClassName}>
                    <button type="button" onClick={onCancelMerge}>
                      Close
                    </button>
                  </div>
                </>
              );
            }
            return (
              <>
                <label htmlFor="merge-target-branch">Branch to merge</label>
                <select
                  id="merge-target-branch"
                  value={mergeTarget}
                  disabled={mergeRunning}
                  onChange={(event) => onMergeTargetChange(event.currentTarget.value)}
                >
                  {candidates.map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
                </select>
                {mergeMessage !== null && (
                  <p className="application-error" role="alert">
                    {mergeMessage}
                  </p>
                )}
                <div className={dialogActionsClassName}>
                  <button
                    type="button"
                    disabled={mergeRunning || mergeTarget === ""}
                    onClick={onCancelMerge}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={mergeRunning || mergeTarget === ""}
                    onClick={onConfirmMerge}
                  >
                    {mergeRunning ? "Merging…" : "Merge"}
                  </button>
                </div>
              </>
            );
          })()}
        </Modal>
      )}

      {showManageRemotes && (
        <Modal
          className={`${confirmationDialogClassName} manage-remotes-dialog`}
          role="dialog"
          aria-labelledby="manage-remotes-title"
          onDismiss={manageRunning ? undefined : onCloseManageRemotes}
        >
          <h2 id="manage-remotes-title">Manage remotes</h2>
          <div className="manage-remotes-toolbar mt-4 flex items-center gap-2">
            <input
              type="search"
              className="grow"
              aria-label="Filter remotes"
              placeholder="Filter remotes"
              value={remoteFilter}
              disabled={manageRunning}
              onChange={(event) => onRemoteFilterChange(event.currentTarget.value)}
            />
            <button type="button" disabled={manageRunning} onClick={onNewRemote}>
              New remote
            </button>
          </div>
          {(() => {
            const filter = remoteFilter.trim().toLowerCase();
            const filtered = remotes.filter(
              (remote) =>
                remote.name.toLowerCase().includes(filter) ||
                remote.url.toLowerCase().includes(filter),
            );
            if (remotes.length === 0) {
              return <p className="manage-remotes-empty mt-4">This repository has no remotes.</p>;
            }
            if (filtered.length === 0) {
              return <p className="manage-remotes-empty mt-4">No remotes match your filter.</p>;
            }
            return (
              <ul className="manage-remotes-list mt-4 grid list-none gap-[0.4rem] p-0">
                {filtered.map((remote) => (
                  <li
                    key={remote.name}
                    className="grid items-center gap-3 [grid-template-columns:minmax(0,1fr)_auto]"
                  >
                    <span className="min-w-0">
                      <strong>{remote.name}</strong>{" "}
                      <small className="break-all">{remote.url}</small>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove the "${remote.name}" remote`}
                      disabled={manageRunning}
                      onClick={() => onConfirmRemoveRemote(remote.name)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            );
          })()}
          <div className={dialogActionsClassName}>
            <button type="button" disabled={manageRunning} onClick={onCloseManageRemotes}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {showAddRemote && (
        <Modal
          className={confirmationDialogClassName}
          role="dialog"
          aria-labelledby="add-remote-title"
          onDismiss={manageRunning ? undefined : onCloseAddRemote}
        >
          <h2 id="add-remote-title">Add a remote</h2>
          {manageRemoteError !== null && (
            <p className="application-error" role="alert">
              {manageRemoteError}
            </p>
          )}
          <form
            className="manage-remotes-add mt-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onConfirmAddRemote();
            }}
          >
            <label htmlFor="add-remote-name">Name</label>
            <input
              id="add-remote-name"
              autoFocus
              placeholder="upstream"
              value={addRemoteName}
              disabled={manageRunning}
              onChange={(event) => onAddRemoteNameChange(event.currentTarget.value)}
            />
            <label htmlFor="add-remote-url">URL</label>
            <input
              id="add-remote-url"
              placeholder="https://github.com/user/repo.git"
              value={addRemoteURL}
              disabled={manageRunning}
              onChange={(event) => onAddRemoteURLChange(event.currentTarget.value)}
            />
            <div className={dialogActionsClassName}>
              <button type="button" disabled={manageRunning} onClick={onCloseAddRemote}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  manageRunning ||
                  addRemoteName.trim() === "" ||
                  /\s/.test(addRemoteName) ||
                  addRemoteURL.trim() === "" ||
                  remotes.some((remote) => remote.name === addRemoteName.trim())
                }
              >
                {manageRunning ? "Adding…" : "Add remote"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {hookFailure !== null && (
        <AlertDialog open>
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle>Git hook failed</AlertDialogTitle>
              <AlertDialogDescription>
                The <strong>{hookFailure.hook}</strong> hook failed. Abort the commit, or ignore
                this failure and continue?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <pre className="commit-terminal-output">{hookFailure.terminalOutput}</pre>
            <AlertDialogFooter>
              <button type="button" onClick={() => workingTreeStore.resolveHookFailure("abort")}>
                Abort commit
              </button>
              <button type="button" onClick={() => workingTreeStore.resolveHookFailure("ignore")}>
                Ignore hook failure
              </button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {repositoryToRemove !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="remove-repository-title"
          aria-describedby="remove-repository-message"
          onDismiss={onCancelRemoveRepository}
        >
          <h2 id="remove-repository-title">Remove repository</h2>
          <p id="remove-repository-message">
            Remove <strong>{repositoryToRemove.name}</strong> from rdc? Files in the repository will
            not be deleted.
          </p>
          <div className={dialogActionsClassName}>
            <button type="button" onClick={onCancelRemoveRepository}>
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              onClick={onConfirmRemoveRepository}
            >
              Remove repository
            </button>
          </div>
        </Modal>
      )}

      {showAboutDialog && (
        <Modal
          className={`${confirmationDialogClassName} about-dialog`}
          aria-labelledby="about-dialog-title"
          onDismiss={onDismissAbout}
        >
          <h2 id="about-dialog-title">About RDC</h2>
          <p>Version {__APP_VERSION__}</p>
          <p>A native Git client built with Tauri and Rust.</p>
          <div className={dialogActionsClassName}>
            <button type="button" onClick={onDismissAbout}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {showPreferencesDialog && (
        <Modal
          className={`${confirmationDialogClassName} preferences-dialog`}
          aria-labelledby="preferences-dialog-title"
          onDismiss={onDismissPreferences}
        >
          <h2 id="preferences-dialog-title">Preferences</h2>
          <div className="preferences-fields grid items-center gap-x-4 gap-y-3">
            <label htmlFor="theme-preference">Theme</label>
            <select
              id="theme-preference"
              value={preferencesState.theme}
              onChange={(event) =>
                void preferencesStore.setTheme(
                  event.currentTarget.value as PreferencesState["theme"],
                )
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>

            <label>Zoom</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const next = Math.max(0.5, preferencesState.zoomFactor - 0.05);
                  preferencesStore.setZoomFactor(next);
                  void setWindowZoomFactor(next);
                }}
                disabled={preferencesState.zoomFactor <= 0.5}
                aria-label="Decrease zoom"
              >
                −
              </button>
              <span aria-live="polite">{Math.round(preferencesState.zoomFactor * 100)}%</span>
              <button
                type="button"
                onClick={() => {
                  const next = Math.min(2.0, preferencesState.zoomFactor + 0.05);
                  preferencesStore.setZoomFactor(next);
                  void setWindowZoomFactor(next);
                }}
                disabled={preferencesState.zoomFactor >= 2.0}
                aria-label="Increase zoom"
              >
                +
              </button>
            </div>

            <label htmlFor="editor-preference">External editor</label>
            <select
              id="editor-preference"
              value={preferencesState.selectedExternalEditor ?? ""}
              disabled={preferencesState.loading}
              onChange={(event) =>
                preferencesStore.setSelectedExternalEditor(event.currentTarget.value || null)
              }
            >
              {preferencesState.editors.length === 0 && (
                <option value="">No supported editor found</option>
              )}
              {preferencesState.editors.map((editor) => (
                <option key={editor.editor} value={editor.editor}>
                  {editor.editor}
                </option>
              ))}
            </select>

            <label htmlFor="shell-preference">Shell</label>
            <select
              id="shell-preference"
              value={preferencesState.selectedShell ?? ""}
              disabled={preferencesState.loading}
              onChange={(event) =>
                preferencesStore.setSelectedShell(
                  (event.currentTarget.value || null) as PreferencesState["selectedShell"],
                )
              }
            >
              {preferencesState.shells.length === 0 && (
                <option value="">No supported shell found</option>
              )}
              {preferencesState.shells.map((shell) => (
                <option key={shell.shell} value={shell.shell}>
                  {shell.shell}
                </option>
              ))}
            </select>

            <fieldset>
              <legend>Confirm before</legend>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmRepositoryRemoval}
                  onChange={(event) =>
                    preferencesStore.setConfirmRepositoryRemoval(event.currentTarget.checked)
                  }
                />
                Removing a repository from rdc
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmDiscardChanges}
                  onChange={(event) =>
                    preferencesStore.setConfirmDiscardChanges(event.currentTarget.checked)
                  }
                />
                Discarding file changes
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmDiscardChangesPermanently}
                  onChange={(event) =>
                    preferencesStore.setConfirmDiscardChangesPermanently(
                      event.currentTarget.checked,
                    )
                  }
                />
                Permanently discarding changes when trash fails
              </label>
            </fieldset>
          </div>
          {preferencesState.error !== null && (
            <p className="application-error" role="alert">
              {preferencesState.error}
            </p>
          )}
          <div className={dialogActionsClassName}>
            <button type="button" onClick={onDismissPreferences}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {showCloneDialog && (
        <Modal
          className={`${confirmationDialogClassName} clone-dialog`}
          aria-labelledby="clone-dialog-title"
          onDismiss={cloneState.operation === null ? onDismissClone : undefined}
        >
          <h2 id="clone-dialog-title">Clone a repository</h2>
          <form
            aria-busy={cloneState.operation !== null}
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitClone();
            }}
          >
            <label htmlFor="clone-url">Repository URL</label>
            <input
              id="clone-url"
              value={cloneURL}
              disabled={cloneState.operation !== null}
              onChange={(event) => onCloneURLChange(event.currentTarget.value)}
            />
            <label htmlFor="clone-path">Destination path</label>
            <div className="clone-path grid gap-2 [grid-template-columns:minmax(0,1fr)_auto]">
              <input
                id="clone-path"
                value={clonePath}
                disabled={cloneState.operation !== null}
                onChange={(event) => onClonePathChange(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={cloneState.operation !== null}
                onClick={onChooseCloneDestination}
              >
                Browse…
              </button>
            </div>
            {cloneState.progress !== null && (
              <div className="clone-progress grid gap-[0.35rem]" role="status">
                <progress value={cloneState.progress.value} max={1} />
                <span>
                  {cloneState.progress.description ?? cloneState.progress.title ?? "Cloning…"}
                </span>
              </div>
            )}
            {cloneState.error !== null && (
              <p className="application-error" role="alert">
                {cloneState.error}
              </p>
            )}
            <div className={dialogActionsClassName}>
              <button
                type="button"
                disabled={cloneState.operation !== null}
                onClick={onDismissClone}
              >
                Cancel
              </button>
              <button type="submit" disabled={cloneState.operation !== null}>
                {cloneState.operation === "clone" ? "Cloning…" : "Clone"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
