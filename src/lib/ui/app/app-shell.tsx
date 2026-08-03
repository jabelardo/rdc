import { useRef, type CSSProperties } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faClone,
  faFolderPlus,
  faPlus,
} from '@fortawesome/free-solid-svg-icons'
import { showFolderContents } from '../../platform/files'
import { openRepositoryInNewWindow } from '../../platform/window'
import { showApplicationLogs } from '../../resilience/logs'
import { HorizontalResizer } from '../horizontal-resizer'
import { AppContextMenu } from './app-context-menu'
import { AppDialogs } from './app-dialogs'
import { ChangesWorkspace } from './changes-workspace'
import { HistoryWorkspace } from './history-workspace'
import { MergeConflicts } from './merge-conflicts'
import { RepositorySidebar } from './repository-sidebar'
import { RepositoryToolbar } from './repository-toolbar'
import type { AppController } from './use-app-controller'
import { WindowDragStrip } from './window-drag-strip'
import { currentMenuPlatform } from '../../menu/default-menu'
import { remoteEnablement } from '../../remote-enablement'
import { MenuBar } from './menu-bar'

type AppShellProps = {
  readonly controller: AppController
}

/** Layout composition for the application; state orchestration stays in the controller hook. */
export function AppShell({ controller }: AppShellProps) {
  const shellRef = useRef<HTMLElement>(null)
  const {
    appState,
    branchState,
    branchStore,
    cloneState,
    conflictState,
    conflictStore,
    historyState,
    historyStore,
    preferencesState,
    preferencesStore,
    remoteState,
    workingTreeState,
    workingTreeStore,
    repositoryView,
    setRepositoryView,
    sidebarCollapsed,
    setSidebarCollapsed,
    expandedSidebarSections,
    error,
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
    setRepositoryToRemove,
    showAboutDialog,
    setShowAboutDialog,
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
    requestRemoveRepository,
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
    requestDiscardAll,
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
    renameCurrentBranch,
    deleteCurrentBranch,
    openBranchContextMenu,
    mergePickerOpen,
    mergeTarget,
    setMergeTarget,
    mergeMessage,
    mergeRunning,
    confirmMerge,
    cancelMerge,
    requestMerge,
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
    requestManageRemotes,
    contextMenu,
    closeContextMenu,
    toggleSidebarSection,
    activateSidebarSection,
    showBranches,
    goToCommitMessage,
    increaseActiveResizableWidth,
    decreaseActiveResizableWidth,
    createBranch,
    sidebarWidth,
    setSidebarWidth,
    showBranchCreation,
    setShowBranchCreation,
  } = controller
  const platform = currentMenuPlatform()
  const showMenuBar = platform === 'linux' || platform === 'windows'
  const workspaceMinimum = appState.selectedRepository === null ? 490 : 560
  const hasSelection = appState.selectedRepository !== null
  const { canFetch, canPush, canPull } = remoteEnablement({
    hasSelection,
    selectedRepositoryPath: appState.selectedRepository?.path ?? null,
    remoteState,
  })
  const canCreateBranch =
    hasSelection &&
    branchState.operation === null &&
    !conflictState.mergeInProgress
  const canRenameBranch = canCreateBranch && branchState.currentBranch !== null
  const canDeleteBranch = canRenameBranch
  const canMerge =
    canCreateBranch &&
    branchState.currentBranch !== null &&
    (workingTreeState.workingDirectory?.files.length ?? 0) === 0 &&
    !conflictState.mergeInProgress
  const canDiscardAll =
    hasSelection &&
    (workingTreeState.workingDirectory?.files.length ?? 0) > 0 &&
    !workingTreeState.mergeHeadFound
  const focusRepositoryList = () => {
    document
      .querySelector<HTMLElement>(
        '[aria-label="Repositories"] [aria-current="true"]'
      )
      ?.focus()
  }

  return (
    <main
      ref={shellRef}
      className={`application-shell grid h-screen${
        showWindowDragRegion ? ' webview-titlebar' : ''
      }${sidebarCollapsed ? ' sidebar-collapsed' : ''}${
        showMenuBar ? ' has-menu-bar' : ''
      }`}
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--workspace-min-width': `${workspaceMinimum}px`,
        } as CSSProperties
      }
    >
      {showWindowDragRegion && <WindowDragStrip />}
      {showMenuBar && (
        <div className="app-menu-bar-container">
          <MenuBar
            onCreateRepository={() => void createRepository()}
            onAddExistingRepository={() => void addExistingRepository()}
            onCloneRepository={openCloneDialog}
            onShowPreferences={() => setShowPreferencesDialog(true)}
            onShowAbout={() => setShowAboutDialog(true)}
            onSelectView={setRepositoryView}
            onOpenNewWindow={() =>
              runRepositoryAction(() =>
                openRepositoryInNewWindow(appState.selectedRepository!.path)
              )
            }
            onShowRepositoryList={focusRepositoryList}
            onShowBranchesList={showBranches}
            onGoToCommitMessage={goToCommitMessage}
            onExpandSidebar={increaseActiveResizableWidth}
            onContractSidebar={decreaseActiveResizableWidth}
            onShowFiles={() =>
              runRepositoryAction(() =>
                showFolderContents(appState.selectedRepository!.path)
              )
            }
            onOpenEditor={() =>
              runRepositoryAction(() =>
                openInExternalEditor(appState.selectedRepository!.path)
              )
            }
            onOpenShell={() =>
              runRepositoryAction(() =>
                openInShell(appState.selectedRepository!.path)
              )
            }
            onFetch={() => void refreshAfterFetch()}
            onPush={() => void refreshAfterPush()}
            onPull={() => void refreshAfterPull()}
            onRemoveRepository={() => {
              if (appState.selectedRepository !== null) {
                requestRemoveRepository(appState.selectedRepository)
              }
            }}
            onNewBranch={createBranch}
            onRenameBranch={renameCurrentBranch}
            onDeleteBranch={deleteCurrentBranch}
            onMergeBranch={requestMerge}
            onManageRemotes={requestManageRemotes}
            onDiscardAll={requestDiscardAll}
            onShowLogs={() => void showApplicationLogs()}
            hasRepository={hasSelection}
            hasRepositories={appState.repositories.length > 0}
            hasEditor={preferencesStore.selectedEditor !== null}
            hasShell={preferencesStore.selectedShell !== null}
            canFetch={canFetch}
            canPush={canPush}
            canPull={canPull}
            canCreateBranch={canCreateBranch}
            canRenameBranch={canRenameBranch}
            canDeleteBranch={canDeleteBranch}
            canMergeBranch={canMerge}
            canDiscardAll={canDiscardAll}
            selectedShell={preferencesStore.selectedShell?.shell ?? null}
            selectedEditor={preferencesStore.selectedEditor?.editor ?? null}
          />
        </div>
      )}
      <RepositorySidebar
        collapsed={sidebarCollapsed}
        expandedSections={expandedSidebarSections}
        appState={appState}
        branchState={branchState}
        branchStore={branchStore}
        conflictState={conflictState}
        newBranchName={newBranchName}
        showBranchCreation={showBranchCreation}
        onShowBranchCreation={setShowBranchCreation}
        onToggleCollapsed={() => setSidebarCollapsed(collapsed => !collapsed)}
        onToggleSection={toggleSidebarSection}
        onActivateSection={activateSidebarSection}
        onSelectRepository={repository => void selectRepository(repository)}
        onRepositoryContextMenu={(repository, triggerRect) =>
          void openRepositoryContextMenu(repository, triggerRect)
        }
        onBranchContextMenu={(branch, triggerRect) =>
          void openBranchContextMenu(branch, triggerRect)
        }
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
          <div className="repository-empty-state mx-auto max-w-[40rem] p-8 text-center">
            <div className="repository-empty-actions flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => void createRepository()}>
                <FontAwesomeIcon icon={faPlus} aria-hidden="true" />
                Create repository
              </button>
              <button
                type="button"
                onClick={() => void addExistingRepository()}
              >
                <FontAwesomeIcon icon={faFolderPlus} aria-hidden="true" />
                Add existing repository
              </button>
              <button type="button" onClick={openCloneDialog}>
                <FontAwesomeIcon icon={faClone} aria-hidden="true" />
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
              hasEditor={preferencesStore.selectedEditor !== null}
              hasShell={preferencesStore.selectedShell !== null}
              repositoryView={repositoryView}
              onCreateRepository={() => void createRepository()}
              onAddExistingRepository={() => void addExistingRepository()}
              onCloneRepository={openCloneDialog}
              onShowFiles={() =>
                void runRepositoryAction(() =>
                  showFolderContents(appState.selectedRepository!.path)
                )
              }
              onOpenEditor={() =>
                void runRepositoryAction(() =>
                  openInExternalEditor(appState.selectedRepository!.path)
                )
              }
              onOpenShell={() =>
                void runRepositoryAction(() =>
                  openInShell(appState.selectedRepository!.path)
                )
              }
              onFetch={() => void refreshAfterFetch()}
              onPull={() => void refreshAfterPull()}
              onPush={() => void refreshAfterPush()}
              onSelectView={setRepositoryView}
            />
            {repositoryView === 'changes' && (
              <MergeConflicts
                repositoryPath={appState.selectedRepository.path}
                state={conflictState}
                store={conflictStore}
                onStageResolved={path => void stageResolvedConflict(path)}
              />
            )}
            <ChangesWorkspace
              visible={repositoryView === 'changes'}
              repositoryPath={appState.selectedRepository.path}
              state={workingTreeState}
              store={workingTreeStore}
              conflictStore={conflictStore}
              commitMessage={commitMessage}
              bypassHooks={bypassHooks}
              commitTerminalOutput={commitTerminalOutput}
              onCommitMessageChange={setCommitMessage}
              onBypassHooksChange={setBypassHooks}
              onDiscard={requestDiscard}
            />
            <HistoryWorkspace
              visible={repositoryView === 'history'}
              state={historyState}
              store={historyStore}
            />
          </div>
        )}

        {error !== null && (
          <p className="application-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <AppDialogs
        discardFile={discardFile}
        permanentlyDiscard={permanentlyDiscard}
        discardSelection={discardSelection}
        discardAll={discardAll}
        discarding={discarding}
        workingTreeError={workingTreeState.error}
        hookFailure={workingTreeState.hookFailure}
        workingTreeStore={workingTreeStore}
        repositoryToRemove={repositoryToRemove}
        showAboutDialog={showAboutDialog}
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
        onCancelRemoveRepository={() => setRepositoryToRemove(null)}
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
        onConfirmMerge={() => void confirmMerge()}
        onCancelMerge={cancelMerge}
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
        onConfirmRemoveRemote={name => void confirmRemoveRemote(name)}
        onCloseAddRemote={closeAddRemote}
        onCloseManageRemotes={closeManageRemotes}
        onDismissAbout={() => setShowAboutDialog(false)}
        onDismissPreferences={() => setShowPreferencesDialog(false)}
        onDismissClone={dismissCloneDialog}
        onChooseCloneDestination={() => void chooseCloneDestination()}
        onSubmitClone={() => void submitClone()}
        onCloneURLChange={setCloneURL}
        onClonePathChange={setClonePath}
      />
      <AppContextMenu
        items={contextMenu?.items ?? null}
        position={
          contextMenu === null ? null : { x: contextMenu.x, y: contextMenu.y }
        }
        onClose={closeContextMenu}
      />
    </main>
  )
}
