import { useEffect, useRef, useState } from 'react'
import { join } from '@tauri-apps/api/path'
import type { Repository } from '../../../models/repository'
import { getCloneDirectoryName } from '../../clone-destination'
import { initRepository } from '../../git-ipc'
import { installApplicationMenu } from '../../menu/application-menu'
import { showContextualMenu } from '../../menu/context-menu'
import { currentMenuPlatform } from '../../menu/default-menu'
import {
  buildRepositoryMenu,
  createRepositoryMenuEventExecutor,
} from '../../menu/repository-menu'
import { getMainProcessConfig } from '../../platform/config'
import { showOpenDialog, showSaveDialog } from '../../platform/dialogs'
import { launchExternalEditor } from '../../platform/editors'
import { showFolderContents } from '../../platform/files'
import { installDefaultCloseRequestHandler } from '../../platform/lifetime'
import { launchShell } from '../../platform/shells'
import { onNativeThemeUpdated } from '../../platform/theme'
import {
  openRepositoryInNewWindow,
  sendReady,
  setWindowTitle,
} from '../../platform/window'
import { shouldShowWindowDragRegion } from '../../platform/window-drag-region'
import type { AppStoreState } from '../../stores/app-store'
import type { BranchState } from '../../stores/branch-store'
import type { CloneState } from '../../stores/clone-store'
import type { ConflictState } from '../../stores/conflict-store'
import { getDefaultAppStore } from '../../stores/default-app-store'
import { getDefaultBranchStore } from '../../stores/default-branch-store'
import { getDefaultCloneStore } from '../../stores/default-clone-store'
import { getDefaultConflictStore } from '../../stores/default-conflict-store'
import { getDefaultHistoryStore } from '../../stores/default-history-store'
import { getDefaultPreferencesStore } from '../../stores/default-preferences-store'
import { getDefaultRemoteStore } from '../../stores/default-remote-store'
import { getDefaultWorkingTreeStore } from '../../stores/default-working-tree-store'
import type { HistoryState } from '../../stores/history-store'
import type { PreferencesState } from '../../stores/preferences-store'
import type { RemoteState } from '../../stores/remote-store'
import type {
  SelectedLinesDiscard,
  WorkingTreeState,
} from '../../stores/working-tree-store'
import type { SidebarSectionID } from '../sidebar-sections'

const rendererStartTime = performance.now()
const rendererPlatform = currentMenuPlatform()
export type RepositoryView = 'changes' | 'history'

export function useAppController() {
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
  const [repositoryView, setActiveRepositoryView] =
    useState<RepositoryView>('changes')
  const activeRepositoryView = useRef<RepositoryView>('changes')
  const pendingRepositoryView = useRef<RepositoryView | null>(null)
  const repositoryViewTransitionID = useRef(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [expandedSidebarSections, setExpandedSidebarSections] = useState<
    ReadonlySet<SidebarSectionID>
  >(() => new Set<SidebarSectionID>())
  const [error, setError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [bypassHooks, setBypassHooks] = useState(false)
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
        ? 'RDC'
        : `RDC — ${repository.name}${
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
      createRepository,
      addLocalRepository: addExistingRepository,
      chooseRepository: () => {
        document
          .querySelector<HTMLElement>(
            '[aria-label="Repositories"] [aria-current="true"]'
          )
          ?.focus()
      },
      showChanges: () => selectRepositoryView('changes'),
      showHistory: () => selectRepositoryView('history'),
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
    repositoryViewTransitionID.current++
    pendingRepositoryView.current = null
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
      if (activeRepositoryView.current === 'history') {
        // Keep a valid frame visible while preparing History for the newly selected repository.
        activeRepositoryView.current = 'changes'
        setActiveRepositoryView('changes')
        const transitionID = ++repositoryViewTransitionID.current
        pendingRepositoryView.current = 'history'
        void historyStore.load(repository.path).then(() => {
          if (repositoryViewTransitionID.current === transitionID) {
            pendingRepositoryView.current = null
            activeRepositoryView.current = 'history'
            setActiveRepositoryView('history')
          }
        })
      }
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

  async function createRepository(): Promise<void> {
    const selected = await showSaveDialog({
      title: 'Create a repository',
      properties: ['createDirectory'],
    })
    if (selected === null) {
      return
    }

    try {
      setError(null)
      await initRepository(selected, 'main')
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

  async function openRepositoryContextMenu(
    repository: Repository,
    triggerRect?: import('../../platform/menu').TriggerRect
  ) {
    if (appState.selectedRepository?.id !== repository.id) {
      await selectRepository(repository)
    }
    await showContextualMenu(
      [
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
      ],
      false,
      triggerRect
    )
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
      // The expanded panel owns the sidebar's remaining height. Keeping this exclusive means a
      // repository list can scroll without pushing Branches off-screen, while every section header
      // remains available as the next accordion target.
      return current.has(section)
        ? new Set<SidebarSectionID>()
        : new Set<SidebarSectionID>([section])
    })
  }

  function activateSidebarSection(section: SidebarSectionID): void {
    setSidebarCollapsed(false)
    setExpandedSidebarSections(new Set<SidebarSectionID>([section]))
  }

  function selectRepositoryView(view: RepositoryView): void {
    if (view === 'changes') {
      repositoryViewTransitionID.current++
      pendingRepositoryView.current = null
      if (activeRepositoryView.current !== 'changes') {
        activeRepositoryView.current = 'changes'
        setActiveRepositoryView('changes')
      }
      return
    }
    if (
      activeRepositoryView.current === 'history' ||
      pendingRepositoryView.current === 'history'
    ) {
      return
    }

    const repository = appStore.state.selectedRepository
    if (repository === null) {
      return
    }
    const transitionID = ++repositoryViewTransitionID.current
    pendingRepositoryView.current = 'history'

    // HistoryWorkspace stays mounted but hidden, so its store updates build the complete commit,
    // file and diff tree off-screen. Reveal it only after `load` has finished that chain; exposing
    // it first made the browser paint the empty/loading/details/diff states in sequence. Reload on
    // every transition to preserve the former freshness contract after commits, fetches and pulls.
    void historyStore.load(repository.path).then(() => {
      if (
        repositoryViewTransitionID.current === transitionID &&
        appStore.state.selectedRepository?.path === repository.path
      ) {
        pendingRepositoryView.current = null
        activeRepositoryView.current = 'history'
        setActiveRepositoryView('history')
      }
    })
  }

  return {
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
    setRepositoryView: selectRepositoryView,
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
  }
}

export type AppController = ReturnType<typeof useAppController>
