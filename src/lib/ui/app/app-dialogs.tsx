import { CircleAlert } from "lucide-react";
import { BranchType, type Branch } from "../../../models/branch";
import type { IRemote } from "../../../models/remote";
import type { Repository } from "../../../models/repository";
import type { WorkingDirectoryFileChange } from "../../../models/status";
import type { BranchState } from "../../stores/branch-store";
import type { CloneState } from "../../stores/clone-store";
import type { PreferencesState, PreferencesStore } from "../../stores/preferences-store";
import { setWindowZoomFactor } from "../../platform/window";
import type { Architecture } from "../../platform/paths";
import type { HookFailureState, WorkingTreeStore } from "../../stores/working-tree-store";
import { Modal } from "../modal";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { ExternalLink } from "../external-link";
import { Checkbox } from "../../../components/ui/checkbox";
import { ConfirmDialog } from "../dialogs/confirm-dialog";
import { ConfirmOptOut } from "../dialogs/confirm-opt-out";
import { DiscardFileList, discardAllQuestion } from "../dialogs/discard-file-list";
import { NoticeDialog } from "../dialogs/notice-dialog";
import { RenameBranchDialog } from "../dialogs/rename-branch-dialog";
import { TerminalOutput } from "../terminal-output";
import { BranchSelect } from "../branch-select";
import { ComputedAction } from "../../../models/computed-action";
import type { MergeTreeResult } from "../../../models/merge";
import { formatNumber } from "../../format-number";

const confirmationDialogClassName =
  "confirmation-dialog box-border w-[min(390px,calc(100vw-26px))] rounded-[var(--radius-medium)] border border-[var(--border)] bg-[var(--popover)] p-6 shadow-[var(--shadow-dialog)]";
const dialogActionsClassName = "confirmation-dialog-actions mt-6 flex justify-end gap-3";

