import { Copy, FolderPlus, Plus } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import { showFolderContents } from "@/platform/files";
import { HorizontalResizer } from "@/components/horizontal-resizer";
import { AppDialogs } from "./app-dialogs";
import { BranchDialogs } from "@/features/branches/components/branch-dialogs";
import { ChangesDialogs } from "@/features/changes/components/changes-dialogs";
import { RemoteDialogs } from "@/features/remotes/components/remote-dialogs";
import { ChangesWorkspace } from "@/features/changes/components/changes-workspace";
import { HistoryWorkspace } from "@/features/history/components/history-workspace";
import { MergeConflicts } from "@/features/conflicts/components/merge-conflicts";
import { MessageToasts } from "@/app/message-toasts";
import { RepositorySidebar } from "@/app/sidebar/repository-sidebar";
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
    renameDialog,
    deleteDialog,
    mergeDialog,
    rebaseDialog,
    manageRemotesDialog,
    addRemoteDialog,
    cloneDialog,
    discardDialog,
    commitProgress,
    hookFailureDialog,
    abortMergeDialog,
    removeRepositoryDialog,
    aboutDialog,
    preferencesDialog,
    branchStore,
    conflictState,
    conflictStore,
    historyState,
    historyStore,
    messageState,
    messageStore,
    remoteState,
    preferencesStore,
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
    showWindowDragRegion,
    newBranchName,
    setNewBranchName,
    debugProgressLauncher,
    debugProgressViewModel,
    onDebugShowOperationProgress,
    onDebugDismissOperationProgressLauncher,
    onDebugDismissOperationProgress,
    createRepository,
    addExistingRepository,
    openCloneDialog,
    selectRepository,
    openRepositoryContextMenu,
    openCommitContextMenu,
    runRepositoryAction,
    openInShell,
    openInExternalEditor,
    refreshAfterBranchChange,
    refreshAfterFetch,
    refreshAfterPush,
    refreshAfterPull,
    stageResolvedConflict,
    requestDiscard,
    openBranchContextMenu,
    continueHistoryRecovery,
    abortHistoryRecovery,
    continueRebaseRecovery,
    abortRebaseRecovery,
    requestAbortMerge,
    squashSelectedCommits,
    reorderSelectedCommits,
    manageRemoteError,
    manageRunning,
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
      <BranchDialogs
        branchState={branchState}
        rename={renameDialog}
        deletion={deleteDialog}
        merge={mergeDialog}
        rebase={rebaseDialog}
        operationViewModel={operationViewModel}
        onCancelOperation={() => void operationStore.requestCancellation()}
        onAdoptCancellation={() => void operationStore.requestCancellation(true)}
        onDismissOperation={() => operationStore.dismissTerminalOperation()}
      />
      <RemoteDialogs
        manage={manageRemotesDialog}
        add={addRemoteDialog}
        clone={cloneDialog}
        error={manageRemoteError}
        busy={manageRunning}
      />
      <ChangesDialogs
        discard={discardDialog}
        commitProgress={commitProgress}
        hookFailure={hookFailureDialog}
        operationViewModel={operationViewModel}
        onCancelOperation={() => void operationStore.requestCancellation()}
        onAdoptCancellation={() => void operationStore.requestCancellation(true)}
      />
      <AppDialogs
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
        abortMerge={abortMergeDialog}
        removeRepository={removeRepositoryDialog}
        about={aboutDialog}
        preferences={preferencesDialog}
      />
    </main>
  );
}
