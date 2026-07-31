import { useEffect, useState } from 'react'
import { join } from '@tauri-apps/api/path'
import { getCloneDirectoryName } from './lib/clone-destination'
import { getMainProcessConfig } from './lib/platform/config'
import { installApplicationMenu } from './lib/menu/application-menu'
import { showContextualMenu } from './lib/menu/context-menu'
import { currentMenuPlatform } from './lib/menu/default-menu'
import {
  buildRepositoryMenu,
  createRepositoryMenuEventExecutor,
} from './lib/menu/repository-menu'
import { showOpenDialog, showSaveDialog } from './lib/platform/dialogs'
import { launchExternalEditor } from './lib/platform/editors'
import { showFolderContents } from './lib/platform/files'
import { installDefaultCloseRequestHandler } from './lib/platform/lifetime'
import { launchShell } from './lib/platform/shells'
import { onNativeThemeUpdated } from './lib/platform/theme'
import {
  openRepositoryInNewWindow,
  sendReady,
  startWindowDragging,
  setWindowTitle,
} from './lib/platform/window'
import {
  handleWindowTitleBarDoubleClick,
  shouldShowWindowDragRegion,
} from './lib/platform/window-drag-region'
import { type AppStoreState } from './lib/stores/app-store'
import { getDefaultAppStore } from './lib/stores/default-app-store'
import { getDefaultBranchStore } from './lib/stores/default-branch-store'
import { getDefaultCloneStore } from './lib/stores/default-clone-store'
import { getDefaultConflictStore } from './lib/stores/default-conflict-store'
import { getDefaultHistoryStore } from './lib/stores/default-history-store'
import { getDefaultPreferencesStore } from './lib/stores/default-preferences-store'
import { getDefaultRemoteStore } from './lib/stores/default-remote-store'
import { getDefaultWorkingTreeStore } from './lib/stores/default-working-tree-store'
import type { BranchState } from './lib/stores/branch-store'
import type { CloneState } from './lib/stores/clone-store'
import type { ConflictState } from './lib/stores/conflict-store'
import type { HistoryState } from './lib/stores/history-store'
import type { PreferencesState } from './lib/stores/preferences-store'
import type { RemoteState } from './lib/stores/remote-store'
import type {
  SelectedLinesDiscard,
  WorkingTreeState,
} from './lib/stores/working-tree-store'
import { handleListNavigation } from './lib/ui/list-navigation'
import { Modal } from './lib/ui/modal'
import { RepositoryListRow, WorkingTreeFileRow } from './lib/ui/mvp-list-rows'
import {
  MvpSidebarCapabilities,
  type SidebarSectionID,
  visibleSidebarSections,
} from './lib/ui/sidebar-sections'
import { VirtualList } from './lib/ui/virtual-list'
import { mapStatus } from './lib/status'
import { BranchType } from './models/branch'
import type { Repository } from './models/repository'
import { DiffLineType, DiffType } from './models/diff'
import './App.css'

const rendererStartTime = performance.now()
const rendererPlatform = currentMenuPlatform()
const mvpSidebarSections = visibleSidebarSections(MvpSidebarCapabilities)
type RepositoryView = 'changes' | 'history'

function diffLineClassName(type: DiffLineType): string {
  switch (type) {
    case DiffLineType.Add:
      return 'diff-line-add'
    case DiffLineType.Delete:
      return 'diff-line-delete'
    case DiffLineType.Hunk:
      return 'diff-line-hunk'
    case DiffLineType.Context:
      return 'diff-line-context'
  }
}

