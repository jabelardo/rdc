import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { IMenu } from './models/app-menu'

const installApplicationMenu = vi.hoisted(() => vi.fn())
const replaceApplicationMenu = vi.hoisted(() => vi.fn())
const showContextualMenu = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())
const showFolderContents = vi.hoisted(() => vi.fn())
const getMainProcessConfig = vi.hoisted(() => vi.fn())
const launchExternalEditor = vi.hoisted(() => vi.fn())
const launchShell = vi.hoisted(() => vi.fn())
const onNativeThemeUpdated = vi.hoisted(() => vi.fn())
const sendReady = vi.hoisted(() => vi.fn())
const setWindowTitle = vi.hoisted(() => vi.fn())
const openRepositoryInNewWindow = vi.hoisted(() => vi.fn())
const startWindowDragging = vi.hoisted(() => vi.fn())
const maximizeWindow = vi.hoisted(() => vi.fn())
const minimizeWindow = vi.hoisted(() => vi.fn())
const restoreWindow = vi.hoisted(() => vi.fn())
const isWindowMaximized = vi.hoisted(() => vi.fn())
const getAppleActionOnDoubleClick = vi.hoisted(() => vi.fn())
const installDefaultCloseRequestHandler = vi.hoisted(() => vi.fn())
const appStore = vi.hoisted(() => ({
  state: {
    repositories: [] as Array<{ id: number; name: string; path: string }>,
    selectedRepository: null as {
      id: number
      name: string
      path: string
    } | null,
  },
  load: vi.fn(),
  addRepository: vi.fn(),
  removeRepository: vi.fn(),
  selectRepository: vi.fn(),
  onDidUpdate: vi.fn(),
}))
const workingTreeStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    workingDirectory: null as {
      files: ReadonlyArray<{
        id: string
        path: string
        status: { kind: string }
        isIncludedInCommit: () => boolean
        selection?: { isSelected: (line: number) => boolean }
      }>
    } | null,
    selectedFileID: null as string | null,
    diff: null as {
      kind: number
      text?: string
      hunks?: ReadonlyArray<{
        unifiedDiffStart: number
        lines: ReadonlyArray<{
          text: string
          type?: number
          content: string
          oldLineNumber: number | null
          newLineNumber: number | null
          isIncludeableLine: () => boolean
        }>
      }>
    } | null,
    diffLoading: false,
    diffError: null as string | null,
    commitLoading: false,
    commitError: null as string | null,
    hookFailure: null as {
      hook: string
      terminalOutput: string
    } | null,
    loading: false,
    error: null as string | null,
  },
  load: vi.fn(),
  selectFile: vi.fn(),
  setFileIncluded: vi.fn(),
  setLineIncluded: vi.fn(),
  discardFile: vi.fn(),
  getSelectedLinesDiscard: vi.fn(),
  discardSelectedLines: vi.fn(),
  commit: vi.fn(),
  resolveHookFailure: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
  onCommitTerminalOutput: vi.fn(),
}))
const historyStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    commits: [] as ReadonlyArray<{
      sha: string
      shortSha: string
      summary: string
      body: string
      bodyNoCoAuthors: string
      author: { name: string; email: string; date: Date }
      committer: { name: string; email: string; date: Date }
      parentSHAs: ReadonlyArray<string>
      tags: ReadonlyArray<string>
    }>,
    selectedCommitSHA: null as string | null,
    changeset: null as {
      files: ReadonlyArray<{
        id: string
        path: string
        status: { kind: string }
      }>
      linesAdded: number
      linesDeleted: number
    } | null,
    selectedFileID: null as string | null,
    loading: false,
    error: null as string | null,
    detailsLoading: false,
    detailsError: null as string | null,
    diff: null as {
      kind: number
      text?: string
      hunks?: ReadonlyArray<{
        unifiedDiffStart: number
        lines: ReadonlyArray<{
          text: string
          type?: number
          oldLineNumber: number | null
          newLineNumber: number | null
        }>
      }>
    } | null,
    diffLoading: false,
    diffError: null as string | null,
  },
  load: vi.fn(),
  selectCommit: vi.fn(),
  selectFile: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
}))
const branchStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    branches: [] as ReadonlyArray<{
      name: string
      type: number
      tip: { sha: string }
    }>,
    currentBranch: null as string | null,
    loading: false,
    error: null as string | null,
    operation: null as 'creating' | 'checking-out' | null,
    progress: null as {
      description: string
      value: number
    } | null,
    operationError: null as string | null,
  },
  load: vi.fn(),
  createAndCheckout: vi.fn(),
  checkout: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
}))
const conflictStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    mergeInProgress: false,
    files: [] as ReadonlyArray<{
      path: string
      status: { kind: string; conflictMarkerCount?: number }
      resolvedInWorkingTree: boolean
    }>,
    loading: false,
    error: null as string | null,
    stagingPath: null as string | null,
    operationError: null as string | null,
  },
  load: vi.fn(),
  stageResolvedFile: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
}))
const preferencesStore = vi.hoisted(() => ({
  state: {
    theme: 'system' as 'light' | 'dark' | 'system',
    confirmRepositoryRemoval: true,
    confirmDiscardChanges: true,
    confirmDiscardChangesPermanently: true,
    selectedExternalEditor: 'Zed' as string | null,
    selectedShell: 'Ghostty' as string | null,
    editors: [{ editor: 'Zed', path: '/applications/zed' }],
    shells: [{ shell: 'Ghostty', path: '/applications/ghostty' }],
    loading: false,
    error: null as string | null,
  },
  selectedEditor: {
    editor: 'Zed',
    path: '/applications/zed',
  } as { editor: string; path: string } | null,
  selectedShell: {
    shell: 'Ghostty',
    path: '/applications/ghostty',
  } as { shell: string; path: string } | null,
  load: vi.fn(),
  refreshTheme: vi.fn(),
  setTheme: vi.fn(),
  setConfirmRepositoryRemoval: vi.fn(),
  setConfirmDiscardChanges: vi.fn(),
  setConfirmDiscardChangesPermanently: vi.fn(),
  setSelectedExternalEditor: vi.fn(),
  setSelectedShell: vi.fn(),
  onDidUpdate: vi.fn(),
}))

