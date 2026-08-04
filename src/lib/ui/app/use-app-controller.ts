import { useEffect, useRef, useState } from 'react'
import { join } from '@tauri-apps/api/path'
import { BranchType, type Branch } from '../../../models/branch'
import type { Repository } from '../../../models/repository'
import { getCloneDirectoryName } from '../../clone-destination'
import { getMergedBranches } from '../../branch-ipc'
import { initRepository } from '../../git-ipc'
import { installApplicationMenu } from '../../menu/application-menu'
import { showContextMenu, type ContextMenuPosition } from '../../platform/menu'
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
import { useQaStateDriver } from './use-qa-state-driver'
import {
  openRepositoryInNewWindow,
  sendReady,
  setWindowTitle,
} from '../../platform/window'
import { shouldShowWindowDragRegion } from '../../platform/window-drag-region'
import { setWindowZoomFactor } from '../../platform/window'
import type { AppStoreState } from '../../stores/app-store'
import type { BranchState } from '../../stores/branch-store'
import type { MergeInitiationResult } from '../../stores/branch-store'
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
  const [showBranchCreation, setShowBranchCreation] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(264)
  const [bypassHooks, setBypassHooks] = useState(false)
  const [commitTerminalOutput, setCommitTerminalOutput] = useState('')
  const [discardFileID, setDiscardFileID] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [permanentlyDiscard, setPermanentlyDiscard] = useState(false)
  const [discardSelection, setDiscardSelection] = useState(false)
  const [selectedLinesDiscard, setSelectedLinesDiscard] =
    useState<SelectedLinesDiscard | null>(null)
  const [discardAll, setDiscardAll] = useState<{
    readonly permanent: boolean
    readonly fileCount: number
  } | null>(null)
  const [branchToRename, setBranchToRename] = useState<Branch | null>(null)
  const [renameName, setRenameName] = useState('')
  const [branchToDelete, setBranchToDelete] = useState<Branch | null>(null)
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null)
  const [deleteUnmerged, setDeleteUnmerged] = useState(false)
  const [deletePruneTrackingRef, setDeletePruneTrackingRef] = useState(false)
  const [mergePickerOpen, setMergePickerOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState('')
  const [mergeMessage, setMergeMessage] = useState<string | null>(null)
  const [mergeRunning, setMergeRunning] = useState(false)
  const [showManageRemotes, setShowManageRemotes] = useState(false)
  const [remoteFilter, setRemoteFilter] = useState('')
  const [showAddRemote, setShowAddRemote] = useState(false)
  const [addRemoteName, setAddRemoteName] = useState('')
  const [addRemoteURL, setAddRemoteURL] = useState('')
  const [manageRemoteError, setManageRemoteError] = useState<string | null>(
    null
  )
  const [manageRunning, setManageRunning] = useState(false)
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
      showBranches,
      goToCommitMessage,
      increaseActiveResizableWidth,
      decreaseActiveResizableWidth,
      createBranch,
      discardAllChanges: () => requestDiscardAll(false),
      permanentlyDiscardAllChanges: () => requestDiscardAll(true),
      renameBranch: renameCurrentBranch,
      deleteBranch: deleteCurrentBranch,
      mergeBranch: requestMerge,
      manageRemotes: requestManageRemotes,
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
    setDiscardAll(null)
    setBranchToRename(null)
    setBranchToDelete(null)
    setDeleteRefusal(null)
    setDeleteUnmerged(false)
    setDeletePruneTrackingRef(false)
    setMergePickerOpen(false)
    setMergeMessage(null)
    setMergeRunning(false)
    setShowManageRemotes(false)
    setShowAddRemote(false)
    setRemoteFilter('')
    setManageRemoteError(null)
    setManageRunning(false)
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
    void preferencesStore.load().then(() => {
      // Apply persisted zoom after preferences load. The startup executor
      // initializes to 1.0; preferences may hold a different value.
      const zoom = preferencesStore.state.zoomFactor
      if (zoom !== 1.0) {
        void setWindowZoomFactor(zoom)
      }
    })
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

  /**
   * Builds the position to anchor a context menu at, from the coordinates its trigger captured.
   *
   * `hasNativeTitleBarChrome` reuses `showWindowDragRegion` rather than re-deriving it: that flag
   * is already exactly "the app draws its own in-webview title bar/drag strip", so its negation is
   * exactly "GTK is drawing real CSD chrome above the viewport" — the one case
   * `showContextMenu`'s CSD offset needs to know about.
   */
  function contextMenuPositionAt(
    x: number | undefined,
    y: number | undefined
  ): ContextMenuPosition | undefined {
    if (x === undefined || y === undefined) {
      return undefined
    }
    return { x, y, hasNativeTitleBarChrome: !showWindowDragRegion }
  }

  async function openRepositoryContextMenu(
    repository: Repository,
    x?: number,
    y?: number
  ) {
    if (appState.selectedRepository?.id !== repository.id) {
      await selectRepository(repository)
    }
    await showContextMenu(
      [
        {
          text: 'Open in New Window',
          action: () => {
            void runRepositoryAction(() =>
              openRepositoryInNewWindow(repository.path)
            )
          },
        },
        {
          text: 'Show in File Manager',
          action: () => {
            void runRepositoryAction(() => showFolderContents(repository.path))
          },
        },
        { type: 'separator' },
        {
          text: 'Manage remotes…',
          action: () => {
            requestManageRemotes()
          },
        },
        {
          text: 'Remove',
          action: () => {
            requestRemoveRepository(repository)
          },
        },
      ],
      contextMenuPositionAt(x, y)
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
    setDiscardAll(null)
  }

  function requestDiscardAll(permanent: boolean): void {
    const files = workingTreeState.workingDirectory?.files ?? []
    if (files.length === 0) {
      return
    }
    const shouldConfirm = permanent
      ? preferencesStore.state.confirmDiscardChangesPermanently
      : preferencesStore.state.confirmDiscardChanges
    if (shouldConfirm) {
      setDiscardAll({ permanent, fileCount: files.length })
      return
    }
    void discardAllWorkingChanges(permanent, files.length)
  }

  async function discardAllWorkingChanges(
    permanent: boolean,
    fileCount: number
  ): Promise<void> {
    setDiscarding(true)
    let result = await workingTreeStore.discardAllChanges(permanent)
    if (
      result === 'trash-failed' &&
      !preferencesStore.state.confirmDiscardChangesPermanently
    ) {
      result = await workingTreeStore.discardAllChanges(true)
    }
    setDiscarding(false)
    if (result === 'discarded') {
      setDiscardAll(null)
    } else if (result === 'trash-failed') {
      setDiscardAll({ permanent: true, fileCount })
    }
  }

  async function confirmDiscardAll(): Promise<void> {
    if (discardAll === null) {
      return
    }
    await discardAllWorkingChanges(discardAll.permanent, discardAll.fileCount)
  }

  function cancelDiscardAll(): void {
    if (discarding) {
      return
    }
    setDiscardAll(null)
  }

  function requestRename(branch: Branch): void {
    setBranchToRename(branch)
    setRenameName(branch.name)
  }

  function renameCurrentBranch(): void {
    const current = branchStore.state.currentBranch
    if (current === null) {
      return
    }
    const branch = branchStore.state.branches.find(
      branch => branch.type === BranchType.Local && branch.name === current
    )
    if (branch !== undefined) {
      requestRename(branch)
    }
  }

  async function confirmRename(): Promise<void> {
    if (branchToRename === null) {
      return
    }
    const branch = branchToRename
    await refreshAfterBranchChange(() =>
      branchStore.renameBranch(branch.name, renameName)
    )
    if (branchStore.state.operationError === null) {
      setBranchToRename(null)
      setRenameName('')
    }
  }

  function cancelRename(): void {
    if (branchStore.state.operation !== null) {
      return
    }
    setBranchToRename(null)
    setRenameName('')
  }

  function deleteCurrentBranch(): void {
    const current = branchStore.state.currentBranch
    if (current === null) {
      return
    }
    const branch = branchStore.state.branches.find(
      branch => branch.type === BranchType.Local && branch.name === current
    )
    if (branch !== undefined) {
      void requestDelete(branch)
    }
  }

  async function requestDelete(branch: Branch): Promise<void> {
    if (
      branch.name === branchState.currentBranch ||
      branch.name === branchState.defaultBranch
    ) {
      setDeleteRefusal(
        branch.name === branchState.currentBranch
          ? `You cannot delete the current branch '${branch.name}'.`
          : `You cannot delete the default branch '${branch.name}'.`
      )
      return
    }
    const repository = appState.selectedRepository
    setDeleteRefusal(null)
    setDeletePruneTrackingRef(false)
    setDeleteUnmerged(false)
    if (repository !== null && branchState.currentBranch !== null) {
      try {
        const merged = await getMergedBranches(
          repository.path,
          branchState.currentBranch
        )
        setDeleteUnmerged(!merged.has(`refs/heads/${branch.name}`))
      } catch {
        setDeleteUnmerged(false)
      }
    }
    setBranchToDelete(branch)
  }

  async function confirmDelete(): Promise<void> {
    if (branchToDelete === null) {
      return
    }
    const branch = branchToDelete
    await refreshAfterBranchChange(() =>
      branchStore.deleteBranch(branch.name, {
        pruneTrackingRef: deletePruneTrackingRef,
      })
    )
    if (branchStore.state.operationError === null) {
      setBranchToDelete(null)
      setDeleteUnmerged(false)
      setDeletePruneTrackingRef(false)
    }
  }

  function cancelDelete(): void {
    if (branchStore.state.operation !== null) {
      return
    }
    setBranchToDelete(null)
    setDeleteRefusal(null)
    setDeleteUnmerged(false)
    setDeletePruneTrackingRef(false)
  }

  async function openBranchContextMenu(branch: Branch, x?: number, y?: number) {
    const current = branch.name === branchState.currentBranch
    const defaultBranch = branch.name === branchState.defaultBranch
    const canDelete = !current && !defaultBranch
    await showContextMenu(
      [
        {
          text: 'Rename…',
          action: () => requestRename(branch),
        },
        {
          text: 'Delete…',
          enabled: canDelete,
          action: () => {
            void requestDelete(branch)
          },
        },
      ],
      contextMenuPositionAt(x, y)
    )
  }

  function requestMerge(): void {
    setMergeTarget('')
    setMergeMessage(null)
    setMergePickerOpen(true)
  }

  function mergeMessageFor(
    result: MergeInitiationResult,
    target: string
  ): string {
    switch (result) {
      case 'up-to-date':
        return `${target} is already up to date with the current branch.`
      case 'invalid':
        return 'These branches do not share a common ancestor and cannot be merged.'
      case 'dirty':
        return 'Clean the working tree before merging.'
      case 'failed':
        return 'The merge failed.'
      case 'merged':
      case 'conflict':
        return ''
    }
  }

  async function confirmMerge(): Promise<void> {
    if (mergeTarget === '' || mergeRunning) {
      return
    }
    setMergeRunning(true)
    setMergeMessage(null)
    const target = mergeTarget
    const workingTreeDirty =
      (workingTreeState.workingDirectory?.files.length ?? 0) > 0
    try {
      const result = await branchStore.initiateMerge(target, {
        workingTreeDirty,
      })
      if (result === 'merged' || result === 'conflict') {
        await refreshAfterBranchChange(() => Promise.resolve(true))
        setMergePickerOpen(false)
        return
      }
      setMergeMessage(mergeMessageFor(result, target))
    } catch {
      setMergeMessage('The merge failed.')
    } finally {
      setMergeRunning(false)
    }
  }

  function cancelMerge(): void {
    if (mergeRunning) {
      return
    }
    setMergePickerOpen(false)
    setMergeMessage(null)
    setMergeTarget('')
  }

  function requestManageRemotes(): void {
    setRemoteFilter('')
    setManageRemoteError(null)
    setShowManageRemotes(true)
  }

  function closeManageRemotes(): void {
    if (manageRunning) {
      return
    }
    setShowManageRemotes(false)
    setShowAddRemote(false)
    setRemoteFilter('')
    setManageRemoteError(null)
  }

  function openAddRemote(): void {
    setAddRemoteName('')
    setAddRemoteURL('')
    setManageRemoteError(null)
    setShowAddRemote(true)
  }

  function closeAddRemote(): void {
    if (manageRunning) {
      return
    }
    setShowAddRemote(false)
    setManageRemoteError(null)
  }

  async function confirmAddRemote(): Promise<void> {
    if (manageRunning) {
      return
    }
    const name = addRemoteName.trim()
    const url = addRemoteURL.trim()
    setManageRemoteError(null)
    if (name.length === 0 || /\s/.test(name)) {
      setManageRemoteError('Remote names cannot be empty or contain spaces.')
      return
    }
    if (url.length === 0) {
      setManageRemoteError('Enter a remote URL.')
      return
    }
    if (remoteState.remotes.some(remote => remote.name === name)) {
      setManageRemoteError(`A remote named "${name}" already exists.`)
      return
    }
    const repository = appState.selectedRepository
    if (repository === null) {
      return
    }
    setManageRunning(true)
    const added = await remoteStore.addRemote(name, url)
    setManageRunning(false)
    if (added) {
      setShowAddRemote(false)
      setAddRemoteName('')
      setAddRemoteURL('')
      await branchStore.load(repository.path)
    } else if (remoteStore.state.operationError !== null) {
      setManageRemoteError(remoteStore.state.operationError)
    }
  }

  async function confirmRemoveRemote(name: string): Promise<void> {
    if (manageRunning) {
      return
    }
    const repository = appState.selectedRepository
    if (repository === null) {
      return
    }
    setManageRunning(true)
    setManageRemoteError(null)
    const removed = await remoteStore.removeRemote(name)
    setManageRunning(false)
    if (removed) {
      await branchStore.load(repository.path)
    } else if (remoteStore.state.operationError !== null) {
      setManageRemoteError(remoteStore.state.operationError)
    }
  }

  function toggleSidebarSection(section: SidebarSectionID): void {
    setExpandedSidebarSections(current => {
      return current.has(section)
        ? new Set<SidebarSectionID>()
        : new Set<SidebarSectionID>([section])
    })
  }

  function activateSidebarSection(section: SidebarSectionID): void {
    setSidebarCollapsed(false)
    setExpandedSidebarSections(new Set<SidebarSectionID>([section]))
  }

  function showBranches(): void {
    activateSidebarSection('branches')
    requestAnimationFrame(() =>
      document.getElementById('sidebar-branches-heading')?.focus()
    )
  }

  function goToCommitMessage(): void {
    if (activeRepositoryView.current !== 'changes') {
      selectRepositoryView('changes')
    }
    requestAnimationFrame(() =>
      document.getElementById('commit-message')?.focus()
    )
  }

  function increaseActiveResizableWidth(): void {
    setSidebarCollapsed(false)
    setSidebarWidth(width => Math.min(width + 16, 640))
  }

  function decreaseActiveResizableWidth(): void {
    setSidebarWidth(width => Math.max(width - 16, 125))
  }

  function createBranch(): void {
    setShowBranchCreation(true)
    activateSidebarSection('branches')
    requestAnimationFrame(() =>
      document.getElementById('new-branch-name')?.focus()
    )
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

  useQaStateDriver({
    applyTheme: theme => preferencesStore.setTheme(theme),
    setRepositoryView: view => selectRepositoryView(view),
    setSidebarCollapsed,
    selectRepositoryByPath: async path => {
      const existing = appStore.state.repositories.find(
        repository =>
          repository.path === path ||
          repository.path.replace(/\/+$/, '') === path.replace(/\/+$/, '')
      )
      if (existing !== undefined) {
        await appStore.selectRepository(existing)
        return true
      }
      await appStore.addRepository(path)
      return true
    },
  })

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
    requestRename,
    requestDelete,
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
  }
}

export type AppController = ReturnType<typeof useAppController>
