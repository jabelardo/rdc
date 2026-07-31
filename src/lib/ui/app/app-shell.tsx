import { showFolderContents } from '../../platform/files'
import { openRepositoryInNewWindow } from '../../platform/window'
import { AppDialogs } from './app-dialogs'
import { ChangesWorkspace } from './changes-workspace'
import { HistoryWorkspace } from './history-workspace'
import { MergeConflicts } from './merge-conflicts'
import { RepositorySidebar } from './repository-sidebar'
import { RepositoryToolbar } from './repository-toolbar'
import type { AppController } from './use-app-controller'
import { WindowDragStrip } from './window-drag-strip'

type AppShellProps = {
  readonly controller: AppController
}

/** Layout composition for the application; state orchestration stays in the controller hook. */
export function AppShell({ controller }: AppShellProps) {
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
    useShellHookEnvironment,
    setUseShellHookEnvironment,
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
    toggleSidebarSection,
    activateSidebarSection,
  } = controller

  return (
    <main
      className={`application-shell grid h-screen${
        showWindowDragRegion ? ' webview-titlebar' : ''
      }${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
    >
      {showWindowDragRegion && <WindowDragStrip />}
      <RepositorySidebar
        collapsed={sidebarCollapsed}
        expandedSections={expandedSidebarSections}
        appState={appState}
        branchState={branchState}
        branchStore={branchStore}
        conflictState={conflictState}
        newBranchName={newBranchName}
        onToggleCollapsed={() => setSidebarCollapsed(collapsed => !collapsed)}
        onToggleSection={toggleSidebarSection}
        onActivateSection={activateSidebarSection}
        onSelectRepository={repository => void selectRepository(repository)}
        onRepositoryContextMenu={repository =>
          void openRepositoryContextMenu(repository)
        }
        onBranchNameChange={setNewBranchName}
        onBranchChange={refreshAfterBranchChange}
      />

      <section
        className="repository-workspace min-h-0 min-w-0 overflow-hidden"
        aria-label="Selected repository"
      >
        {appState.selectedRepository === null ? (
          <div className="repository-empty-state mx-auto max-w-[40rem] p-8 text-center">
            <div className="repository-empty-actions flex flex-wrap justify-center gap-2">
              <button
                type="button"
                title="Create a new Git repository"
                onClick={() => void createRepository()}
              >
                Create repository
              </button>
              <button
                type="button"
                title="Open a Git repository from this computer"
                onClick={() => void addExistingRepository()}
              >
                Add existing repository
              </button>
              <button
                type="button"
                title="Clone a Git repository from a remote URL"
                onClick={openCloneDialog}
              >
                Clone repository
              </button>
            </div>
          </div>
        ) : (
          <div className="selected-repository relative grid h-full min-h-0 min-w-0 text-left">
            <RepositoryToolbar
              repository={appState.selectedRepository}
              remoteState={remoteState}
              hasEditor={preferencesStore.selectedEditor !== null}
              hasShell={preferencesStore.selectedShell !== null}
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
              onOpenNewWindow={() =>
                void runRepositoryAction(() =>
                  openRepositoryInNewWindow(appState.selectedRepository!.path)
                )
              }
              onFetch={() => void refreshAfterFetch()}
              onPull={() => void refreshAfterPull()}
              onPush={() => void refreshAfterPush()}
            />
            <nav
              className="repository-view-navigation flex border-b border-[var(--color-border)] bg-[var(--color-canvas)] px-4"
              aria-label="Repository views"
            >
              <button
                type="button"
                aria-current={repositoryView === 'changes' ? 'page' : undefined}
                onClick={() => setRepositoryView('changes')}
              >
                Changes
              </button>
              <button
                type="button"
                aria-current={repositoryView === 'history' ? 'page' : undefined}
                onClick={() => setRepositoryView('history')}
              >
                History
              </button>
            </nav>
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
              useShellHookEnvironment={useShellHookEnvironment}
              commitTerminalOutput={commitTerminalOutput}
              onCommitMessageChange={setCommitMessage}
              onUseShellHookEnvironmentChange={setUseShellHookEnvironment}
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
        onCancelRemoveRepository={() => setRepositoryToRemove(null)}
        onConfirmRemoveRepository={() => void confirmRemoveRepository()}
        onDismissAbout={() => setShowAboutDialog(false)}
        onDismissPreferences={() => setShowPreferencesDialog(false)}
        onDismissClone={dismissCloneDialog}
        onChooseCloneDestination={() => void chooseCloneDestination()}
        onSubmitClone={() => void submitClone()}
        onCloneURLChange={setCloneURL}
        onClonePathChange={setClonePath}
      />
    </main>
  )
}