vi.mock('./lib/menu/application-menu', () => ({ installApplicationMenu }))
vi.mock('./lib/menu/context-menu', () => ({ showContextualMenu }))
vi.mock('./lib/platform/dialogs', () => ({ showOpenDialog }))
vi.mock('./lib/platform/config', () => ({ getMainProcessConfig }))
vi.mock('./lib/platform/files', () => ({ showFolderContents }))
vi.mock('./lib/platform/editors', () => ({ launchExternalEditor }))
vi.mock('./lib/platform/shells', () => ({ launchShell }))
vi.mock('./lib/platform/theme', () => ({ onNativeThemeUpdated }))
vi.mock('./lib/platform/lifetime', () => ({
  installDefaultCloseRequestHandler,
}))
vi.mock('./lib/platform/window', () => ({
  openRepositoryInNewWindow,
  sendReady,
  setWindowTitle,
  startWindowDragging,
  maximizeWindow,
  minimizeWindow,
  restoreWindow,
  isWindowMaximized,
}))
vi.mock('./lib/platform/system', () => ({ getAppleActionOnDoubleClick }))
vi.mock('./lib/stores/default-app-store', () => ({
  getDefaultAppStore: () => appStore,
}))
vi.mock('./lib/stores/default-working-tree-store', () => ({
  getDefaultWorkingTreeStore: () => workingTreeStore,
}))
vi.mock('./lib/stores/default-history-store', () => ({
  getDefaultHistoryStore: () => historyStore,
}))
vi.mock('./lib/stores/default-branch-store', () => ({
  getDefaultBranchStore: () => branchStore,
}))
vi.mock('./lib/stores/default-conflict-store', () => ({
  getDefaultConflictStore: () => conflictStore,
}))
vi.mock('./lib/stores/default-preferences-store', () => ({
  getDefaultPreferencesStore: () => preferencesStore,
}))

const repository = {
  id: 7,
  name: 'rdc',
  path: '/projects/rdc',
}