function App() {
  const [appStore] = useState(getDefaultAppStore)
  const [branchStore] = useState(getDefaultBranchStore)
  const [cloneStore] = useState(getDefaultCloneStore)
  const [conflictStore] = useState(getDefaultConflictStore)
  const [historyStore] = useState(getDefaultHistoryStore)
  const [preferencesStore] = useState(getDefaultPreferencesStore)
  const [remoteStore] = useState(getDefaultRemoteStore)
  const [workingTreeStore] = useState(getDefaultWorkingTreeStore)
  const [appState, setAppState] = useState<AppStoreState>(appStore.state)
  const [workingTreeState, setWorkingTreeState] = useState<WorkingTreeState>(
    workingTreeStore.state
  )
  const [historyState, setHistoryState] = useState<HistoryState>(
    historyStore.state
  )
  const [remoteState, setRemoteState] = useState<RemoteState>(remoteStore.state)
  const [preferencesState, setPreferencesState] = useState<PreferencesState>(
    preferencesStore.state
  )
  const [branchState, setBranchState] = useState<BranchState>(branchStore.state)
  const [cloneState, setCloneState] = useState<CloneState>(cloneStore.state)
  const [conflictState, setConflictState] = useState<ConflictState>(
    conflictStore.state
  )
  const [repositoryView, setRepositoryView] =
    useState<RepositoryView>('changes')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [expandedSidebarSections, setExpandedSidebarSections] = useState<
    ReadonlySet<SidebarSectionID>
  >(() => new Set(MvpSidebarCapabilities))
  const [error, setError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [useShellHookEnvironment, setUseShellHookEnvironment] = useState(false)
  const [commitTerminalOutput, setCommitTerminalOutput] = useState('')
  const [discardFileID, setDiscardFileID] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [permanentlyDiscard, setPermanentlyDiscard] = useState(false)
  const [discardSelection, setDiscardSelection] = useState(false)
  const [selectedLinesDiscard, setSelectedLinesDiscard] =
    useState<SelectedLinesDiscard | null>(null)
  const [showCloneDialog, setShowCloneDialog] = useState(false)
  const [showAboutDialog, setShowAboutDialog] = useState(false)
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false)
  const [repositoryToRemove, setRepositoryToRemove] =
    useState<Repository | null>(null)
  const [cloneURL, setCloneURL] = useState('')
  const [clonePath, setClonePath] = useState('')
  const [showWindowDragRegion, setShowWindowDragRegion] = useState(
    shouldShowWindowDragRegion(rendererPlatform, 'native')
  )

  useEffect(() => {
    if (rendererPlatform !== 'linux') {
      return
    }
    void getMainProcessConfig()
      .then(config => {
        setShowWindowDragRegion(
          shouldShowWindowDragRegion(rendererPlatform, config.titleBarStyle)
        )
      })
      .catch(error => {
        log.error('Failed to resolve native title-bar configuration', error)
      })
  }, [])

  useEffect(() => {
    const repository = appState.selectedRepository
    const title =
      repository === null
        ? 'rdc'
        : `rdc — ${repository.name}${
            branchState.currentBranch === null
              ? ''
              : ` — ${branchState.currentBranch}`
          }`
    void setWindowTitle(title).catch(error => {
      log.error('Failed to update native window title', error)
    })
  }, [appState.selectedRepository, branchState.currentBranch])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void installDefaultCloseRequestHandler()
      .then(cleanup => {
        if (disposed) {
          cleanup()
        } else {
          unlisten = cleanup
        }
      })
      .catch(error => {
        log.error('Failed to install the native close handler', error)
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // This controller is installed once and reads changing menu data from store subscriptions.
  // Its action callbacks use stable stores/setters rather than render-time state. The planned
  // App decomposition will turn them into stable callbacks; recreating the native menu controller
  // on every render in the meantime would be the behavioral regression.
  // oxlint-disable react-hooks/exhaustive-deps
  useEffect(() => {
    let disposed = false
    let controller:
      | Awaited<ReturnType<typeof installApplicationMenu>>
      | undefined
    let updatePending = false
    let latestState = appStore.state
    let latestRemoteState = remoteStore.state
    let latestPreferencesState = preferencesStore.state
    const platform = rendererPlatform
    const executeMenuEvent = createRepositoryMenuEventExecutor(appStore, {
      addLocalRepository: addExistingRepository,
      chooseRepository: () => {
        document
          .querySelector<HTMLElement>(
            '[aria-label="Repositories"] [aria-current="true"]'
          )
          ?.focus()
      },
      showChanges: () => setRepositoryView('changes'),
      showHistory: () => setRepositoryView('history'),
      openRepositoryInNewWindow,
      showFolderContents,
      fetch: refreshAfterFetch,
      push: refreshAfterPush,
      pull: refreshAfterPull,
      showClone: openCloneDialog,
      showAbout: () => setShowAboutDialog(true),
      showPreferences: () => setShowPreferencesDialog(true),
      removeRepository: requestRemoveRepository,
      openInShell,
      openInExternalEditor,
    })
    const replaceMenu = () => {
      if (controller === undefined) {
        updatePending = true
        return
      }
      void controller
        .replaceMenu(
          buildRepositoryMenu(
            latestState,
            platform,
            latestRemoteState,
            latestPreferencesState
          )
        )
        .catch(error => {
          log.error('Failed to update the application menu', error)
        })
    }
    const unsubscribe = appStore.onDidUpdate(state => {
      latestState = state
      replaceMenu()
    })
    const unsubscribeRemote = remoteStore.onDidUpdate(state => {
      latestRemoteState = state
      replaceMenu()
    })
    const unsubscribePreferences = preferencesStore.onDidUpdate(state => {
      latestPreferencesState = state
      replaceMenu()
    })

    void installApplicationMenu({
      initialMenu: buildRepositoryMenu(
        latestState,
        platform,
        latestRemoteState,
        latestPreferencesState
      ),
      executeMenuEvent,
    })
      .then(async installedController => {
        if (disposed) {
          installedController.dispose()
        } else {
          controller = installedController
          if (updatePending) {
            updatePending = false
            await controller.replaceMenu(
              buildRepositoryMenu(
                latestState,
                platform,
                latestRemoteState,
                latestPreferencesState
              )
            )
          }
        }
      })
      .catch(error => {
        log.error('Failed to install the application menu', error)
      })

    return () => {
      disposed = true
      unsubscribe()
      unsubscribeRemote()
      unsubscribePreferences()
      controller?.dispose()
    }
  }, [
    appStore,
    branchStore,
    cloneStore,
    historyStore,
    preferencesStore,
    remoteStore,
  ])
  // oxlint-enable react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubscribe = workingTreeStore.onDidUpdate(setWorkingTreeState)
    const repository = appState.selectedRepository
    setDiscardFileID(null)
    setDiscarding(false)
    setPermanentlyDiscard(false)
    setDiscardSelection(false)
    setSelectedLinesDiscard(null)
    historyStore.clear()
    if (repository === null) {
      branchStore.clear()
      conflictStore.clear()
      remoteStore.clear()
      workingTreeStore.clear()
    } else {
      void branchStore.load(repository.path)
      void conflictStore.load(repository.path)
      void remoteStore.load(repository.path)
      void workingTreeStore.load(repository.path)
    }
    return unsubscribe
  }, [
    appState.selectedRepository,
    branchStore,
    conflictStore,
    historyStore,
    remoteStore,
    workingTreeStore,
  ])

  useEffect(
    () => workingTreeStore.onCommitTerminalOutput(setCommitTerminalOutput),
    [workingTreeStore]
  )

  useEffect(() => historyStore.onDidUpdate(setHistoryState), [historyStore])

  useEffect(() => cloneStore.onDidUpdate(setCloneState), [cloneStore])

  useEffect(() => remoteStore.onDidUpdate(setRemoteState), [remoteStore])

  useEffect(() => {
    const unsubscribe = preferencesStore.onDidUpdate(setPreferencesState)
    void preferencesStore.load()
    let disposed = false
    let unlistenTheme: (() => void) | undefined
    void onNativeThemeUpdated(() => {
      if (preferencesStore.state.theme === 'system') {
        void preferencesStore.refreshTheme()
      }
    })
      .then(unlisten => {
        if (disposed) {
          unlisten()
        } else {
          unlistenTheme = unlisten
        }
      })
      .catch(error => {
        log.error('Failed to observe native theme changes', error)
      })
    return () => {
      disposed = true
      unsubscribe()
      unlistenTheme?.()
    }
  }, [preferencesStore])

  useEffect(() => branchStore.onDidUpdate(setBranchState), [branchStore])

  useEffect(() => conflictStore.onDidUpdate(setConflictState), [conflictStore])

  useEffect(() => {
    const repository = appState.selectedRepository
    if (repository === null) {
      historyStore.clear()
    } else if (repositoryView === 'history') {
      void historyStore.load(repository.path)
    }
  }, [appState.selectedRepository, historyStore, repositoryView])

  useEffect(() => {
    let disposed = false
    const unsubscribe = appStore.onDidUpdate(state => {
      if (!disposed) {
        setAppState(state)
      }
    })
    const load = appStore.load().catch(error => {
      log.error('Failed to load the repository list', error)
      if (!disposed) {
        setError(String(error))
      }
    })

    void sendReady(performance.now() - rendererStartTime)
      .then(async action => {
        if (action?.kind === 'open-repository') {
          await load
          await appStore.addRepository(action.path, action.persistSelection)
        }
      })
      .catch(error => {
        log.error('Failed to complete the renderer-ready handshake', error)
      })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [appStore])

  async function addExistingRepository() {
    const selected = await showOpenDialog({
      title: 'Choose a repository directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selected === null) {
      return
    }

    try {
      setError(null)
      await appStore.addRepository(selected)
    } catch (error) {
      setError(String(error))
    }
  }

  function openCloneDialog(): void {
    cloneStore.reset()
    setShowCloneDialog(true)
  }

  function dismissCloneDialog(): void {
    if (cloneState.operation !== null) {
      return
    }
    cloneStore.reset()
    setShowCloneDialog(false)
  }

  async function chooseCloneDestination(): Promise<void> {
    const platform = currentMenuPlatform()
    if (platform === 'macos') {
      const selected = await showSaveDialog({
        title: 'Choose a clone destination',
        defaultPath: clonePath || undefined,
        properties: ['createDirectory'],
      })
      if (selected !== null) {
        setClonePath(selected)
      }
      return
    }

    const parent = await showOpenDialog({
      title: 'Choose a parent directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (parent === null) {
      return
    }
    const name = getCloneDirectoryName(cloneURL)
    setClonePath(name === null ? parent : await join(parent, name))
  }

  async function submitClone(): Promise<void> {
    const clonedPath = await cloneStore.clone(cloneURL, clonePath)
    if (clonedPath === null) {
      return
    }
    try {
      await appStore.addRepository(clonedPath)
      setCloneURL('')
      setClonePath('')
      setShowCloneDialog(false)
    } catch (error) {
      setError(String(error))
    }
  }

  async function selectRepository(repository: Repository) {
    try {
      setError(null)
      await appStore.selectRepository(repository)
    } catch (error) {
      setError(String(error))
    }
  }

  async function openRepositoryContextMenu(repository: Repository) {
    if (appState.selectedRepository?.id !== repository.id) {
      await selectRepository(repository)
    }
    await showContextualMenu([
      {
        label: 'Open in New Window',
        action: () => {
          void runRepositoryAction(() =>
            openRepositoryInNewWindow(repository.path)
          )
        },
      },
      {
        label: 'Show in File Manager',
        action: () => {
          void runRepositoryAction(() => showFolderContents(repository.path))
        },
      },
      { type: 'separator' },
      {
        label: 'Remove',
        action: () => {
          requestRemoveRepository(repository)
        },
      },
    ])
  }

  async function runRepositoryAction(action: () => Promise<void>) {
    try {
      setError(null)
      await action()
    } catch (error) {
      setError(String(error))
    }
  }

  function requestRemoveRepository(repository: Repository): void {
    if (preferencesStore.state.confirmRepositoryRemoval) {
      setRepositoryToRemove(repository)
    } else {
      void runRepositoryAction(() => appStore.removeRepository(repository))
    }
  }

  async function confirmRemoveRepository(): Promise<void> {
    if (repositoryToRemove === null) {
      return
    }
    const repository = repositoryToRemove
    setRepositoryToRemove(null)
    await runRepositoryAction(() => appStore.removeRepository(repository))
  }

  async function openInShell(path: string): Promise<void> {
    const shell = preferencesStore.selectedShell
    if (shell === null) {
      throw new Error('No terminal application is available')
    }
    await launchShell(shell, path)
  }

  async function openInExternalEditor(path: string): Promise<void> {
    const editor = preferencesStore.selectedEditor
    if (editor === null) {
      throw new Error('No external editor is available')
    }
    await launchExternalEditor(path, editor)
  }

  async function refreshAfterBranchChange(
    operation: () => Promise<boolean>
  ): Promise<void> {
    const repository = appState.selectedRepository
    if (repository === null || !(await operation())) {
      return
    }
    await Promise.all([
      remoteStore.load(repository.path),
      workingTreeStore.load(repository.path),
      conflictStore.load(repository.path),
    ])
    if (repositoryView === 'history') {
      await historyStore.load(repository.path)
    }
  }

  async function refreshAfterFetch(): Promise<void> {
    const repository = appStore.state.selectedRepository
    if (repository === null || !(await remoteStore.fetch())) {
      return
    }
    await branchStore.load(repository.path)
    if (historyStore.state.repositoryPath === repository.path) {
      await historyStore.load(repository.path)
    }
  }

  async function refreshAfterPush(): Promise<void> {
    const repository = appStore.state.selectedRepository
    if (repository === null || !(await remoteStore.push())) {
      return
    }
    await Promise.all([
      branchStore.load(repository.path),
      conflictStore.load(repository.path),
      workingTreeStore.load(repository.path),
    ])
    if (historyStore.state.repositoryPath === repository.path) {
      await historyStore.load(repository.path)
    }
  }

  async function refreshAfterPull(): Promise<void> {
    const repository = appStore.state.selectedRepository
    if (repository === null) {
      return
    }
    await remoteStore.pull()
    await Promise.all([
      branchStore.load(repository.path),
      conflictStore.load(repository.path),
      workingTreeStore.load(repository.path),
    ])
    if (historyStore.state.repositoryPath === repository.path) {
      await historyStore.load(repository.path)
    }
  }

  async function stageResolvedConflict(path: string): Promise<void> {
    const repository = appState.selectedRepository
    if (repository !== null && (await conflictStore.stageResolvedFile(path))) {
      await workingTreeStore.load(repository.path)
    }
  }

  const discardFile =
    workingTreeState.workingDirectory?.files.find(
      file => file.id === discardFileID
    ) ?? null
  const selectedWorkingTreeFile =
    workingTreeState.workingDirectory?.files.find(
      file => file.id === workingTreeState.selectedFileID
    ) ?? null
  const hasSelectedDiffLines =
    workingTreeState.diff?.kind === DiffType.Text &&
    selectedWorkingTreeFile !== null &&
    workingTreeState.diff.hunks.some(hunk =>
      hunk.lines.some(
        (line, index) =>
          line.isIncludeableLine() &&
          selectedWorkingTreeFile.selection.isSelected(
            hunk.unifiedDiffStart + index
          )
      )
    )
  const selectedHistoryCommit =
    historyState.commits.find(
      commit => commit.sha === historyState.selectedCommitSHA
    ) ?? null
  const selectedHistoryFile =
    historyState.changeset?.files.find(
      file => file.id === historyState.selectedFileID
    ) ?? null

  function requestDiscard(fileID: string, selection: boolean): void {
    if (selection || preferencesStore.state.confirmDiscardChanges) {
      const selectedLines = selection
        ? workingTreeStore.getSelectedLinesDiscard()
        : null
      if (selection && selectedLines === null) {
        return
      }
      setDiscardFileID(fileID)
      setDiscardSelection(selection)
      setSelectedLinesDiscard(selectedLines)
      setPermanentlyDiscard(false)
      return
    }
    void discardWholeFile(fileID, false)
  }

  async function discardWholeFile(
    fileID: string,
    permanent: boolean
  ): Promise<void> {
    setDiscarding(true)
    let result = await workingTreeStore.discardFile(fileID, permanent)
    if (
      result === 'trash-failed' &&
      !preferencesStore.state.confirmDiscardChangesPermanently
    ) {
      result = await workingTreeStore.discardFile(fileID, true)
    }
    setDiscarding(false)
    if (result === 'discarded') {
      setDiscardFileID(null)
      setPermanentlyDiscard(false)
      setSelectedLinesDiscard(null)
    } else if (result === 'trash-failed') {
      setDiscardFileID(fileID)
      setPermanentlyDiscard(true)
      setDiscardSelection(false)
      setSelectedLinesDiscard(null)
    }
  }

  async function confirmDiscard() {
    if (discardFile === null) {
      return
    }
    if (discardSelection) {
      setDiscarding(true)
      const discarded =
        await workingTreeStore.discardSelectedLines(selectedLinesDiscard)
      setDiscarding(false)
      if (discarded) {
        setDiscardFileID(null)
        setDiscardSelection(false)
        setSelectedLinesDiscard(null)
      }
      return
    }
    await discardWholeFile(discardFile.id, permanentlyDiscard)
  }

  function cancelDiscard(): void {
    if (discarding) {
      return
    }
    setDiscardFileID(null)
    setPermanentlyDiscard(false)
    setDiscardSelection(false)
    setSelectedLinesDiscard(null)
  }

  function toggleSidebarSection(section: SidebarSectionID): void {
    setExpandedSidebarSections(current => {
      const next = new Set(current)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }

  return (
    <main
      className={`application-shell${
        showWindowDragRegion ? ' webview-titlebar' : ''
      }${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
    >
      {showWindowDragRegion && (
        <div
          className="window-drag-region"
          aria-hidden="true"
          onMouseDown={event => {
            if (event.button === 0 && event.detail === 1) {
              void startWindowDragging().catch(error => {
                log.error('Failed to start native window dragging', error)
              })
            }
          }}
          onDoubleClick={() => {
            void handleWindowTitleBarDoubleClick().catch(error => {
              log.error(
                'Failed to perform native title-bar double-click action',
                error
              )
            })
          }}
        />
      )}
      <aside
        className={`repository-sidebar${
          sidebarCollapsed ? ' repository-sidebar-collapsed' : ''
        }`}
        aria-label="Navigation"
      >
        <button
          type="button"
          className="sidebar-collapse"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed(collapsed => !collapsed)}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        {!sidebarCollapsed && (
          <>
            <div className="repository-shell-heading">
              <h1>rdc</h1>
              <div>
                <button
                  type="button"
                  aria-label="Clone repository"
                  title="Clone repository"
                  onClick={openCloneDialog}
                >
                  Clone
                </button>
                <button
                  type="button"
                  aria-label="Add existing repository"
                  title="Add existing repository"
                  onClick={() => void addExistingRepository()}
                >
                  Add
                </button>
              </div>
            </div>
            <div className="sidebar-panels">
              {mvpSidebarSections.map(section => {
                const expanded = expandedSidebarSections.has(section.id)
                return (
                  <section className="sidebar-panel" key={section.id}>
                    <h2>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`sidebar-${section.id}`}
                        onClick={() => toggleSidebarSection(section.id)}
                      >
                        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                        {section.label}
                      </button>
                    </h2>
                    {expanded && (
                      <div
                        id={`sidebar-${section.id}`}
                        role="region"
                        aria-label={section.label}
                      >
                        {section.id === 'repositories' &&
                          (appState.repositories.length === 0 ? (
                            <p className="repository-list-empty">
                              No repositories yet.
                            </p>
                          ) : (
                            <VirtualList
                              items={appState.repositories}
                              className="repository-list"
                              ariaLabel="Repositories"
                              estimateSize={() => 56}
                              gap={5}
                              getItemKey={repository => repository.id}
                            >
                              {(repository, index, row) => (
                                <RepositoryListRow
                                  index={index}
                                  repositories={appState.repositories}
                                  repository={repository}
                                  row={row}
                                  selectedRepository={
                                    appState.selectedRepository
                                  }
                                  onContextMenu={repository => {
                                    void openRepositoryContextMenu(repository)
                                  }}
                                  onSelect={repository => {
                                    void selectRepository(repository)
                                  }}
                                />
                              )}
                            </VirtualList>
                          ))}
                        {section.id === 'branches' &&
                          (appState.selectedRepository === null ? (
                            <p className="sidebar-panel-empty">
                              Select a repository to view branches.
                            </p>
                          ) : (
                            <div className="branch-controls">
                              {branchState.loading ? (
                                <p>Loading branches…</p>
                              ) : branchState.error !== null ? (
                                <p className="application-error" role="alert">
                                  {branchState.error}
                                </p>
                              ) : (
                                <label>
                                  Current branch
                                  <select
                                    aria-label="Current branch"
                                    value={branchState.currentBranch ?? ''}
                                    disabled={
                                      branchState.operation !== null ||
                                      conflictState.mergeInProgress
                                    }
                                    onChange={event =>
                                      void refreshAfterBranchChange(() =>
                                        branchStore.checkout(
                                          event.currentTarget.value
                                        )
                                      )
                                    }
                                  >
                                    {branchState.currentBranch === null && (
                                      <option value="">
                                        Detached or unborn HEAD
                                      </option>
                                    )}
                                    {branchState.branches.map(branch => (
                                      <option
                                        key={branch.ref}
                                        value={branch.name}
                                        disabled={
                                          branch.type === BranchType.Remote
                                        }
                                      >
                                        {branch.name}
                                        {branch.type === BranchType.Remote
                                          ? ' (remote)'
                                          : ''}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                              <form
                                aria-label="Create branch"
                                onSubmit={event => {
                                  event.preventDefault()
                                  void refreshAfterBranchChange(() =>
                                    branchStore.createAndCheckout(newBranchName)
                                  ).then(() => {
                                    if (
                                      branchStore.state.operationError === null
                                    ) {
                                      setNewBranchName('')
                                    }
                                  })
                                }}
                              >
                                <label htmlFor="new-branch-name">
                                  New branch name
                                </label>
                                <input
                                  id="new-branch-name"
                                  value={newBranchName}
                                  disabled={
                                    branchState.operation !== null ||
                                    conflictState.mergeInProgress
                                  }
                                  onChange={event =>
                                    setNewBranchName(event.currentTarget.value)
                                  }
                                />
                                <button
                                  type="submit"
                                  disabled={
                                    branchState.operation !== null ||
                                    conflictState.mergeInProgress
                                  }
                                >
                                  {branchState.operation === 'creating'
                                    ? 'Creating…'
                                    : branchState.operation === 'checking-out'
                                      ? 'Checking out…'
                                      : 'Create branch'}
                                </button>
                              </form>
                              {branchState.progress !== null && (
                                <p role="status">
                                  {branchState.progress.description}
                                </p>
                              )}
                              {branchState.operationError !== null && (
                                <p className="application-error" role="alert">
                                  {branchState.operationError}
                                </p>
                              )}
                            </div>
                          ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </>
        )}
      </aside>

      <section
        className="repository-workspace"
        aria-label="Selected repository"
      >
        {appState.selectedRepository === null ? (
          <div className="repository-empty-state">
            <h2>Add a repository to get started</h2>
            <p>Open an existing Git repository from your computer.</p>
            <button type="button" onClick={() => void addExistingRepository()}>
              Add existing repository
            </button>
            <button type="button" onClick={openCloneDialog}>
              Clone repository
            </button>
          </div>
        ) : (
          <div className="selected-repository">
            <header
              className="repository-toolbar"
              role="toolbar"
              aria-label="Repository actions"
            >
              <div className="repository-toolbar-identity">
                <p className="selected-repository-eyebrow">Repository</p>
                <h2>{appState.selectedRepository.name}</h2>
                <p>{appState.selectedRepository.path}</p>
              </div>
              <div className="repository-toolbar-actions">
                <button
                  type="button"
                  onClick={() =>
                    void runRepositoryAction(() =>
                      showFolderContents(appState.selectedRepository!.path)
                    )
                  }
                >
                  Show files
                </button>
                <button
                  type="button"
                  disabled={preferencesStore.selectedEditor === null}
                  onClick={() =>
                    void runRepositoryAction(() =>
                      openInExternalEditor(appState.selectedRepository!.path)
                    )
                  }
                >
                  Open in editor
                </button>
                <button
                  type="button"
                  disabled={preferencesStore.selectedShell === null}
                  onClick={() =>
                    void runRepositoryAction(() =>
                      openInShell(appState.selectedRepository!.path)
                    )
                  }
                >
                  Open in terminal
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runRepositoryAction(() =>
                      openRepositoryInNewWindow(
                        appState.selectedRepository!.path
                      )
                    )
                  }
                >
                  Open in new window
                </button>
              </div>
              <section
                className="remote-controls"
                aria-label="Remote synchronization"
                aria-busy={
                  remoteState.loading || remoteState.operation !== null
                }
              >
                <div>
                  <h3>Remote</h3>
                  <p>
                    {remoteState.loading
                      ? 'Loading remotes…'
                      : remoteState.currentRemote === null
                        ? 'No remote configured.'
                        : `${remoteState.currentRemote.name} — ${remoteState.currentRemote.url}`}
                  </p>
                </div>
                <div className="remote-actions">
                  <button
                    type="button"
                    disabled={
                      remoteState.loading ||
                      remoteState.currentRemote === null ||
                      remoteState.operation !== null
                    }
                    onClick={() => void refreshAfterFetch()}
                  >
                    {remoteState.operation === 'fetch' ? 'Fetching…' : 'Fetch'}
                  </button>
                  <button
                    type="button"
                    disabled={
                      remoteState.loading ||
                      remoteState.currentRemote === null ||
                      remoteState.currentBranch === null ||
                      remoteState.currentBranch.upstream === null ||
                      remoteState.operation !== null
                    }
                    onClick={() => void refreshAfterPull()}
                  >
                    {remoteState.operation === 'pull' ? 'Pulling…' : 'Pull'}
                  </button>
                  <button
                    type="button"
                    disabled={
                      remoteState.loading ||
                      remoteState.currentRemote === null ||
                      remoteState.currentBranch === null ||
                      remoteState.operation !== null
                    }
                    onClick={() => void refreshAfterPush()}
                  >
                    {remoteState.operation === 'push' ? 'Pushing…' : 'Push'}
                  </button>
                </div>
                {remoteState.progress !== null && (
                  <p className="remote-progress" role="status">
                    {remoteState.progress.title ?? 'Fetching'}
                    {remoteState.progress.description
                      ? ` — ${remoteState.progress.description}`
                      : ''}
                    {` (${Math.round(remoteState.progress.value * 100)}%)`}
                  </p>
                )}
                {remoteState.error !== null && (
                  <p className="application-error" role="alert">
                    {remoteState.error}
                  </p>
                )}
                {remoteState.operationError !== null && (
                  <p className="application-error" role="alert">
                    {remoteState.operationError}
                  </p>
                )}
              </section>
            </header>
            <nav
              className="repository-view-navigation"
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
            {repositoryView === 'changes' &&
              (conflictState.mergeInProgress ||
                conflictState.files.length > 0 ||
                conflictState.error !== null) && (
                <section
                  className="merge-conflicts"
                  aria-label={
                    conflictState.mergeInProgress
                      ? 'Merge conflicts'
                      : 'Repository conflicts'
                  }
                >
                  <header>
                    <div>
                      <h3>
                        {conflictState.mergeInProgress
                          ? 'Merge in progress'
                          : 'Repository conflicts'}
                      </h3>
                      <p>
                        Resolve files in your editor, then refresh and stage
                        each resolution.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={
                        conflictState.loading ||
                        conflictState.stagingPath !== null
                      }
                      onClick={() => {
                        const repository = appState.selectedRepository
                        if (repository !== null) {
                          void conflictStore.load(repository.path)
                        }
                      }}
                    >
                      Refresh conflict state
                    </button>
                  </header>
                  {conflictState.loading ? (
                    <p>Loading conflict state…</p>
                  ) : conflictState.error !== null ? (
                    <p className="application-error" role="alert">
                      {conflictState.error}
                    </p>
                  ) : conflictState.files.length === 0 ? (
                    <p>All conflict resolutions are staged.</p>
                  ) : (
                    <ul>
                      {conflictState.files.map(file => (
                        <li key={file.path}>
                          <span>{file.path}</span>
                          <small>
                            {file.resolvedInWorkingTree
                              ? 'Resolved'
                              : 'conflictMarkerCount' in file.status
                                ? `${file.status.conflictMarkerCount} ${
                                    file.status.conflictMarkerCount === 1
                                      ? 'conflict marker'
                                      : 'conflict markers'
                                  }`
                                : 'Choose a side outside rdc'}
                          </small>
                          <button
                            type="button"
                            aria-label={`Stage resolution for ${file.path}`}
                            disabled={
                              !file.resolvedInWorkingTree ||
                              conflictState.stagingPath !== null
                            }
                            onClick={() =>
                              void stageResolvedConflict(file.path)
                            }
                          >
                            {conflictState.stagingPath === file.path
                              ? 'Staging…'
                              : 'Stage resolution'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {conflictState.operationError !== null && (
                    <p className="application-error" role="alert">
                      {conflictState.operationError}
                    </p>
                  )}
                </section>
              )}
            <div
              className="changes-workspace"
              hidden={repositoryView !== 'changes'}
            >
              <section
                className="working-tree"
                aria-label="Changes"
                aria-busy={
                  workingTreeState.loading || workingTreeState.commitLoading
                }
              >
                <header>
                  <h3>Changes</h3>
                  <button
                    type="button"
                    disabled={workingTreeState.loading}
                    onClick={() => {
                      const repository = appState.selectedRepository
                      if (repository !== null) {
                        void Promise.all([
                          workingTreeStore.load(repository.path),
                          conflictStore.load(repository.path),
                        ])
                      }
                    }}
                  >
                    Refresh changes
                  </button>
                </header>
                {workingTreeState.loading ? (
                  <p>Loading changes…</p>
                ) : workingTreeState.error !== null ? (
                  <p className="application-error" role="alert">
                    {workingTreeState.error}
                  </p>
                ) : workingTreeState.workingDirectory === null ||
                  workingTreeState.workingDirectory.files.length === 0 ? (
                  <p>No local changes.</p>
                ) : (
                  <VirtualList
                    items={workingTreeState.workingDirectory.files}
                    className="working-tree-files"
                    ariaLabel="Changed files"
                    estimateSize={() => 42}
                    gap={5}
                    getItemKey={file => file.id}
                  >
                    {(file, index, row) => (
                      <WorkingTreeFileRow
                        file={file}
                        files={workingTreeState.workingDirectory?.files ?? []}
                        index={index}
                        row={row}
                        selectedFileID={workingTreeState.selectedFileID}
                        onDiscard={fileID => requestDiscard(fileID, false)}
                        onSelect={fileID => {
                          void workingTreeStore.selectFile(fileID)
                        }}
                        onSetIncluded={(fileID, included) =>
                          workingTreeStore.setFileIncluded(fileID, included)
                        }
                      />
                    )}
                  </VirtualList>
                )}
              </section>
              <section className="working-tree-diff" aria-label="File diff">
                {workingTreeState.diffLoading ? (
                  <p>Loading diff…</p>
                ) : workingTreeState.diffError !== null ? (
                  <p className="application-error" role="alert">
                    {workingTreeState.diffError}
                  </p>
                ) : workingTreeState.diff === null ? null : workingTreeState
                    .diff.kind === DiffType.Text ? (
                  <>
                    <div
                      className="working-tree-diff-lines"
                      role="table"
                      aria-label="Selectable diff lines"
                    >
                      {workingTreeState.diff.hunks.flatMap((hunk, hunkIndex) =>
                        hunk.lines.map((line, lineIndex) => {
                          const absoluteIndex =
                            hunk.unifiedDiffStart + lineIndex
                          const includeable = line.isIncludeableLine()
                          return (
                            <div
                              className={`working-tree-diff-line ${diffLineClassName(
                                line.type
                              )}`}
                              role="row"
                              key={`${hunkIndex}-${absoluteIndex}`}
                              data-diff-line-index={absoluteIndex}
                            >
                              {includeable &&
                              selectedWorkingTreeFile !== null ? (
                                <input
                                  type="checkbox"
                                  aria-label={`Include diff line ${absoluteIndex}: ${line.content}`}
                                  checked={selectedWorkingTreeFile.selection.isSelected(
                                    absoluteIndex
                                  )}
                                  disabled={workingTreeState.commitLoading}
                                  onChange={event =>
                                    workingTreeStore.setLineIncluded(
                                      absoluteIndex,
                                      event.currentTarget.checked
                                    )
                                  }
                                />
                              ) : (
                                <span aria-hidden="true" />
                              )}
                              <span className="diff-line-number">
                                {line.oldLineNumber ?? ''}
                              </span>
                              <span className="diff-line-number">
                                {line.newLineNumber ?? ''}
                              </span>
                              <code>{line.text}</code>
                            </div>
                          )
                        })
                      )}
                    </div>
                    <button
                      type="button"
                      className="discard-selected-lines"
                      disabled={!hasSelectedDiffLines}
                      onClick={() => {
                        if (selectedWorkingTreeFile !== null) {
                          requestDiscard(selectedWorkingTreeFile.id, true)
                        }
                      }}
                    >
                      Discard selected lines
                    </button>
                  </>
                ) : workingTreeState.diff.kind === DiffType.LargeText ? (
                  <pre>{workingTreeState.diff.text}</pre>
                ) : workingTreeState.diff.kind === DiffType.Binary ? (
                  <p>Binary file cannot be displayed.</p>
                ) : workingTreeState.diff.kind === DiffType.Image ? (
                  <p>Image preview is not available yet.</p>
                ) : workingTreeState.diff.kind === DiffType.Submodule ? (
                  <p>Submodule change.</p>
                ) : (
                  <p>Diff cannot be displayed.</p>
                )}
              </section>
              {repositoryView === 'changes' &&
                workingTreeState.workingDirectory !== null &&
                workingTreeState.workingDirectory.files.length > 0 && (
                  <form
                    className="commit-form"
                    aria-label="Commit changes"
                    onSubmit={event => {
                      event.preventDefault()
                      void workingTreeStore
                        .commit(commitMessage, useShellHookEnvironment)
                        .then(sha => {
                          if (sha !== null) {
                            setCommitMessage('')
                          }
                        })
                    }}
                  >
                    <label htmlFor="commit-message">Commit message</label>
                    <input
                      id="commit-message"
                      value={commitMessage}
                      onChange={event =>
                        setCommitMessage(event.currentTarget.value)
                      }
                    />
                    <label className="commit-option">
                      <input
                        type="checkbox"
                        checked={useShellHookEnvironment}
                        disabled={workingTreeState.commitLoading}
                        onChange={event =>
                          setUseShellHookEnvironment(
                            event.currentTarget.checked
                          )
                        }
                      />
                      Run hooks with the shell environment
                    </label>
                    <button
                      type="submit"
                      disabled={workingTreeState.commitLoading}
                    >
                      {workingTreeState.commitLoading
                        ? 'Committing…'
                        : 'Commit included files'}
                    </button>
                    {workingTreeState.commitError !== null && (
                      <p className="application-error" role="alert">
                        {workingTreeState.commitError}
                      </p>
                    )}
                    {commitTerminalOutput.length > 0 && (
                      <pre
                        className="commit-terminal-output"
                        aria-label="Commit terminal output"
                      >
                        {commitTerminalOutput}
                      </pre>
                    )}
                  </form>
                )}
            </div>
            <section
              className="history"
              aria-label="History"
              aria-busy={
                historyState.loading ||
                historyState.detailsLoading ||
                historyState.diffLoading
              }
              hidden={repositoryView !== 'history'}
            >
              <div className="history-list-pane">
                <h3>History</h3>
                {historyState.loading ? (
                  <p>Loading history…</p>
                ) : historyState.error !== null ? (
                  <p className="application-error" role="alert">
                    {historyState.error}
                  </p>
                ) : historyState.commits.length === 0 ? (
                  <p>No commits yet.</p>
                ) : (
                  <ul
                    className="history-commits"
                    aria-label="Commits"
                    data-keyboard-list
                  >
                    {historyState.commits.map((commit, index) => (
                      <li key={commit.sha}>
                        <button
                          type="button"
                          data-commit-sha={commit.sha}
                          data-keyboard-list-item
                          aria-current={
                            historyState.selectedCommitSHA === commit.sha
                              ? 'true'
                              : undefined
                          }
                          tabIndex={
                            historyState.selectedCommitSHA === commit.sha ||
                            (historyState.selectedCommitSHA === null &&
                              index === 0)
                              ? 0
                              : -1
                          }
                          onClick={() =>
                            void historyStore.selectCommit(commit.sha)
                          }
                          onKeyDown={event =>
                            handleListNavigation(
                              event,
                              index,
                              historyState.commits.length,
                              targetIndex => {
                                void historyStore.selectCommit(
                                  historyState.commits[targetIndex].sha
                                )
                              }
                            )
                          }
                        >
                          <code>{commit.shortSha}</code>
                          <strong>{commit.summary}</strong>
                          <small>{commit.author.name}</small>
                          <time dateTime={commit.author.date.toISOString()}>
                            {commit.author.date.toLocaleDateString()}
                          </time>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {selectedHistoryCommit !== null && (
                <section
                  className="history-details"
                  aria-label="Selected commit details"
                >
                  <header>
                    <div>
                      <h4>{selectedHistoryCommit.summary}</h4>
                      <code>{selectedHistoryCommit.sha}</code>
                    </div>
                    <p>
                      {selectedHistoryCommit.author.name} &lt;
                      {selectedHistoryCommit.author.email}&gt;
                    </p>
                  </header>
                  {selectedHistoryCommit.bodyNoCoAuthors.trim().length > 0 && (
                    <pre className="history-commit-body">
                      {selectedHistoryCommit.bodyNoCoAuthors}
                    </pre>
                  )}
                  {historyState.detailsLoading ? (
                    <p>Loading commit details…</p>
                  ) : historyState.detailsError !== null ? (
                    <p className="application-error" role="alert">
                      {historyState.detailsError}
                    </p>
                  ) : historyState.changeset === null ? null : (
                    <>
                      <p className="history-change-summary">
                        {historyState.changeset.files.length}{' '}
                        {historyState.changeset.files.length === 1
                          ? 'changed file'
                          : 'changed files'}
                        <span>+{historyState.changeset.linesAdded}</span>
                        <span>−{historyState.changeset.linesDeleted}</span>
                      </p>
                      {historyState.changeset.files.length === 0 ? (
                        <p>No files in commit.</p>
                      ) : (
                        <ul
                          className="history-files"
                          aria-label="Commit files"
                          data-keyboard-list
                        >
                          {historyState.changeset.files.map((file, index) => (
                            <li key={file.id}>
                              <button
                                type="button"
                                aria-label={file.path}
                                data-keyboard-list-item
                                aria-current={
                                  historyState.selectedFileID === file.id
                                    ? 'true'
                                    : undefined
                                }
                                tabIndex={
                                  historyState.selectedFileID === file.id ||
                                  (historyState.selectedFileID === null &&
                                    index === 0)
                                    ? 0
                                    : -1
                                }
                                onClick={() =>
                                  void historyStore.selectFile(file.id)
                                }
                                onKeyDown={event =>
                                  handleListNavigation(
                                    event,
                                    index,
                                    historyState.changeset?.files.length ?? 0,
                                    targetIndex => {
                                      const target =
                                        historyState.changeset?.files[
                                          targetIndex
                                        ]
                                      if (target !== undefined) {
                                        void historyStore.selectFile(target.id)
                                      }
                                    }
                                  )
                                }
                              >
                                <span>{file.path}</span>
                                <small>{mapStatus(file.status)}</small>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  <section
                    className="history-diff"
                    aria-label="Commit file diff"
                  >
                    {historyState.diffLoading ? (
                      <p>Loading diff…</p>
                    ) : historyState.diffError !== null ? (
                      <p className="application-error" role="alert">
                        {historyState.diffError}
                      </p>
                    ) : historyState.diff === null ||
                      selectedHistoryFile === null ? null : historyState.diff
                        .kind === DiffType.Text ? (
                      <div
                        className="working-tree-diff-lines"
                        role="table"
                        aria-label={`Diff for ${selectedHistoryFile.path}`}
                      >
                        {historyState.diff.hunks.flatMap((hunk, hunkIndex) =>
                          hunk.lines.map((line, lineIndex) => (
                            <div
                              className={`working-tree-diff-line ${diffLineClassName(
                                line.type
                              )}`}
                              role="row"
                              key={`${hunkIndex}-${
                                hunk.unifiedDiffStart + lineIndex
                              }`}
                            >
                              <span aria-hidden="true" />
                              <span className="diff-line-number">
                                {line.oldLineNumber ?? ''}
                              </span>
                              <span className="diff-line-number">
                                {line.newLineNumber ?? ''}
                              </span>
                              <code>{line.text}</code>
                            </div>
                          ))
                        )}
                      </div>
                    ) : historyState.diff.kind === DiffType.LargeText ? (
                      <pre>{historyState.diff.text}</pre>
                    ) : historyState.diff.kind === DiffType.Binary ? (
                      <p>Binary file cannot be displayed.</p>
                    ) : historyState.diff.kind === DiffType.Image ? (
                      <p>Image preview is not available yet.</p>
                    ) : historyState.diff.kind === DiffType.Submodule ? (
                      <p>Submodule change.</p>
                    ) : (
                      <p>Diff cannot be displayed.</p>
                    )}
                  </section>
                </section>
              )}
            </section>
          </div>
        )}

        {error !== null && (
          <p className="application-error" role="alert">
            {error}
          </p>
        )}
      </section>
      {discardFile !== null && (
        <Modal
          className="confirmation-dialog"
          role="alertdialog"
          aria-labelledby="discard-dialog-title"
          aria-describedby="discard-dialog-message"
          onDismiss={discarding ? undefined : cancelDiscard}
        >
          <h2 id="discard-dialog-title">
            {permanentlyDiscard
              ? 'Permanently discard changes'
              : 'Confirm discard changes'}
          </h2>
          <p>
            Are you sure you want to discard{' '}
            {discardSelection ? 'the selected changes to ' : 'all changes to '}
            <strong>{discardFile.path}</strong>?
          </p>
          <p id="discard-dialog-message">
            {discardSelection
              ? 'Selected changes cannot be restored from the operating system trash.'
              : permanentlyDiscard
                ? 'Changes cannot be restored after deletion.'
                : 'Changes can be restored from the operating system trash.'}
          </p>
          {workingTreeState.error !== null && (
            <p className="application-error" role="alert">
              {workingTreeState.error}
            </p>
          )}
          <div className="confirmation-dialog-actions">
            <button type="button" disabled={discarding} onClick={cancelDiscard}>
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              disabled={discarding}
              onClick={() => void confirmDiscard()}
            >
              {discarding
                ? 'Discarding…'
                : permanentlyDiscard
                  ? 'Permanently discard changes'
                  : 'Discard changes'}
            </button>
          </div>
        </Modal>
      )}
      {workingTreeState.hookFailure !== null && (
        <Modal
          className="confirmation-dialog"
          role="alertdialog"
          aria-labelledby="hook-failure-title"
          aria-describedby="hook-failure-message"
        >
          <h2 id="hook-failure-title">Git hook failed</h2>
          <p id="hook-failure-message">
            The <strong>{workingTreeState.hookFailure.hook}</strong> hook
            failed. Abort the commit, or ignore this failure and continue?
          </p>
          <pre className="commit-terminal-output">
            {workingTreeState.hookFailure.terminalOutput}
          </pre>
          <div className="confirmation-dialog-actions">
            <button
              type="button"
              onClick={() => workingTreeStore.resolveHookFailure('abort')}
            >
              Abort commit
            </button>
            <button
              type="button"
              onClick={() => workingTreeStore.resolveHookFailure('ignore')}
            >
              Ignore hook failure
            </button>
          </div>
        </Modal>
      )}
      {repositoryToRemove !== null && (
        <Modal
          className="confirmation-dialog"
          role="alertdialog"
          aria-labelledby="remove-repository-title"
          aria-describedby="remove-repository-message"
          onDismiss={() => setRepositoryToRemove(null)}
        >
          <h2 id="remove-repository-title">Remove repository</h2>
          <p id="remove-repository-message">
            Remove <strong>{repositoryToRemove.name}</strong> from rdc? Files in
            the repository will not be deleted.
          </p>
          <div className="confirmation-dialog-actions">
            <button type="button" onClick={() => setRepositoryToRemove(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              onClick={() => void confirmRemoveRepository()}
            >
              Remove repository
            </button>
          </div>
        </Modal>
      )}
      {showAboutDialog && (
        <Modal
          className="confirmation-dialog about-dialog"
          aria-labelledby="about-dialog-title"
          onDismiss={() => setShowAboutDialog(false)}
        >
          <h2 id="about-dialog-title">About rdc</h2>
          <p>Version {__APP_VERSION__}</p>
          <p>A native Git client built with Tauri and Rust.</p>
          <div className="confirmation-dialog-actions">
            <button type="button" onClick={() => setShowAboutDialog(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}
      {showPreferencesDialog && (
        <Modal
          className="confirmation-dialog preferences-dialog"
          aria-labelledby="preferences-dialog-title"
          onDismiss={() => setShowPreferencesDialog(false)}
        >
          <h2 id="preferences-dialog-title">Preferences</h2>
          <div className="preferences-fields">
            <label htmlFor="theme-preference">Theme</label>
            <select
              id="theme-preference"
              value={preferencesState.theme}
              onChange={event =>
                void preferencesStore.setTheme(
                  event.currentTarget.value as PreferencesState['theme']
                )
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>

            <label htmlFor="editor-preference">External editor</label>
            <select
              id="editor-preference"
              value={preferencesState.selectedExternalEditor ?? ''}
              disabled={preferencesState.loading}
              onChange={event =>
                preferencesStore.setSelectedExternalEditor(
                  event.currentTarget.value || null
                )
              }
            >
              {preferencesState.editors.length === 0 && (
                <option value="">No supported editor found</option>
              )}
              {preferencesState.editors.map(editor => (
                <option key={editor.editor} value={editor.editor}>
                  {editor.editor}
                </option>
              ))}
            </select>

            <label htmlFor="shell-preference">Shell</label>
            <select
              id="shell-preference"
              value={preferencesState.selectedShell ?? ''}
              disabled={preferencesState.loading}
              onChange={event =>
                preferencesStore.setSelectedShell(
                  (event.currentTarget.value ||
                    null) as PreferencesState['selectedShell']
                )
              }
            >
              {preferencesState.shells.length === 0 && (
                <option value="">No supported shell found</option>
              )}
              {preferencesState.shells.map(shell => (
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
                  onChange={event =>
                    preferencesStore.setConfirmRepositoryRemoval(
                      event.currentTarget.checked
                    )
                  }
                />
                Removing a repository from rdc
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmDiscardChanges}
                  onChange={event =>
                    preferencesStore.setConfirmDiscardChanges(
                      event.currentTarget.checked
                    )
                  }
                />
                Discarding file changes
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmDiscardChangesPermanently}
                  onChange={event =>
                    preferencesStore.setConfirmDiscardChangesPermanently(
                      event.currentTarget.checked
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
          <div className="confirmation-dialog-actions">
            <button
              type="button"
              onClick={() => setShowPreferencesDialog(false)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
      {showCloneDialog && (
        <Modal
          className="confirmation-dialog clone-dialog"
          aria-labelledby="clone-dialog-title"
          onDismiss={
            cloneState.operation === null ? dismissCloneDialog : undefined
          }
        >
          <h2 id="clone-dialog-title">Clone a repository</h2>
          <form
            aria-busy={cloneState.operation !== null}
            onSubmit={event => {
              event.preventDefault()
              void submitClone()
            }}
          >
            <label htmlFor="clone-url">Repository URL</label>
            <input
              id="clone-url"
              value={cloneURL}
              disabled={cloneState.operation !== null}
              onChange={event => setCloneURL(event.currentTarget.value)}
            />
            <label htmlFor="clone-path">Destination path</label>
            <div className="clone-path">
              <input
                id="clone-path"
                value={clonePath}
                disabled={cloneState.operation !== null}
                onChange={event => setClonePath(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={cloneState.operation !== null}
                onClick={() => void chooseCloneDestination()}
              >
                Browse…
              </button>
            </div>
            {cloneState.progress !== null && (
              <div className="clone-progress" role="status">
                <progress value={cloneState.progress.value} max={1} />
                <span>
                  {cloneState.progress.description ??
                    cloneState.progress.title ??
                    'Cloning…'}
                </span>
              </div>
            )}
            {cloneState.error !== null && (
              <p className="application-error" role="alert">
                {cloneState.error}
              </p>
            )}
            <div className="confirmation-dialog-actions">
              <button
                type="button"
                disabled={cloneState.operation !== null}
                onClick={dismissCloneDialog}
              >
                Cancel
              </button>
              <button type="submit" disabled={cloneState.operation !== null}>
                {cloneState.operation === 'clone' ? 'Cloning…' : 'Clone'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  )
}

export default App
