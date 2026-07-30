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
