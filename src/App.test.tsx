import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { IMenu } from './models/app-menu'

const installApplicationMenu = vi.hoisted(() => vi.fn())
const replaceApplicationMenu = vi.hoisted(() => vi.fn())
const showContextualMenu = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())
const showFolderContents = vi.hoisted(() => vi.fn())
const sendReady = vi.hoisted(() => vi.fn())
const openRepositoryInNewWindow = vi.hoisted(() => vi.fn())
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
    diff: null as
      | {
          kind: number
          text?: string
          hunks?: ReadonlyArray<{
            unifiedDiffStart: number
            lines: ReadonlyArray<{
              text: string
              content: string
              oldLineNumber: number | null
              newLineNumber: number | null
              isIncludeableLine: () => boolean
            }>
          }>
        }
      | null,
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
  discardSelectedLines: vi.fn(),
  commit: vi.fn(),
  resolveHookFailure: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
  onCommitTerminalOutput: vi.fn(),
}))

vi.mock('./lib/menu/application-menu', () => ({ installApplicationMenu }))
vi.mock('./lib/menu/context-menu', () => ({ showContextualMenu }))
vi.mock('./lib/platform/dialogs', () => ({ showOpenDialog }))
vi.mock('./lib/platform/files', () => ({ showFolderContents }))
vi.mock('./lib/platform/lifetime', () => ({
  installDefaultCloseRequestHandler,
}))
vi.mock('./lib/platform/window', () => ({
  openRepositoryInNewWindow,
  sendReady,
}))
vi.mock('./lib/stores/default-app-store', () => ({
  getDefaultAppStore: () => appStore,
}))
vi.mock('./lib/stores/default-working-tree-store', () => ({
  getDefaultWorkingTreeStore: () => workingTreeStore,
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
    sendReady.mockReset()
    sendReady.mockResolvedValue(null)
    openRepositoryInNewWindow.mockReset()
    openRepositoryInNewWindow.mockResolvedValue(undefined)
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
  })

  it('reports readiness and installs native lifetime handling', () => {
    render(<App />)

    expect(sendReady).toHaveBeenCalledWith(expect.any(Number))
    expect(installDefaultCloseRequestHandler).toHaveBeenCalledOnce()
  })

  it('installs the repository-derived application menu', () => {
    render(<App />)

    const configuration = installApplicationMenu.mock.calls[0][0]
    const initialMenu = configuration.initialMenu as IMenu
    const items = initialMenu.items.flatMap(item =>
      item.type === 'submenuItem' ? [item, ...item.menu.items] : [item]
    )
    expect(items.find(item => item.id === 'add-local-repository')).toMatchObject(
      { enabled: true }
    )
    expect(items.find(item => item.id === 'remove-repository')).toMatchObject({
      enabled: false,
    })
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
    await user.click(
      screen.getByRole('button', { name: 'Select rdc' })
    )

    expect(screen.getByText('/projects/rdc')).toBeInTheDocument()
    expect(appStore.selectRepository).toHaveBeenCalledWith(repository)
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
    await user.click(
      screen.getByRole('button', { name: 'Open in new window' })
    )
    expect(openRepositoryInNewWindow).toHaveBeenCalledWith(repository.path)
    expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path)
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

    expect(
      screen.getByRole('region', { name: 'Changes' })
    ).toHaveTextContent(
      'Alpha.tsModifiedDiscardzeta.tsNewDiscard'
    )
    expect(
      screen.getByRole('region', { name: 'File diff' })
    ).toHaveTextContent(/-before.*\+after/)
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

    await user.click(
      screen.getByRole('button', { name: 'Alpha.tsModified' })
    )

    expect(workingTreeStore.selectFile).toHaveBeenCalledWith(
      'Modified+Alpha.ts'
    )
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
                content: '@ -0,0 +1,2 @@',
                oldLineNumber: null,
                newLineNumber: null,
                isIncludeableLine: () => false,
              },
              {
                text: '+first',
                content: 'first',
                oldLineNumber: null,
                newLineNumber: 1,
                isIncludeableLine: () => true,
              },
              {
                text: '+second',
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

    await user.click(second)

    expect(workingTreeStore.setLineIncluded).toHaveBeenCalledWith(
      2,
      true
    )

    await user.click(
      screen.getByRole('button', { name: 'Discard selected lines' })
    )
    expect(
      screen.getByRole('alertdialog')
    ).toHaveTextContent(
      'Selected changes cannot be restored from the operating system trash.'
    )
    await user.click(
      screen.getByRole('button', { name: 'Discard changes' })
    )
    expect(
      workingTreeStore.discardSelectedLines
    ).toHaveBeenCalledOnce()
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

    await user.click(
      screen.getByRole('checkbox', { name: 'Include Alpha.ts' })
    )

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

    await user.click(
      screen.getByRole('button', { name: 'Discard Alpha.ts' })
    )
    expect(workingTreeStore.discardFile).not.toHaveBeenCalled()
    expect(
      screen.getByRole('alertdialog', {
        name: 'Confirm discard changes',
      })
    ).toHaveTextContent(
      'Changes can be restored from the operating system trash.'
    )

    await user.click(
      screen.getByRole('button', { name: 'Discard changes' })
    )

    expect(workingTreeStore.discardFile).toHaveBeenCalledWith(
      'Modified+Alpha.ts',
      false
    )
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('alertdialog')
      ).not.toBeInTheDocument()
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

    await user.click(
      screen.getByRole('button', { name: 'Discard notes.txt' })
    )
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

    await user.click(
      screen.getByRole('button', { name: 'Discard notes.txt' })
    )
    await user.click(
      screen.getByRole('button', { name: 'Discard changes' })
    )

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
    expect(
      workingTreeStore.resolveHookFailure
    ).toHaveBeenCalledWith('ignore')
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
    const [listener] =
      workingTreeStore.onCommitTerminalOutput.mock.calls[0]

    act(() => listener('running pre-commit hook'))

    expect(
      screen.getByLabelText('Commit terminal output')
    ).toHaveTextContent('running pre-commit hook')

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
    expect(appStore.removeRepository).toHaveBeenCalledWith(repository)
  })
})
