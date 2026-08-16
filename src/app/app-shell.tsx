import { Copy, FolderPlus, Plus } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import { showFolderContents } from "@/platform/files";
import { HorizontalResizer } from "@/components/horizontal-resizer";
import { AppDialogs } from "./app-dialogs";
import { ChangesWorkspace } from "@/features/changes/components/changes-workspace";
import { HistoryWorkspace } from "@/features/history/components/history-workspace";
import { MergeConflicts } from "@/features/conflicts/components/merge-conflicts";
import { MessageToasts } from "@/app/message-toasts";
import { RepositorySidebar } from "@/app/repository-sidebar";
import { RepositoryToolbar } from "./repository-toolbar";
import type { AppController } from "./use-app-controller";
import { WindowDragStrip } from "./window-drag-strip";
import { remoteEnablement } from "@/features/remotes/remote-enablement";
import {
  isHistoryMovingOperation,
  operationProgressViewModel,
} from "@/lib/operations/operation-presentation";
import { DebugOperationProgressLauncher } from "@/testing/debug-operation-progress-launcher";

type AppShellProps = {
  readonly controller: AppController;
};

/** Layout composition for the application; state orchestration stays in the controller hook. */
export function AppShell({ controller }: AppShellProps) {
  const shellRef = useRef<HTMLElement>(null);
  const {
    appState,
    branchState,
    branchStore,
    cloneState,
    cloneStore,
    conflictState,
    conflictStore,
    historyState,
    historyStore,
    messageState,
    messageStore,
    preferencesState,
    preferencesStore,
    remoteState,
    workingTreeState,
    workingTreeStore,
    repositoryView,
    operationState,
    operationStore,
    setRepositoryView,
    sidebarCollapsed,
    setSidebarCollapsed,
    expandedSidebarSections,
    commitMessage,
    setCommitMessage,
    bypassHooks,
    setBypassHooks,
    commitTerminalOutput,
    showWindowDragRegion,
    newBranchName,
    setNewBranchName,
    cloneURL,
    setCloneURL,
    clonePath,
    setClonePath,
    showCloneDialog,
    repositoryToRemove,
    removeRepositoryError,
    removingRepository,
    cancelRemoveRepository,
    showAboutDialog,
    debugProgressLauncher,
    debugProgressViewModel,
    onDebugShowOperationProgress,
    onDebugDismissOperationProgressLauncher,
    onDebugDismissOperationProgress,
    setShowAboutDialog,
    appArchitecture,
    showPreferencesDialog,
    setShowPreferencesDialog,
    discardFile,
    permanentlyDiscard,
    discardSelection,
    discarding,
    createRepository,
    addExistingRepository,
    openCloneDialog,
    dismissCloneDialog,
    chooseCloneDestination,
    submitClone,
    selectRepository,
    openRepositoryContextMenu,
    openCommitContextMenu,
    runRepositoryAction,
    confirmRemoveRepository,
    openInShell,
    openInExternalEditor,
    refreshAfterBranchChange,
    refreshAfterFetch,
    refreshAfterPush,
    refreshAfterPull,
    stageResolvedConflict,
    requestDiscard,
    confirmDiscard,
    cancelDiscard,
    discardAll,
    discardOptOut,
    setDiscardOptOut,
    confirmDiscardAll,
    cancelDiscardAll,
    branchToRename,
    renameName,
    setRenameName,
    confirmRename,
    cancelRename,
    branchToDelete,
    deleteRefusal,
    deleteUnmerged,
    deletePruneTrackingRef,
    setDeletePruneTrackingRef,
    confirmDelete,
    cancelDelete,
    openBranchContextMenu,
    continueHistoryRecovery,
    abortHistoryRecovery,
    continueRebaseRecovery,
    abortRebaseRecovery,
    requestAbortMerge,
    cancelAbortMerge,
    confirmAbortMerge,
    confirmingAbortMerge,
    abortingMerge,
    abortMergeError,
    squashSelectedCommits,
    reorderSelectedCommits,
    mergePickerOpen,
    mergeTarget,
    setMergeTarget,
    mergeMessage,
    mergeRunning,
    mergeStatus,
    mergeCommitCount,
    mergeStrategy,
    setMergeStrategy,
    mergePreviewError,
    mergedBranches,
    confirmMerge,
    cancelMerge,
    rebasePickerOpen,
    rebaseTarget,
    setRebaseTarget,
    rebaseMessage,
    rebaseRunning,
    rebasePreview,
    rebasePreviewError,
    confirmRebase,
    cancelRebase,
    showManageRemotes,
    remoteFilter,
    setRemoteFilter,
    showAddRemote,
    addRemoteName,
    setAddRemoteName,
    addRemoteURL,
    setAddRemoteURL,
    manageRemoteError,
    manageRunning,
    openAddRemote,
    closeAddRemote,
    confirmAddRemote,
    confirmRemoveRemote,
    closeManageRemotes,
    toggleSidebarSection,
    activateSidebarSection,
    sidebarWidth,
    setSidebarWidth,
    showBranchCreation,
    setShowBranchCreation,
  } = controller;
  const workspaceMinimum = appState.selectedRepository === null ? 490 : 560;
  const hasSelection = appState.selectedRepository !== null;
  const operationLockActive =
    operationState.operation !== null &&
    !["completed", "cancelled", "timedOut", "failed"].includes(operationState.operation.state);
  const { canFetch, canPush, canPull } = remoteEnablement({
    hasSelection,
    selectedRepositoryPath: appState.selectedRepository?.path ?? null,
    remoteState,
    repositoryOperationActive: operationLockActive,
  });
  const operationPeerMessage =
    operationLockActive && operationState.role === "observer"
      ? `${operationState.operation!.operation} in progress — Started in another window`
      : undefined;
  const historyOperationActive =
    operationLockActive && isHistoryMovingOperation(operationState.operation!.operation);
  const operationViewModel =
    operationState.operation === null
      ? undefined
      : operationProgressViewModel(operationState.operation, "", operationState.role ?? "observer");

  return (
    <main
      ref={shellRef}
      className={`application-shell grid h-screen${
        showWindowDragRegion ? " webview-titlebar" : ""
      }${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--workspace-min-width": `${workspaceMinimum}px`,
        } as CSSProperties
      }
    >
      <MessageToasts
        messages={messageState.messages}
        onDismiss={(id) => messageStore.dismiss(id)}
      />

      {showWindowDragRegion && <WindowDragStrip />}
      <RepositorySidebar
        collapsed={sidebarCollapsed}
        expandedSections={expandedSidebarSections}
        appState={appState}
        branchState={branchState}
        branchStore={branchStore}
        checkoutProgressViewModel={
          operationLockActive && operationViewModel?.operation === "checkout"
            ? operationViewModel
            : undefined
        }
        conflictState={conflictState}
        newBranchName={newBranchName}
        showBranchCreation={showBranchCreation}
        onShowBranchCreation={setShowBranchCreation}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        onToggleSection={toggleSidebarSection}
        onActivateSection={activateSidebarSection}
        onSelectRepository={(repository) => void selectRepository(repository)}
        onRepositoryContextMenu={(repository, x, y) =>
          void openRepositoryContextMenu(repository, x, y)
        }
        onBranchContextMenu={(branch, x, y) => void openBranchContextMenu(branch, x, y)}
        onBranchNameChange={setNewBranchName}
        onBranchChange={refreshAfterBranchChange}
      />
      {sidebarCollapsed ? (
        <HorizontalResizer
          ariaLabel="Expand navigation sidebar"
          className="sidebar-resizer"
          containerRef={shellRef}
          minimum={52}
          maximum={52}
          oppositeMinimum={workspaceMinimum}
          value={52}
          onResize={() => undefined}
          onMaximumHold={() => setSidebarCollapsed(false)}
        />
      ) : (
        <HorizontalResizer
          ariaLabel="Resize navigation sidebar"
          className="sidebar-resizer"
          containerRef={shellRef}
          minimum={125}
          oppositeMinimum={workspaceMinimum}
          value={sidebarWidth}
          onResize={setSidebarWidth}
          onMinimumHold={() => setSidebarCollapsed(true)}
        />
      )}

      <section
        className="repository-workspace min-h-0 min-w-0 overflow-hidden"
        aria-label="Selected repository"
      >
        {appState.selectedRepository === null ? (
          <div className="repository-empty-state mx-auto max-w-[520px] p-8 text-center">
            <div className="repository-empty-actions flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => void createRepository()}>
                <Plus aria-hidden="true" />
                Create repository
              </button>
              <button type="button" onClick={() => void addExistingRepository()}>
                <FolderPlus aria-hidden="true" />
                Add existing repository
              </button>
              <button type="button" onClick={openCloneDialog}>
                <Copy aria-hidden="true" />
                Clone repository
              </button>
            </div>
          </div>
        ) : (
          <div className="selected-repository relative grid h-full min-h-0 min-w-0 text-left">
            <RepositoryToolbar
              remoteState={remoteState}
              canFetch={canFetch}
              canPush={canPush}
              canPull={canPull}
              operationLockActive={operationLockActive}
              operationPeerMessage={operationPeerMessage}
              operationViewModel={operationViewModel}
              historyOperationActive={historyOperationActive}
              hasEditor={preferencesStore.selectedEditor !== null}
              hasShell={preferencesStore.selectedShell !== null}
              repositoryView={repositoryView}
              onCreateRepository={() => void createRepository()}
              onAddExistingRepository={() => void addExistingRepository()}
              onCloneRepository={openCloneDialog}
              onShowFiles={() =>
                void runRepositoryAction(() =>
                  showFolderContents(appState.selectedRepository!.path),
                )
              }
              onOpenEditor={() =>
                void runRepositoryAction(() =>
                  openInExternalEditor(appState.selectedRepository!.path),
                )
              }
              onOpenShell={() =>
                void runRepositoryAction(() => openInShell(appState.selectedRepository!.path))
              }
              onFetch={() => void refreshAfterFetch()}
              onPull={() => void refreshAfterPull()}
              onPush={() => void refreshAfterPush()}
              onSelectView={setRepositoryView}
            />
            {(repositoryView === "changes" ||
              (operationLockActive && operationViewModel?.state === "recovering") ||
              conflictState.recoveryOperation !== null) && (
              <MergeConflicts
                repositoryPath={appState.selectedRepository.path}
                state={conflictState}
                store={conflictStore}
                onStageResolved={(path) => void stageResolvedConflict(path)}
                recoveryOperation={
                  operationLockActive &&
                  operationViewModel?.state === "recovering" &&
                  (operationViewModel.operation === "cherryPick" ||
                    operationViewModel.operation === "revert")
                    ? operationViewModel.operation
                    : (conflictState.recoveryOperation ?? undefined)
                }
                onContinueRecovery={() => void continueHistoryRecovery()}
                onAbortRecovery={() => void abortHistoryRecovery()}
                onContinueRebase={() => void continueRebaseRecovery()}
                onAbortRebase={() => void abortRebaseRecovery()}
                onAbortMerge={requestAbortMerge}
              />
            )}
            <ChangesWorkspace
              visible={repositoryView === "changes"}
              repositoryPath={appState.selectedRepository.path}
              state={workingTreeState}
              store={workingTreeStore}
              onRefreshRelated={(repositoryPath) => conflictStore.load(repositoryPath)}
              commitMessage={commitMessage}
              bypassHooks={bypassHooks}
              onCommitMessageChange={setCommitMessage}
              onBypassHooksChange={setBypassHooks}
              onDiscard={requestDiscard}
            />
            <HistoryWorkspace
              visible={repositoryView === "history"}
              state={historyState}
              store={historyStore}
              onCommitContextMenu={openCommitContextMenu}
              onSquashSelected={squashSelectedCommits}
              onReorderSelected={reorderSelectedCommits}
            />
          </div>
        )}
      </section>
      {debugProgressLauncher && (
        <DebugOperationProgressLauncher
          onShow={onDebugShowOperationProgress}
          onDismiss={onDebugDismissOperationProgressLauncher}
        />
      )}
      <AppDialogs
        discardFile={discardFile}
        permanentlyDiscard={permanentlyDiscard}
        discardSelection={discardSelection}
        discardAll={discardAll}
        discardOptOut={discardOptOut}
        onDiscardOptOutChange={setDiscardOptOut}
        discarding={discarding}
        workingTreeError={workingTreeState.discardError}
        hookFailure={workingTreeState.hookFailure}
        runningHook={workingTreeState.runningHook}
        commitLoading={workingTreeState.commitLoading}
        commitTerminalOutput={commitTerminalOutput}
        operationViewModel={debugProgressViewModel ?? operationViewModel}
        // A preview has no operation behind it, so every action closes it rather than reaching the
        // registry — cancelling an operation that does not exist is not a preview of anything.
        // Each lifecycle state the buttons would lead to is its own entry in the launcher.
        onCancelOperation={
          debugProgressViewModel === undefined
            ? () => void operationStore.requestCancellation()
            : onDebugDismissOperationProgress
        }
        onAdoptCancellation={
          debugProgressViewModel === undefined
            ? () => void operationStore.requestCancellation(true)
            : onDebugDismissOperationProgress
        }
        onDismissOperation={
          debugProgressViewModel === undefined
            ? () => operationStore.dismissTerminalOperation()
            : onDebugDismissOperationProgress
        }
        workingTreeStore={workingTreeStore}
        repositoryToRemove={repositoryToRemove}
        showAboutDialog={showAboutDialog}
        appArchitecture={appArchitecture}
        showPreferencesDialog={showPreferencesDialog}
        preferencesState={preferencesState}
        preferencesStore={preferencesStore}
        showCloneDialog={showCloneDialog}
        cloneState={cloneState}
        cloneURL={cloneURL}
        clonePath={clonePath}
        onCancelDiscard={cancelDiscard}
        onConfirmDiscard={() => void confirmDiscard()}
        onCancelDiscardAll={cancelDiscardAll}
        onConfirmDiscardAll={() => void confirmDiscardAll()}
        confirmingAbortMerge={confirmingAbortMerge}
        abortingMerge={abortingMerge}
        abortMergeError={abortMergeError}
        onCancelAbortMerge={cancelAbortMerge}
        onConfirmAbortMerge={() => void confirmAbortMerge()}
        onCancelRemoveRepository={cancelRemoveRepository}
        removeRepositoryError={removeRepositoryError}
        removingRepository={removingRepository}
        onConfirmRemoveRepository={() => void confirmRemoveRepository()}
        branchToRename={branchToRename}
        renameName={renameName}
        onRenameNameChange={setRenameName}
        onConfirmRename={() => void confirmRename()}
        onCancelRename={cancelRename}
        branchToDelete={branchToDelete}
        deleteRefusal={deleteRefusal}
        deleteUnmerged={deleteUnmerged}
        deletePruneTrackingRef={deletePruneTrackingRef}
        onDeletePruneChange={setDeletePruneTrackingRef}
        onConfirmDelete={() => void confirmDelete()}
        onCancelDelete={cancelDelete}
        branchState={branchState}
        mergePickerOpen={mergePickerOpen}
        mergeTarget={mergeTarget}
        onMergeTargetChange={setMergeTarget}
        mergeMessage={mergeMessage}
        mergeRunning={mergeRunning}
        mergeStatus={mergeStatus}
        mergeCommitCount={mergeCommitCount}
        mergeProgress={branchState.progress?.kind === "generic" ? branchState.progress : null}
        mergeStrategy={mergeStrategy}
        onMergeStrategyChange={setMergeStrategy}
        mergePreviewError={mergePreviewError}
        mergedBranches={mergedBranches}
        onConfirmMerge={() => void confirmMerge()}
        onCancelMerge={cancelMerge}
        rebasePickerOpen={rebasePickerOpen}
        rebaseTarget={rebaseTarget}
        onRebaseTargetChange={setRebaseTarget}
        rebaseMessage={rebaseMessage}
        rebaseRunning={rebaseRunning}
        rebaseProgress={
          branchState.progress?.kind === "multiCommitOperation" ? branchState.progress : null
        }
        rebasePreview={rebasePreview}
        rebasePreviewError={rebasePreviewError}
        onConfirmRebase={() => void confirmRebase()}
        onCancelRebase={cancelRebase}
        showManageRemotes={showManageRemotes}
        remotes={remoteState.remotes}
        remoteFilter={remoteFilter}
        onRemoteFilterChange={setRemoteFilter}
        showAddRemote={showAddRemote}
        addRemoteName={addRemoteName}
        onAddRemoteNameChange={setAddRemoteName}
        addRemoteURL={addRemoteURL}
        onAddRemoteURLChange={setAddRemoteURL}
        manageRemoteError={manageRemoteError}
        manageRunning={manageRunning}
        onNewRemote={openAddRemote}
        onConfirmAddRemote={() => void confirmAddRemote()}
        onConfirmRemoveRemote={(name) => void confirmRemoveRemote(name)}
        onCloseAddRemote={closeAddRemote}
        onCloseManageRemotes={closeManageRemotes}
        onDismissAbout={() => setShowAboutDialog(false)}
        onDismissPreferences={() => setShowPreferencesDialog(false)}
        onDismissClone={dismissCloneDialog}
        onCancelCloneOperation={() => void cloneStore.requestCancellation()}
        onChooseCloneDestination={() => void chooseCloneDestination()}
        onSubmitClone={() => void submitClone()}
        onCloneURLChange={setCloneURL}
        onClonePathChange={setClonePath}
      />
    </main>
  );
}
