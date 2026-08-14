import { CircleAlert } from "lucide-react";
import { BranchType, type Branch } from "../../../models/branch";
import type { IRemote } from "../../../models/remote";
import type { Repository } from "../../../models/repository";
import type { WorkingDirectoryFileChange } from "../../../models/status";
import type { BranchState } from "../../stores/branch-store";
import type { CloneState } from "../../stores/clone-store";
import type { PreferencesState, PreferencesStore } from "../../stores/preferences-store";
import type { Architecture } from "../../platform/paths";
import type {
  HookFailureState,
  RunningHookState,
  WorkingTreeStore,
} from "../../stores/working-tree-store";
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
import { CloneRepositoryDialog } from "../dialogs/clone-repository-dialog";
import { DiscardFileList, discardAllQuestion } from "../dialogs/discard-file-list";
import { MergeBranchDialog, mergeCandidates } from "../dialogs/merge-branch-dialog";
import { RebaseBranchDialog, rebaseCandidates } from "../dialogs/rebase-branch-dialog";
import { NoticeDialog } from "../dialogs/notice-dialog";
import { RenameBranchDialog } from "../dialogs/rename-branch-dialog";
import { OperationProgressDialog } from "../dialogs/operation-progress-dialog";
import { PreferencesDialog } from "../dialogs/preferences-dialog";
import { TerminalOutput } from "../terminal-output";
import type { MergeTreeResult } from "../../../models/merge";
import type { MergeStrategy } from "../../../models/merge-strategy";
import type { RebasePreview } from "../../../models/rebase-preview";
import type { OperationProgressViewModel } from "../../operation-presentation";

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
  readonly runningHook: RunningHookState | null;
  readonly commitLoading: boolean;
  readonly commitTerminalOutput: string;
  readonly operationViewModel: OperationProgressViewModel | undefined;
  readonly onCancelOperation: () => void;
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
  readonly mergeProgress: Extract<BranchState["progress"], { kind: "generic" }> | null;
  readonly mergeStrategy: MergeStrategy;
  readonly onMergeStrategyChange: (strategy: MergeStrategy) => void;
  readonly mergePreviewError: string | null;
  readonly mergedBranches: ReadonlyMap<string, string>;
  readonly onConfirmMerge: () => void;
  readonly onCancelMerge: () => void;
  readonly rebasePickerOpen: boolean;
  readonly rebaseTarget: string;
  readonly onRebaseTargetChange: (value: string) => void;
  readonly rebaseMessage: string | null;
  readonly rebaseRunning: boolean;
  readonly rebaseProgress: Extract<
    BranchState["progress"],
    { kind: "multiCommitOperation" }
  > | null;
  readonly rebasePreview: RebasePreview | null;
  readonly rebasePreviewError: string | null;
  readonly onConfirmRebase: () => void;
  readonly onCancelRebase: () => void;
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
 * own focus restoration through their dialog primitives, and none participates in the repository
 * workspace's layout. Extracting them prevents modal state changes from obscuring the main shell
 * structure.
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
  runningHook,
  commitLoading,
  commitTerminalOutput,
  operationViewModel,
  onCancelOperation,
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
  mergeProgress,
  mergeStrategy,
  onMergeStrategyChange,
  mergePreviewError,
  mergedBranches,
  onConfirmMerge,
  onCancelMerge,
  rebasePickerOpen,
  rebaseTarget,
  onRebaseTargetChange,
  rebaseMessage,
  rebaseRunning,
  rebaseProgress,
  rebasePreview,
  rebasePreviewError,
  onConfirmRebase,
  onCancelRebase,
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
      {commitLoading && hookFailure === null && (
        <OperationProgressDialog
          viewModel={operationViewModel?.operation === "commit" ? operationViewModel : undefined}
          operation="Committing"
          progress={{ value: 0, title: "Committing changes" }}
          onCancel={onCancelOperation}
        >
          {runningHook != null && (
            <button type="button" onClick={() => void workingTreeStore.stopHook()}>
              Stop {runningHook.hook} hook
            </button>
          )}
          {commitTerminalOutput.length > 0 && (
            <TerminalOutput output={commitTerminalOutput} aria-label="Commit terminal output" />
          )}
        </OperationProgressDialog>
      )}

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
        <MergeBranchDialog
          currentBranch={branchState.currentBranch ?? "—"}
          candidates={mergeCandidates(
            branchState.branches,
            branchState.currentBranch,
            mergedBranches,
          )}
          defaultBranch={branchState.defaultBranch}
          recentBranches={branchState.recentBranches}
          selected={branchState.branches.find((branch) => branch.name === mergeTarget) ?? null}
          strategy={mergeStrategy}
          status={mergeStatus}
          commitCount={mergeCommitCount}
          running={mergeRunning}
          progress={mergeProgress}
          failure={mergeMessage ?? mergePreviewError}
          onSelect={(branch) => onMergeTargetChange(branch.name)}
          onStrategyChange={onMergeStrategyChange}
          onConfirm={onConfirmMerge}
          onCancel={onCancelMerge}
          operationViewModel={
            operationViewModel?.operation === "merge" ? operationViewModel : undefined
          }
          onCancelOperation={onCancelOperation}
        />
      )}

      {rebasePickerOpen && (
        <RebaseBranchDialog
          currentBranch={branchState.currentBranch ?? "—"}
          candidates={rebaseCandidates(branchState.branches, branchState.currentBranch)}
          defaultBranch={branchState.defaultBranch}
          recentBranches={branchState.recentBranches}
          selected={branchState.branches.find((branch) => branch.name === rebaseTarget) ?? null}
          preview={rebasePreview}
          running={rebaseRunning}
          progress={rebaseProgress}
          failure={rebaseMessage ?? rebasePreviewError}
          onSelect={(branch) => onRebaseTargetChange(branch.name)}
          onConfirm={onConfirmRebase}
          onCancel={onCancelRebase}
          operationViewModel={
            operationViewModel?.operation === "rebase" ? operationViewModel : undefined
          }
          onCancelOperation={onCancelOperation}
        />
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
        <PreferencesDialog
          state={preferencesState}
          store={preferencesStore}
          onDismiss={onDismissPreferences}
        />
      )}

      {showCloneDialog && (
        <CloneRepositoryDialog
          url={cloneURL}
          path={clonePath}
          onUrlChange={onCloneURLChange}
          onPathChange={onClonePathChange}
          running={cloneState.operation !== null}
          progress={cloneState.progress}
          error={cloneState.error}
          onChooseDestination={onChooseCloneDestination}
          onConfirm={onSubmitClone}
          onCancel={onDismissClone}
        />
      )}
    </>
  );
}