type AppDialogsProps = {
  readonly discardFile: WorkingDirectoryFileChange | null;
  readonly permanentlyDiscard: boolean;
  readonly discardSelection: boolean;
  readonly discardAll: {
    readonly permanent: boolean;
    readonly paths: ReadonlyArray<string>;
  } | null;
  readonly discardOptOut: boolean;
  readonly onDiscardOptOutChange: (value: boolean) => void;
  readonly discarding: boolean;
  readonly workingTreeError: string | null;
  readonly hookFailure: HookFailureState | null;
  readonly workingTreeStore: WorkingTreeStore;
  readonly repositoryToRemove: Repository | null;
  readonly showAboutDialog: boolean;
  readonly appArchitecture: Architecture | null;
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
  readonly mergeStatus: MergeTreeResult | null;
  readonly mergeCommitCount: number;
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
  discardOptOut,
  onDiscardOptOutChange,
  discarding,
  workingTreeError,
  hookFailure,
  workingTreeStore,
  repositoryToRemove,
  showAboutDialog,
  appArchitecture,
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
  mergeStatus,
  mergeCommitCount,
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
        <ConfirmDialog
          title={permanentlyDiscard ? "Permanently discard changes" : "Confirm discard changes"}
          description={
            <>
              Are you sure you want to discard{" "}
              {discardSelection ? "the selected changes to " : "all changes to "}
              <strong className="font-mono [overflow-wrap:anywhere]">{discardFile.path}</strong>?
            </>
          }
          confirmLabel={permanentlyDiscard ? "Permanently discard changes" : "Discard changes"}
          busyLabel="Discarding…"
          busy={discarding}
          error={workingTreeError}
          onConfirm={onConfirmDiscard}
          onCancel={onCancelDiscard}
        >
          <p>
            {discardSelection
              ? "Selected changes cannot be restored from the operating system trash."
              : permanentlyDiscard
                ? "Changes cannot be restored after deletion."
                : "Changes can be restored from the operating system trash."}
          </p>
          {/* Offered only for a whole-file discard: a line-level discard confirms regardless of the
           * preference, so an opt-out here would promise to silence a dialog that would keep
           * appearing. */}
          {!discardSelection && (
            <ConfirmOptOut checked={discardOptOut} onChange={onDiscardOptOutChange} />
          )}
        </ConfirmDialog>
      )}

      {discardAll !== null && (
        <ConfirmDialog
          title={discardAll.permanent ? "Permanently discard all changes" : "Discard all changes"}
          description={discardAllQuestion(discardAll.paths.length)}
          confirmLabel={discardAll.permanent ? "Permanently discard changes" : "Discard changes"}
          busyLabel="Discarding…"
          busy={discarding}
          error={workingTreeError}
          onConfirm={onConfirmDiscardAll}
          onCancel={onCancelDiscardAll}
        >
          <DiscardFileList paths={discardAll.paths} />
          <p>
            {discardAll.permanent
              ? "These changes cannot be recovered."
              : "Untracked files can be recovered from the operating system trash, but changes to tracked files cannot be restored."}
          </p>
          <ConfirmOptOut checked={discardOptOut} onChange={onDiscardOptOutChange} />
        </ConfirmDialog>
      )}

      {branchToRename !== null && (
        <RenameBranchDialog
          branch={branchToRename}
          name={renameName}
          existingNames={branchState.branches
            .filter((branch) => branch.type === BranchType.Local)
            .map((branch) => branch.name)}
          busy={branchState.operation === "renaming"}
          failure={branchState.operationError}
          onNameChange={onRenameNameChange}
          onConfirm={onConfirmRename}
          onCancel={onCancelRename}
        />
      )}

      {deleteRefusal !== null ? (
        <NoticeDialog title="Cannot delete branch" onDismiss={onCancelDelete}>
          {deleteRefusal}
        </NoticeDialog>
      ) : (
        branchToDelete !== null && (
          <ConfirmDialog
            title="Delete branch"
            description={
              <>
                Delete <strong>{branchToDelete.name}</strong>?
                {branchToDelete.upstream !== null &&
                  ` This branch tracks ${branchToDelete.upstream}.`}
              </>
            }
            confirmLabel="Delete branch"
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          >
            {/* A warning about what confirming costs, not a failure, so it takes the warning tokens
             * rather than the error ones. No role="alert" either: it is present when the dialog
             * opens, and the dialog is already announced, so announcing it again as an
             * interruption is wrong. */}
            {deleteUnmerged && (
              <p className="rounded-[var(--radius-small)] border border-[var(--warning-border)] bg-[var(--warning-surface)] px-2.5 py-2 text-[var(--warning-text)]">
                This branch has commits that are not in the current branch. Deleting it will
                permanently remove them.
              </p>
            )}
            {branchToDelete.upstream !== null && (
              <label className="flex w-fit items-center gap-2">
                <Checkbox
                  checked={deletePruneTrackingRef}
                  onCheckedChange={(value) => onDeletePruneChange(value === true)}
                />
                Also remove the local record of the remote branch ({branchToDelete.upstream})
              </label>
            )}
          </ConfirmDialog>
        )
      )}

      {mergePickerOpen && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !mergeRunning) {
              onCancelMerge();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogTitle>
              Merge into <strong>{branchState.currentBranch ?? "—"}</strong>
            </DialogTitle>
            {(() => {
              const candidates = branchState.branches.filter(
                (branch) => branch.name !== branchState.currentBranch,
              );
              if (candidates.length === 0) {
                return (
                  <>
                    <p>There are no other branches to merge.</p>
                    <DialogFooter>
                      <Button type="button" onClick={onCancelMerge}>
                        Close
                      </Button>
                    </DialogFooter>
                  </>
                );
              }
              const selected =
                mergeTarget !== ""
                  ? (candidates.find((b) => b.name === mergeTarget) ?? null)
                  : null;
              return (
                <>
                  <BranchSelect
                    branches={candidates}
                    currentBranch={branchState.currentBranch}
                    defaultBranch={branchState.defaultBranch}
                    recentBranches={branchState.recentBranches}
                    selectedBranch={selected}
                    onSelect={(branch) => onMergeTargetChange(branch.name)}
                  />
                  {/*mergeStatus !== null && mergeTarget !== "" && (
                    <MergePreview
                      status={mergeStatus}
                      commitCount={mergeCommitCount}
                      targetBranch={mergeTarget}
                      currentBranch={branchState.currentBranch ?? "—"}
                    />
                  )*/}
                  {/* mergeMessage !== null && (
                    <p className="application-error" role="alert">
                      {mergeMessage}
                    </p>
                  )*/}
                  <DialogFooter>
                    {__DARWIN__ ? (
                      <>
                        <Button type="button" variant="outline" onClick={onCancelMerge}>
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          disabled={
                            mergeRunning ||
                            mergeTarget === "" ||
                            (mergeStatus?.kind === ComputedAction.Clean &&
                              mergeCommitCount === 0) ||
                            mergeStatus?.kind === ComputedAction.Invalid
                          }
                          onClick={onConfirmMerge}
                        >
                          {mergeRunning ? "Merging…" : "Merge"}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          disabled={
                            mergeRunning ||
                            mergeTarget === "" ||
                            (mergeStatus?.kind === ComputedAction.Clean &&
                              mergeCommitCount === 0) ||
                            mergeStatus?.kind === ComputedAction.Invalid
                          }
                          onClick={onConfirmMerge}
                        >
                          {mergeRunning ? "Merging…" : "Merge"}
                        </Button>
                        <Button type="button" variant="outline" onClick={onCancelMerge}>
                          Cancel
                        </Button>
                      </>
                    )}
                  </DialogFooter>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>
      )}

      {showManageRemotes && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !manageRunning) {
              onCloseManageRemotes();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogTitle>Manage remotes</DialogTitle>
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
                <ul className="manage-remotes-list mt-4 grid list-none gap-[5.2px] p-0">
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
            <DialogFooter>
              <button type="button" disabled={manageRunning} onClick={onCloseManageRemotes}>
                Close
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {showAddRemote && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !manageRunning) {
              onCloseAddRemote();
            }
          }}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogTitle>Add a remote</DialogTitle>
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
              <DialogFooter>
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
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {hookFailure !== null && (
        <AlertDialog open>
          <AlertDialogContent className="sm:max-w-[600px]">
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle className="flex items-center gap-2">
                <CircleAlert className="text-[var(--warning-text)]" aria-hidden />
                The {hookFailure.hook} hook failed
              </AlertDialogTitle>
              <AlertDialogDescription>What would you like to do?</AlertDialogDescription>
            </AlertDialogHeader>
            <TerminalOutput output={hookFailure.terminalOutput} />
            <AlertDialogFooter>
              {__DARWIN__ ? (
                <>
                  <AlertDialogCancel onClick={() => workingTreeStore.resolveHookFailure("abort")}>
                    Abort
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => workingTreeStore.resolveHookFailure("ignore")}
                  >
                    Ignore and Continue
                  </AlertDialogAction>
                </>
              ) : (
                <>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => workingTreeStore.resolveHookFailure("ignore")}
                  >
                    Ignore and Continue
                  </AlertDialogAction>
                  <AlertDialogCancel onClick={() => workingTreeStore.resolveHookFailure("abort")}>
                    Abort
                  </AlertDialogCancel>
                </>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {repositoryToRemove !== null && (
        <ConfirmDialog
          title="Remove repository"
          description={
            <>
              Remove <strong>{repositoryToRemove.name}</strong> from rdc?
            </>
          }
          confirmLabel="Remove repository"
          onConfirm={onConfirmRemoveRepository}
          onCancel={onCancelRemoveRepository}
        >
          <p>Files in the repository will not be deleted.</p>
        </ConfirmDialog>
      )}

      {showAboutDialog && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              onDismissAbout();
            }
          }}
        >
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle>About RDC</DialogTitle>
              <DialogDescription>A native Git client built with Tauri and Rust.</DialogDescription>
            </DialogHeader>
            <p className="select-text">
              Version {__APP_VERSION__}
              {appArchitecture === null ? "" : ` (${appArchitecture})`}
            </p>
            <p className="flex flex-col gap-1">
              <ExternalLink href="https://github.com/jabelardo/rdc">rdc on GitHub</ExternalLink>
              <ExternalLink href="https://github.com/jabelardo/rdc/blob/main/LICENSE">
                MIT License
              </ExternalLink>
            </p>
            <DialogFooter>
              <Button onClick={onDismissAbout}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
              <div className="clone-progress grid gap-[4.55px]" role="status">
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

type MergePreviewProps = {
  readonly status: MergeTreeResult;
  readonly commitCount: number;
  readonly targetBranch: string;
  readonly currentBranch: string;
};

function MergePreview({ status, commitCount, targetBranch, currentBranch }: MergePreviewProps) {
  if (status.kind === ComputedAction.Loading) {
    return (
      <p className="text-sm text-muted-foreground">Checking for ability to merge automatically…</p>
    );
  }

  if (status.kind === ComputedAction.Invalid) {
    return (
      <p className="text-sm text-muted-foreground">
        Unable to merge unrelated histories in this repository.
      </p>
    );
  }

  if (status.kind === ComputedAction.Clean) {
    if (commitCount === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          <strong>{currentBranch}</strong> is already up to date with{" "}
          <strong>{targetBranch}</strong>.
        </p>
      );
    }
    const pluralized = commitCount === 1 ? "commit" : "commits";
    return (
      <p className="text-sm text-muted-foreground">
        This will merge{" "}
        <strong>
          {formatNumber(commitCount)} {pluralized}
        </strong>{" "}
        from <strong>{targetBranch}</strong> into <strong>{currentBranch}</strong>.
      </p>
    );
  }

  // Conflicts
  const pluralized = status.conflictedFiles === 1 ? "file" : "files";
  return (
    <p className="text-sm text-[var(--warning-text)]">
      There will be{" "}
      <strong>
        {formatNumber(status.conflictedFiles)} conflicted {pluralized}
      </strong>{" "}
      when merging <strong>{targetBranch}</strong> into <strong>{currentBranch}</strong>.
    </p>
  );
}