describe('App', () => {
  beforeEach(() => {
    installApplicationMenu.mockReset()
    replaceApplicationMenu.mockReset()
    replaceApplicationMenu.mockResolvedValue(undefined)
    installApplicationMenu.mockResolvedValue({
      dispose: vi.fn(),
      replaceMenu: replaceApplicationMenu,
    })
    showContextualMenu.mockReset()
    showContextualMenu.mockResolvedValue(undefined)
    showOpenDialog.mockReset()
    showOpenDialog.mockResolvedValue(null)
    showFolderContents.mockReset()
    showFolderContents.mockResolvedValue(undefined)
    getMainProcessConfig.mockReset()
    getMainProcessConfig.mockResolvedValue({
      titleBarStyle: 'native',
      hideWindowOnQuit: false,
    })
    launchExternalEditor.mockReset()
    launchExternalEditor.mockResolvedValue(undefined)
    launchShell.mockReset()
    launchShell.mockResolvedValue(undefined)
    onNativeThemeUpdated.mockReset()
    onNativeThemeUpdated.mockResolvedValue(vi.fn())
    sendReady.mockReset()
    sendReady.mockResolvedValue(null)
    setWindowTitle.mockReset()
    setWindowTitle.mockResolvedValue(undefined)
    openRepositoryInNewWindow.mockReset()
    openRepositoryInNewWindow.mockResolvedValue(undefined)
    startWindowDragging.mockReset()
    startWindowDragging.mockResolvedValue(undefined)
    maximizeWindow.mockReset()
    maximizeWindow.mockResolvedValue(undefined)
    minimizeWindow.mockReset()
    minimizeWindow.mockResolvedValue(undefined)
    restoreWindow.mockReset()
    restoreWindow.mockResolvedValue(undefined)
    isWindowMaximized.mockReset()
    isWindowMaximized.mockResolvedValue(false)
    getAppleActionOnDoubleClick.mockReset()
    getAppleActionOnDoubleClick.mockResolvedValue('Maximize')
    installDefaultCloseRequestHandler.mockReset()
    installDefaultCloseRequestHandler.mockResolvedValue(vi.fn())
    appStore.state = {
      repositories: [],
      selectedRepository: null,
    }
    appStore.load.mockReset()
    appStore.load.mockResolvedValue(undefined)
    appStore.addRepository.mockReset()
    appStore.addRepository.mockResolvedValue(undefined)
    appStore.removeRepository.mockReset()
    appStore.removeRepository.mockResolvedValue(undefined)
    appStore.selectRepository.mockReset()
    appStore.selectRepository.mockResolvedValue(undefined)
    appStore.onDidUpdate.mockReset()
    appStore.onDidUpdate.mockReturnValue(vi.fn())
    workingTreeStore.state = {
      repositoryPath: null,
      workingDirectory: null,
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    workingTreeStore.load.mockReset()
    workingTreeStore.load.mockResolvedValue(undefined)
    workingTreeStore.selectFile.mockReset()
    workingTreeStore.selectFile.mockResolvedValue(undefined)
    workingTreeStore.setFileIncluded.mockReset()
    workingTreeStore.setLineIncluded.mockReset()
    workingTreeStore.discardFile.mockReset()
    workingTreeStore.discardFile.mockResolvedValue('discarded')
    workingTreeStore.getSelectedLinesDiscard.mockReset()
    workingTreeStore.getSelectedLinesDiscard.mockReturnValue({
      repositoryPath: repository.path,
      filePath: 'Alpha.ts',
      diff: {},
      selectedLines: [1],
    })
    workingTreeStore.discardSelectedLines.mockReset()
    workingTreeStore.discardSelectedLines.mockResolvedValue(true)
    workingTreeStore.commit.mockReset()
    workingTreeStore.commit.mockResolvedValue(null)
    workingTreeStore.resolveHookFailure.mockReset()
    workingTreeStore.clear.mockReset()
    workingTreeStore.onDidUpdate.mockReset()
    workingTreeStore.onDidUpdate.mockReturnValue(vi.fn())
    workingTreeStore.onCommitTerminalOutput.mockReset()
    workingTreeStore.onCommitTerminalOutput.mockReturnValue(vi.fn())
    historyStore.state = {
      repositoryPath: null,
      commits: [],
      selectedCommitSHA: null,
      changeset: null,
      selectedFileID: null,
      loading: false,
      error: null,
      detailsLoading: false,
      detailsError: null,
      diff: null,
      diffLoading: false,
      diffError: null,
    }
    historyStore.load.mockReset()
    historyStore.load.mockResolvedValue(undefined)
    historyStore.selectCommit.mockReset()
    historyStore.selectCommit.mockResolvedValue(undefined)
    historyStore.selectFile.mockReset()
    historyStore.selectFile.mockResolvedValue(undefined)
    historyStore.clear.mockReset()
    historyStore.onDidUpdate.mockReset()
    historyStore.onDidUpdate.mockReturnValue(vi.fn())
    branchStore.state = {
      repositoryPath: null,
      branches: [],
      currentBranch: null,
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    }
    branchStore.load.mockReset()
    branchStore.load.mockResolvedValue(undefined)
    branchStore.createAndCheckout.mockReset()
    branchStore.createAndCheckout.mockResolvedValue(false)
    branchStore.checkout.mockReset()
    branchStore.checkout.mockResolvedValue(false)
    branchStore.clear.mockReset()
    branchStore.onDidUpdate.mockReset()
    branchStore.onDidUpdate.mockReturnValue(vi.fn())
    conflictStore.state = {
      repositoryPath: null,
      mergeInProgress: false,
      files: [],
      loading: false,
      error: null,
      stagingPath: null,
      operationError: null,
    }
    conflictStore.load.mockReset()
    conflictStore.load.mockResolvedValue(undefined)
    conflictStore.stageResolvedFile.mockReset()
    conflictStore.stageResolvedFile.mockResolvedValue(false)
    conflictStore.clear.mockReset()
    conflictStore.onDidUpdate.mockReset()
    conflictStore.onDidUpdate.mockReturnValue(vi.fn())
    preferencesStore.state = {
      theme: 'system',
      confirmRepositoryRemoval: true,
      confirmDiscardChanges: true,
      confirmDiscardChangesPermanently: true,
      selectedExternalEditor: 'Zed',
      selectedShell: 'Ghostty',
      editors: [{ editor: 'Zed', path: '/applications/zed' }],
      shells: [{ shell: 'Ghostty', path: '/applications/ghostty' }],
      loading: false,
      error: null,
    }
    preferencesStore.selectedEditor = {
      editor: 'Zed',
      path: '/applications/zed',
    }
    preferencesStore.selectedShell = {
      shell: 'Ghostty',
      path: '/applications/ghostty',
    }
    preferencesStore.load.mockReset()
    preferencesStore.load.mockResolvedValue(undefined)
    preferencesStore.refreshTheme.mockReset()
    preferencesStore.refreshTheme.mockResolvedValue(undefined)
    preferencesStore.setTheme.mockReset()
    preferencesStore.setTheme.mockResolvedValue(undefined)
    preferencesStore.setConfirmRepositoryRemoval.mockReset()
    preferencesStore.setConfirmDiscardChanges.mockReset()
    preferencesStore.setConfirmDiscardChangesPermanently.mockReset()
    preferencesStore.setSelectedExternalEditor.mockReset()
    preferencesStore.setSelectedShell.mockReset()
    preferencesStore.onDidUpdate.mockReset()
    preferencesStore.onDidUpdate.mockReturnValue(vi.fn())
  })

  it('reports readiness and installs native lifetime handling', () => {
    render(<App />)

    expect(sendReady).toHaveBeenCalledWith(expect.any(Number))
    expect(installDefaultCloseRequestHandler).toHaveBeenCalledOnce()
  })

  it('provides caught drag and double-click chrome when the native frame is overlaid', async () => {
    render(<App />)

    await vi.waitFor(() => {
      expect(document.querySelector('.window-drag-region') !== null).toBe(
        !__LINUX__
      )
    })
    const dragRegion = document.querySelector('.window-drag-region')
    expect(dragRegion?.querySelector('button')).toBeFalsy()
    if (dragRegion !== null) {
      fireEvent.mouseDown(dragRegion, { button: 0, detail: 1 })
      fireEvent.doubleClick(dragRegion)
      await vi.waitFor(() => {
        expect(startWindowDragging).toHaveBeenCalledOnce()
        expect(maximizeWindow).toHaveBeenCalledOnce()
      })
    }
  })

  it('installs the repository-derived application menu', () => {
    render(<App />)

    const configuration = installApplicationMenu.mock.calls[0][0]
    const initialMenu = configuration.initialMenu as IMenu
    const items = initialMenu.items.flatMap(item =>
      item.type === 'submenuItem' ? [item, ...item.menu.items] : [item]
    )
    expect(
      items.find(item => item.id === 'add-local-repository')
    ).toMatchObject({ enabled: true })
    expect(items.find(item => item.id === 'remove-repository')).toMatchObject({
      enabled: false,
    })
    expect(items.find(item => item.id === 'preferences')).toMatchObject({
      enabled: true,
    })
  })

  it('opens preferences from the native menu and updates MVP settings', async () => {
    const user = userEvent.setup()
    render(<App />)
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0]

    await act(() => executeMenuEvent('show-preferences'))

    expect(
      screen.getByRole('dialog', { name: 'Preferences' })
    ).toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Theme' }),
      'dark'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'External editor' }),
      'Zed'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Shell' }),
      'Ghostty'
    )
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Removing a repository from rdc',
      })
    )

    expect(preferencesStore.setTheme).toHaveBeenCalledWith('dark')
    expect(preferencesStore.setSelectedExternalEditor).toHaveBeenCalledWith(
      'Zed'
    )
    expect(preferencesStore.setSelectedShell).toHaveBeenCalledWith('Ghostty')
    expect(preferencesStore.setConfirmRepositoryRemoval).toHaveBeenCalledWith(
      false
    )
  })

  it('dismisses a safe modal with Escape and restores focus', async () => {
    const user = userEvent.setup()
    render(<App />)
    const [opener] = screen.getAllByRole('button', {
      name: 'Clone repository',
    })

    await user.click(opener)
    expect(
      screen.getByRole('textbox', { name: 'Repository URL' })
    ).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(
      screen.queryByRole('dialog', { name: 'Clone a repository' })
    ).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('opens an rdc About surface from the native menu', async () => {
    const user = userEvent.setup()
    render(<App />)
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0]

    await act(() => executeMenuEvent('show-about'))

    expect(screen.getByRole('dialog', { name: 'About rdc' })).toHaveTextContent(
      `Version ${__APP_VERSION__}`
    )
    expect(
      screen.getByText('A native Git client built with Tauri and Rust.')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(
      screen.queryByRole('dialog', { name: 'About rdc' })
    ).not.toBeInTheDocument()
  })

  it('launches the preferred editor and shell from native menu actions', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    const user = userEvent.setup()
    render(<App />)
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0]

    await executeMenuEvent('open-in-shell')
    await executeMenuEvent('open-external-editor')

    expect(launchShell).toHaveBeenCalledWith(
      preferencesStore.selectedShell,
      repository.path
    )
    expect(launchExternalEditor).toHaveBeenCalledWith(
      repository.path,
      preferencesStore.selectedEditor
    )

    await user.click(screen.getByRole('button', { name: 'Open in terminal' }))
    await user.click(screen.getByRole('button', { name: 'Open in editor' }))
    await user.click(screen.getByRole('button', { name: 'Show files' }))

    expect(launchShell).toHaveBeenCalledTimes(2)
    expect(launchExternalEditor).toHaveBeenCalledTimes(2)
    expect(showFolderContents).toHaveBeenCalledWith(repository.path)
  })

  it('shows a product empty state instead of the integration harness', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'Add a repository to get started' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/native integration harness/i)
    ).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText(/path\/to\/a\/git\/repository/i)
    ).not.toBeInTheDocument()
  })

  it('renders only backed sidebar panels and collapses them independently', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(
      screen.getByRole('button', { name: 'Repositories' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Branches' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(
      screen.queryByRole('button', { name: 'Tags' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Stashes')).not.toBeInTheDocument()
    expect(screen.queryByText('Submodules')).not.toBeInTheDocument()
    expect(screen.queryByText('Subtrees')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Repositories' }))
    expect(
      screen.getByRole('button', { name: 'Repositories' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'Repositories' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(
      screen.getByRole('button', { name: 'Expand sidebar' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('button', { name: 'Branches' })
    ).not.toBeInTheDocument()
  })

  it('places live branch selection in the Branches sidebar panel', () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    branchStore.state = {
      repositoryPath: repository.path,
      branches: [
        {
          name: 'main',
          type: 0,
          tip: { sha: 'a'.repeat(40) },
        },
      ],
      currentBranch: 'main',
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    }

    render(<App />)

    const panel = screen.getByRole('region', { name: 'Branches' })
    expect(panel).toContainElement(
      screen.getByRole('combobox', { name: 'Current branch' })
    )
    expect(
      screen.getByRole('form', { name: 'Create branch' })
    ).toBeInTheDocument()
    expect(setWindowTitle).toHaveBeenLastCalledWith('rdc — rdc — main')
    const toolbar = screen.getByRole('toolbar', {
      name: 'Repository actions',
    })
    expect(toolbar).toContainElement(
      screen.getByRole('button', { name: 'Open in new window' })
    )
    expect(toolbar).toContainElement(
      screen.getByRole('button', { name: 'Show files' })
    )
    expect(toolbar).toContainElement(
      screen.getByRole('button', { name: 'Open in editor' })
    )
    expect(toolbar).toContainElement(
      screen.getByRole('button', { name: 'Open in terminal' })
    )
    expect(toolbar).toContainElement(
      screen.getByRole('region', {
        name: 'Remote synchronization',
      })
    )
    expect(toolbar).not.toContainElement(
      screen.getByRole('combobox', { name: 'Current branch' })
    )
  })

  it('adds the directory selected by the native dialog', async () => {
    showOpenDialog.mockResolvedValue('/repo')
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getAllByRole('button', {
        name: /add existing repository/i,
      })[0]
    )

    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Choose a repository directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    expect(appStore.addRepository).toHaveBeenCalledWith('/repo')
  })

  it('does nothing when the native directory dialog is dismissed', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getAllByRole('button', {
        name: /add existing repository/i,
      })[0]
    )

    expect(appStore.addRepository).not.toHaveBeenCalled()
  })

  it('consumes a startup repository action without diagnostic output', async () => {
    sendReady.mockResolvedValue({
      kind: 'open-repository',
      path: '/repo/../repo',
      persistSelection: false,
    })

    render(<App />)

    await vi.waitFor(() => {
      expect(appStore.addRepository).toHaveBeenCalledWith(
        '/repo/../repo',
        false
      )
    })
    expect(screen.queryByText(/persist selection/i)).not.toBeInTheDocument()
  })

  it('renders store updates and selects a repository from the sidebar', async () => {
    const user = userEvent.setup()
    render(<App />)

    act(() => {
      for (const [update] of appStore.onDidUpdate.mock.calls) {
        update({
          repositories: [repository],
          selectedRepository: null,
        })
      }
    })
    await user.click(screen.getByRole('button', { name: 'Select rdc' }))

    expect(screen.getByText('/projects/rdc')).toBeInTheDocument()
    expect(appStore.selectRepository).toHaveBeenCalledWith(repository)
  })

  it('navigates repository selection with arrows, Home and End', async () => {
    const secondRepository = {
      id: 8,
      name: 'desktop-plus',
      path: '/projects/desktop-plus',
    }
    appStore.state = {
      repositories: [repository, secondRepository],
      selectedRepository: repository,
    }
    const user = userEvent.setup()
    render(<App />)
    const first = screen.getByRole('button', { name: 'Select rdc' })
    const second = screen.getByRole('button', {
      name: 'Select desktop-plus',
    })

    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(appStore.selectRepository).toHaveBeenLastCalledWith(secondRepository)
    expect(second).toHaveFocus()

    await user.keyboard('{Home}')
    expect(appStore.selectRepository).toHaveBeenLastCalledWith(repository)
    expect(first).toHaveFocus()

    await user.keyboard('{End}')
    expect(appStore.selectRepository).toHaveBeenLastCalledWith(secondRepository)
    expect(second).toHaveFocus()
  })

  it('renders a selected-repository workspace with a window action', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    const user = userEvent.setup()

    render(<App />)

    expect(
      screen.getByRole('heading', { name: repository.name, level: 2 })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Selected repository' })
    ).toHaveTextContent(repository.path)
    await user.click(screen.getByRole('button', { name: 'Open in new window' }))
    expect(openRepositoryInNewWindow).toHaveBeenCalledWith(repository.path)
    expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path)
    expect(branchStore.load).toHaveBeenCalledWith(repository.path)
    expect(conflictStore.load).toHaveBeenCalledWith(repository.path)
  })

  it('lists branches, checks out a local branch, and creates from HEAD', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    branchStore.state = {
      repositoryPath: repository.path,
      branches: [
        {
          name: 'main',
          type: 0,
          tip: { sha: 'a'.repeat(40) },
        },
        {
          name: 'topic',
          type: 0,
          tip: { sha: 'b'.repeat(40) },
        },
        {
          name: 'origin/main',
          type: 1,
          tip: { sha: 'a'.repeat(40) },
        },
      ],
      currentBranch: 'main',
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    }
    branchStore.checkout.mockResolvedValue(true)
    branchStore.createAndCheckout.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<App />)

    const selector = screen.getByRole('combobox', {
      name: 'Current branch',
    })
    expect(selector).toHaveTextContent('main')
    expect(selector).toHaveTextContent('topic')
    expect(selector).toHaveTextContent('origin/main (remote)')
    await user.selectOptions(selector, 'topic')

    expect(branchStore.checkout).toHaveBeenCalledWith('topic')
    expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path)

    await user.type(
      screen.getByRole('textbox', { name: 'New branch name' }),
      'feature'
    )
    await user.click(screen.getByRole('button', { name: 'Create branch' }))

    expect(branchStore.createAndCheckout).toHaveBeenCalledWith('feature')
  })

  it('shows merge conflicts and stages an externally resolved file', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    conflictStore.state = {
      repositoryPath: repository.path,
      mergeInProgress: true,
      files: [
        {
          path: 'resolved.txt',
          status: { kind: 'Conflicted', conflictMarkerCount: 0 },
          resolvedInWorkingTree: true,
        },
        {
          path: 'unresolved.txt',
          status: { kind: 'Conflicted', conflictMarkerCount: 2 },
          resolvedInWorkingTree: false,
        },
      ],
      loading: false,
      error: null,
      stagingPath: null,
      operationError: null,
    }
    conflictStore.stageResolvedFile.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<App />)

    const conflicts = screen.getByRole('region', {
      name: 'Merge conflicts',
    })
    expect(conflicts).toHaveTextContent('Merge in progress')
    expect(conflicts).toHaveTextContent('resolved.txtResolved')
    expect(conflicts).toHaveTextContent('unresolved.txt2 conflict markers')
    expect(
      screen.getByRole('button', {
        name: 'Stage resolution for unresolved.txt',
      })
    ).toBeDisabled()

    await user.click(
      screen.getByRole('button', {
        name: 'Stage resolution for resolved.txt',
      })
    )
    expect(conflictStore.stageResolvedFile).toHaveBeenCalledWith('resolved.txt')
    expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path)

    await user.click(
      screen.getByRole('button', {
        name: 'Refresh conflict state',
      })
    )
    expect(conflictStore.load).toHaveBeenCalledWith(repository.path)
  })

  it('loads and renders the selected repository history on demand', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    historyStore.state = {
      repositoryPath: repository.path,
      commits: [
        {
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          summary: 'Start Phase 7c',
          body: 'Render selected commit details.',
          bodyNoCoAuthors: 'Render selected commit details.',
          author: {
            name: 'Mona Lisa',
            email: 'mona@example.com',
            date: new Date('2026-07-30T12:00:00Z'),
          },
          committer: {
            name: 'Mona Lisa',
            email: 'mona@example.com',
            date: new Date('2026-07-30T12:00:00Z'),
          },
          parentSHAs: ['b'.repeat(40)],
          tags: ['phase-7c'],
        },
      ],
      selectedCommitSHA: 'a'.repeat(40),
      changeset: {
        files: [
          {
            id: 'Modified+src/App.tsx',
            path: 'src/App.tsx',
            status: { kind: 'Modified' },
          },
        ],
        linesAdded: 7,
        linesDeleted: 2,
      },
      selectedFileID: 'Modified+src/App.tsx',
      loading: false,
      error: null,
      detailsLoading: false,
      detailsError: null,
      diff: {
        kind: 0,
        text: 'diff',
        hunks: [
          {
            unifiedDiffStart: 4,
            lines: [
              {
                text: '+selected commit diff',
                type: 1,
                oldLineNumber: null,
                newLineNumber: 12,
              },
            ],
          },
        ],
      },
      diffLoading: false,
      diffError: null,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'History' }))

    expect(historyStore.load).toHaveBeenCalledWith(repository.path)
    const history = screen.getByRole('region', { name: 'History' })
    expect(history.querySelector('.history-list-pane')).not.toBeNull()
    expect(
      screen
        .getByRole('region', { name: 'Selected commit details' })
        .closest('.history')
    ).toBe(history)
    expect(history).toHaveTextContent('aaaaaaaStart Phase 7cMona Lisa')
    expect(history).toHaveTextContent('Render selected commit details.')
    expect(history).toHaveTextContent('1 changed file+7−2')
    expect(history).toHaveTextContent('src/App.tsxModified')
    expect(history).toHaveTextContent('+selected commit diff')
    expect(screen.getByRole('button', { name: 'src/App.tsx' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('renders working-tree updates in frontend-owned order', () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    render(<App />)

    act(() => {
      for (const [update] of workingTreeStore.onDidUpdate.mock.calls) {
        update({
          repositoryPath: repository.path,
          workingDirectory: {
            files: [
              {
                id: 'Modified+Alpha.ts',
                path: 'Alpha.ts',
                status: { kind: 'Modified' },
                isIncludedInCommit: () => true,
                selection: { isSelected: () => true },
              },
              {
                id: 'Untracked+zeta.ts',
                path: 'zeta.ts',
                status: { kind: 'Untracked' },
                isIncludedInCommit: () => true,
                selection: { isSelected: () => true },
              },
            ],
          },
          selectedFileID: 'Modified+Alpha.ts',
          diff: {
            kind: 0,
            text: '@@ -1 +1 @@\n-before\n+after',
            hunks: [
              {
                unifiedDiffStart: 0,
                lines: [
                  {
                    text: '@@ -1 +1 @@',
                    content: '@ -1 +1 @@',
                    oldLineNumber: null,
                    newLineNumber: null,
                    isIncludeableLine: () => false,
                  },
                  {
                    text: '-before',
                    content: 'before',
                    oldLineNumber: 1,
                    newLineNumber: null,
                    isIncludeableLine: () => true,
                  },
                  {
                    text: '+after',
                    content: 'after',
                    oldLineNumber: null,
                    newLineNumber: 1,
                    isIncludeableLine: () => true,
                  },
                ],
              },
            ],
          },
          diffLoading: false,
          diffError: null,
          commitLoading: false,
          commitError: null,
          hookFailure: null,
          loading: false,
          error: null,
        })
      }
    })

    expect(screen.getByRole('region', { name: 'Changes' })).toHaveTextContent(
      'Alpha.tsModifiedDiscardzeta.tsNewDiscard'
    )
    expect(screen.getByRole('region', { name: 'File diff' })).toHaveTextContent(
      /-before.*\+after/
    )
  })

  it('loads the diff for a changed file selected in the shell', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Alpha.tsModified' }))

    expect(workingTreeStore.selectFile).toHaveBeenCalledWith(
      'Modified+Alpha.ts'
    )
  })

  it('navigates changed files with the same keyboard contract', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
          {
            id: 'Untracked+Beta.ts',
            path: 'Beta.ts',
            status: { kind: 'Untracked' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)
    const first = screen.getByRole('button', {
      name: 'Alpha.tsModified',
    })
    const second = screen.getByRole('button', {
      name: 'Beta.tsNew',
    })

    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(workingTreeStore.selectFile).toHaveBeenLastCalledWith(
      'Untracked+Beta.ts'
    )
    expect(second).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(workingTreeStore.selectFile).toHaveBeenLastCalledWith(
      'Modified+Alpha.ts'
    )
    expect(first).toHaveFocus()
  })

  it('changes inclusion using the displayed unified-diff index', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => false,
            selection: { isSelected: line => line !== 2 },
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: {
        kind: 0,
        text: '@@ -0,0 +1,2 @@\n+first\n+second',
        hunks: [
          {
            unifiedDiffStart: 0,
            lines: [
              {
                text: '@@ -0,0 +1,2 @@',
                type: 3,
                content: '@ -0,0 +1,2 @@',
                oldLineNumber: null,
                newLineNumber: null,
                isIncludeableLine: () => false,
              },
              {
                text: '+first',
                type: 1,
                content: 'first',
                oldLineNumber: null,
                newLineNumber: 1,
                isIncludeableLine: () => true,
              },
              {
                text: '+second',
                type: 1,
                content: 'second',
                oldLineNumber: null,
                newLineNumber: 2,
                isIncludeableLine: () => true,
              },
            ],
          },
        ],
      },
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)

    const first = screen.getByRole('checkbox', {
      name: 'Include diff line 1: first',
    })
    const second = screen.getByRole('checkbox', {
      name: 'Include diff line 2: second',
    })
    expect(first).toBeChecked()
    expect(second).not.toBeChecked()
    const changes = screen
      .getByRole('region', { name: 'Changes' })
      .closest('.changes-workspace')
    expect(changes).toContainElement(
      screen.getByRole('region', { name: 'File diff' })
    )
    expect(changes).toContainElement(
      screen.getByRole('form', { name: 'Commit changes' })
    )
    expect(document.querySelectorAll('.diff-line-add')).toHaveLength(2)
    expect(document.querySelectorAll('.diff-line-hunk')).toHaveLength(1)

    await user.click(second)

    expect(workingTreeStore.setLineIncluded).toHaveBeenCalledWith(2, true)

    await user.click(
      screen.getByRole('button', { name: 'Discard selected lines' })
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Selected changes cannot be restored from the operating system trash.'
    )
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(workingTreeStore.discardSelectedLines).toHaveBeenCalledWith(
      workingTreeStore.getSelectedLinesDiscard.mock.results[0].value
    )
  })

  it('updates whole-file inclusion without staging eagerly', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('checkbox', { name: 'Include Alpha.ts' }))

    expect(workingTreeStore.setFileIncluded).toHaveBeenCalledWith(
      'Modified+Alpha.ts',
      false
    )
  })

  it('confirms before discarding a changed file', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Discard Alpha.ts' }))
    expect(workingTreeStore.discardFile).not.toHaveBeenCalled()
    expect(
      screen.getByRole('alertdialog', {
        name: 'Confirm discard changes',
      })
    ).toHaveTextContent(
      'Changes can be restored from the operating system trash.'
    )

    await user.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(workingTreeStore.discardFile).toHaveBeenCalledWith(
      'Modified+Alpha.ts',
      false
    )
    await vi.waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    )
  })

  it('discards immediately when file confirmation is disabled', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    preferencesStore.state.confirmDiscardChanges = false
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Discard Alpha.ts' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(workingTreeStore.discardFile).toHaveBeenCalledWith(
      'Modified+Alpha.ts',
      false
    )
  })

  it('cancels a discard without touching the working tree', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Untracked+notes.txt',
            path: 'notes.txt',
            status: { kind: 'Untracked' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Untracked+notes.txt',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Discard notes.txt' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(workingTreeStore.discardFile).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('requires a second warning before permanent deletion after trash fails', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Untracked+notes.txt',
            path: 'notes.txt',
            status: { kind: 'Untracked' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Untracked+notes.txt',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    workingTreeStore.discardFile
      .mockResolvedValueOnce('trash-failed')
      .mockResolvedValueOnce('discarded')
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Discard notes.txt' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(
      screen.getByRole('alertdialog', {
        name: 'Permanently discard changes',
      })
    ).toHaveTextContent('Changes cannot be restored after deletion.')

    await user.click(
      screen.getByRole('button', {
        name: 'Permanently discard changes',
      })
    )

    expect(workingTreeStore.discardFile.mock.calls).toEqual([
      ['Untracked+notes.txt', false],
      ['Untracked+notes.txt', true],
    ])
    await vi.waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    )
  })

  it('commits the frontend message and clears it after success', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    workingTreeStore.commit.mockResolvedValue('a'.repeat(40))
    const user = userEvent.setup()
    render(<App />)

    const message = screen.getByRole('textbox', {
      name: 'Commit message',
    })
    await user.type(message, 'Commit from rdc')
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Run hooks with the shell environment',
      })
    )
    await user.click(
      screen.getByRole('button', { name: 'Commit included files' })
    )

    expect(workingTreeStore.commit).toHaveBeenCalledWith(
      'Commit from rdc',
      true
    )
    await vi.waitFor(() => expect(message).toHaveValue(''))
  })

  it('offers abort and ignore when an intercepted hook fails', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    const user = userEvent.setup()
    render(<App />)
    const [listener] = workingTreeStore.onDidUpdate.mock.calls[0]

    act(() =>
      listener({
        ...workingTreeStore.state,
        hookFailure: {
          hook: 'pre-commit',
          terminalOutput: 'lint failed',
        },
        commitLoading: true,
      })
    )

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('pre-commit')
    expect(dialog).toHaveTextContent('lint failed')
    expect(
      screen.getByRole('button', { name: 'Abort commit' })
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Ignore hook failure' })
    )
    expect(workingTreeStore.resolveHookFailure).toHaveBeenCalledWith('ignore')
  })

  it('shows live commit terminal output and clears it with the buffer', () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: 'Modified+Alpha.ts',
            path: 'Alpha.ts',
            status: { kind: 'Modified' },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: 'Modified+Alpha.ts',
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: true,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    }
    render(<App />)
    const [listener] = workingTreeStore.onCommitTerminalOutput.mock.calls[0]

    act(() => listener('running pre-commit hook'))

    expect(screen.getByLabelText('Commit terminal output')).toHaveTextContent(
      'running pre-commit hook'
    )

    act(() => listener(''))

    expect(
      screen.queryByLabelText('Commit terminal output')
    ).not.toBeInTheDocument()
  })

  it('opens a repository contextual menu on secondary click', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    const user = userEvent.setup()
    render(<App />)

    await user.pointer({
      target: screen.getByRole('button', { name: 'Select rdc' }),
      keys: '[MouseRight]',
    })

    expect(showContextualMenu).toHaveBeenCalledOnce()
    expect(showContextualMenu.mock.calls[0][0]).toMatchObject([
      { label: 'Open in New Window' },
      { label: 'Show in File Manager' },
      { type: 'separator' },
      { label: 'Remove' },
    ])
  })

  it('routes contextual repository actions through the owning seams', async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    }
    showContextualMenu.mockImplementation(async items => {
      items[0].action()
      items[1].action()
      items[3].action()
    })
    const user = userEvent.setup()
    render(<App />)

    await user.pointer({
      target: screen.getByRole('button', { name: 'Select rdc' }),
      keys: '[MouseRight]',
    })

    expect(openRepositoryInNewWindow).toHaveBeenCalledWith(repository.path)
    expect(showFolderContents).toHaveBeenCalledWith(repository.path)
    expect(
      screen.getByRole('alertdialog', { name: 'Remove repository' })
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove repository' }))
    expect(appStore.removeRepository).toHaveBeenCalledWith(repository)
  })
})
