import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MenuBar, parseAccessKeyLabel, type MenuBarProps } from './menu-bar'

const openUrl = vi.hoisted(() => vi.fn())
const quitApp = vi.hoisted(() => vi.fn())
const selectAllWindowContents = vi.hoisted(() => vi.fn())
const getCurrentWindowZoomFactor = vi.hoisted(() => vi.fn())
const setWindowZoomFactor = vi.hoisted(() => vi.fn())
const toggleDevTools = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))
vi.mock('../../platform/lifetime', () => ({ quitApp }))
vi.mock('../../platform/menu', () => ({ selectAllWindowContents }))
vi.mock('../../platform/window', () => ({
  getCurrentWindowZoomFactor,
  setWindowZoomFactor,
  toggleDevTools,
}))

function baseProps(overrides: Partial<MenuBarProps> = {}): MenuBarProps {
  return {
    onCreateRepository: vi.fn(),
    onAddExistingRepository: vi.fn(),
    onCloneRepository: vi.fn(),
    onShowPreferences: vi.fn(),
    onShowAbout: vi.fn(),
    onSelectView: vi.fn(),
    onOpenNewWindow: vi.fn(),
    onShowRepositoryList: vi.fn(),
    onShowBranchesList: vi.fn(),
    onGoToCommitMessage: vi.fn(),
    onExpandSidebar: vi.fn(),
    onContractSidebar: vi.fn(),
    onShowFiles: vi.fn(),
    onOpenEditor: vi.fn(),
    onOpenShell: vi.fn(),
    onFetch: vi.fn(),
    onPush: vi.fn(),
    onPull: vi.fn(),
    onManageRemotes: vi.fn(),
    onRemoveRepository: vi.fn(),
    onNewBranch: vi.fn(),
    onRenameBranch: vi.fn(),
    onDeleteBranch: vi.fn(),
    onMergeBranch: vi.fn(),
    onDiscardAll: vi.fn(),
    onShowLogs: vi.fn(),
    hasRepository: true,
    hasRepositories: true,
    hasEditor: true,
    hasShell: true,
    canFetch: true,
    canPush: true,
    canPull: true,
    canCreateBranch: true,
    canRenameBranch: true,
    canDeleteBranch: true,
    canMergeBranch: true,
    canDiscardAll: true,
    selectedShell: 'Ghostty',
    selectedEditor: 'Zed',
    isDevelopment: false,
    ...overrides,
  }
}

async function openMenu(name: string): Promise<HTMLElement> {
  // jsdom has no layout, so an open portal dropdown sits at the origin and can
  // intercept pointer hit-testing; the real dropdown renders below the bar and
  // never covers the triggers. Close any open menu first and disable
  // hit-testing so events target the trigger directly.
  const existing = screen.queryByRole('menu')
  if (existing !== null) {
    fireEvent.keyDown(existing, { key: 'Escape' })
  }
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  await user.click(screen.getByRole('menuitem', { name }))
  return screen.getByRole('menu')
}

describe('access key labels', () => {
  it('splits a mnemonic from its label', () => {
    expect(parseAccessKeyLabel('New &repository…')).toEqual({
      before: 'New ',
      accessKey: 'r',
      after: 'epository…',
    })
    expect(parseAccessKeyLabel('Open new window')).toEqual({
      before: 'Open new window',
      accessKey: null,
      after: '',
    })
    expect(parseAccessKeyLabel('E&xit')).toEqual({
      before: 'E',
      accessKey: 'x',
      after: 'it',
    })
  })
})

describe('menu bar inventory', () => {
  it('renders the six MVP baseline menus', () => {
    render(<MenuBar {...baseProps()} />)
    for (const name of [
      'File',
      'Edit',
      'View',
      'Repository',
      'Branch',
      'Help',
    ]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
    }
    // The baseline has no top-level menus beyond these six.
    expect(screen.getAllByRole('menuitem')).toHaveLength(6)
  })

  it('renders the baseline File menu with accelerators', async () => {
    render(<MenuBar {...baseProps()} />)
    const menu = await openMenu('File')
    const names = within(menu)
      .getAllByRole('menuitem')
      .map(item => item.getAttribute('aria-label'))
    expect(names).toEqual([
      'New repository…',
      'Open new window',
      'Add local repository…',
      'Clone repository…',
      'Options…',
      'Exit',
    ])
    expect(
      within(menu).getByRole('menuitem', { name: 'New repository…' })
    ).toHaveTextContent('Ctrl+N')
    expect(
      within(menu).getByRole('menuitem', { name: 'Open new window' })
    ).toHaveTextContent('Ctrl+Alt+N')
  })

  it('renders the baseline Edit menu roles with native accelerators', async () => {
    render(<MenuBar {...baseProps()} />)
    const menu = await openMenu('Edit')
    const names = within(menu)
      .getAllByRole('menuitem')
      .map(item => item.getAttribute('aria-label'))
    expect(names).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ])
    const hint = (name: string) => within(menu).getByRole('menuitem', { name })
    expect(hint('Undo')).toHaveTextContent('Ctrl+Z')
    expect(hint('Redo')).toHaveTextContent('Ctrl+Y')
    expect(hint('Cut')).toHaveTextContent('Ctrl+X')
    expect(hint('Copy')).toHaveTextContent('Ctrl+C')
    expect(hint('Paste')).toHaveTextContent('Ctrl+V')
    expect(hint('Select all')).toHaveTextContent('Ctrl+A')
  })

  it('renders the baseline View menu including wiring-gap items', async () => {
    render(<MenuBar {...baseProps()} />)
    const menu = await openMenu('View')
    const names = within(menu)
      .getAllByRole('menuitem')
      .map(item => item.getAttribute('aria-label'))
    expect(names).toEqual([
      'Changes',
      'History',
      'Repository list',
      'Branches list',
      'Go to Summary',
      'Reset zoom',
      'Zoom in',
      'Zoom out',
      'Expand active resizable',
      'Contract active resizable',
    ])
  })

  it('renders the baseline Repository menu with dynamic integration labels', async () => {
    render(<MenuBar {...baseProps()} />)
    const menu = await openMenu('Repository')
    const names = within(menu)
      .getAllByRole('menuitem')
      .map(item => item.getAttribute('aria-label'))
    expect(names).toEqual([
      'Push',
      'Pull',
      'Fetch',
      'Manage remotes…',
      'Remove…',
      'Open in Ghostty',
      'Show in your File Manager',
      'Open in Zed',
    ])
  })

  it('renders the Branch and baseline Help menus', async () => {
    render(<MenuBar {...baseProps()} />)
    const branchMenu = await openMenu('Branch')
    expect(
      within(branchMenu)
        .getAllByRole('menuitem')
        .map(item => item.getAttribute('aria-label'))
    ).toEqual([
      'New branch…',
      'Rename…',
      'Delete…',
      'Merge into current branch…',
      'Discard all changes…',
      'Permanently discard all changes…',
    ])
    await openMenu('Help')
    const helpMenu = screen.getByRole('menu')
    expect(
      within(helpMenu)
        .getAllByRole('menuitem')
        .map(item => item.getAttribute('aria-label'))
    ).toEqual([
      'Report issue…',
      'View RDC on GitHub',
      'Show logs in your File Manager',
      'About RDC',
    ])
  })

  it('underlines the access-key character of item labels', async () => {
    render(<MenuBar {...baseProps()} />)
    const menu = await openMenu('File')
    const item = within(menu).getByRole('menuitem', { name: 'New repository…' })
    const mnemonic = item.querySelector('u.app-menu-access-key')
    expect(mnemonic).not.toBeNull()
    expect(mnemonic).toHaveTextContent('r')
  })

  it('shows dev-only items only in development builds', async () => {
    const { rerender } = render(<MenuBar {...baseProps()} />)
    const dev = await openMenu('View')
    expect(within(dev).queryByRole('menuitem', { name: 'Reload' })).toBeNull()
    expect(
      within(dev).queryByRole('menuitem', { name: 'Toggle developer tools' })
    ).toBeNull()

    rerender(<MenuBar {...baseProps({ isDevelopment: true })} />)
    const devMenu = await openMenu('View')
    expect(
      within(devMenu).getByRole('menuitem', { name: 'Reload' })
    ).toHaveTextContent('Ctrl+Alt+R')
    expect(
      within(devMenu).getByRole('menuitem', { name: 'Toggle developer tools' })
    ).toHaveTextContent('Ctrl+Shift+I')
  })
})

describe('menu bar enablement', () => {
  it('disables repository-scoped items without a selection', async () => {
    render(
      <MenuBar
        {...baseProps({
          hasRepository: false,
          hasRepositories: false,
          hasEditor: false,
          hasShell: false,
          canFetch: false,
          canPush: false,
          canPull: false,
          canCreateBranch: false,
          canRenameBranch: false,
          canDeleteBranch: false,
          canMergeBranch: false,
          canDiscardAll: false,
        })}
      />
    )
    const file = await openMenu('File')
    expect(
      within(file).getByRole('menuitem', { name: 'Open new window' })
    ).toBeDisabled()

    const repository = await openMenu('Repository')
    for (const name of [
      'Push',
      'Pull',
      'Fetch',
      'Manage remotes…',
      'Remove…',
      'Open in Ghostty',
    ]) {
      expect(within(repository).getByRole('menuitem', { name })).toBeDisabled()
    }

    const branch = await openMenu('Branch')
    for (const name of [
      'New branch…',
      'Rename…',
      'Delete…',
      'Merge into current branch…',
      'Discard all changes…',
      'Permanently discard all changes…',
    ]) {
      expect(within(branch).getByRole('menuitem', { name })).toBeDisabled()
    }
  })

  it('disables remote actions while a repository operation is busy', async () => {
    render(
      <MenuBar
        {...baseProps({
          canFetch: false,
          canPush: false,
          canPull: false,
        })}
      />
    )
    const menu = await openMenu('Repository')
    for (const name of ['Push', 'Pull', 'Fetch']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeDisabled()
    }
    expect(
      within(menu).getByRole('menuitem', { name: 'Remove…' })
    ).toBeEnabled()
  })

  it('keeps Changes and History enabled whenever a repository is selected', async () => {
    render(<MenuBar {...baseProps()} />)
    const menu = await openMenu('View')
    expect(
      within(menu).getByRole('menuitem', { name: 'Changes' })
    ).toBeEnabled()
    expect(
      within(menu).getByRole('menuitem', { name: 'History' })
    ).toBeEnabled()
  })
})

describe('menu bar actions', () => {
  it('routes File menu actions to their handlers', async () => {
    const onCreateRepository = vi.fn()
    const onOpenNewWindow = vi.fn()
    const onAddExistingRepository = vi.fn()
    const onCloneRepository = vi.fn()
    const onShowPreferences = vi.fn()
    const onShowAbout = vi.fn()
    render(
      <MenuBar
        {...baseProps({
          onCreateRepository,
          onOpenNewWindow,
          onAddExistingRepository,
          onCloneRepository,
          onShowPreferences,
          onShowAbout,
        })}
      />
    )
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const file = await openMenu('File')
    await user.click(
      within(file).getByRole('menuitem', { name: 'New repository…' })
    )
    expect(onCreateRepository).toHaveBeenCalledOnce()
    await openMenu('File')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Open new window',
      })
    )
    expect(onOpenNewWindow).toHaveBeenCalledOnce()
    await openMenu('File')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Add local repository…',
      })
    )
    expect(onAddExistingRepository).toHaveBeenCalledOnce()
    await openMenu('File')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Clone repository…',
      })
    )
    expect(onCloneRepository).toHaveBeenCalledOnce()
    await openMenu('File')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Options…',
      })
    )
    expect(onShowPreferences).toHaveBeenCalledOnce()
  })

  it('routes view, repository and branch actions', async () => {
    const onSelectView = vi.fn()
    const onShowRepositoryList = vi.fn()
    const onShowBranchesList = vi.fn()
    const onGoToCommitMessage = vi.fn()
    const onExpandSidebar = vi.fn()
    const onContractSidebar = vi.fn()
    const onPush = vi.fn()
    const onPull = vi.fn()
    const onFetch = vi.fn()
    const onRemoveRepository = vi.fn()
    const onManageRemotes = vi.fn()
    const onNewBranch = vi.fn()
    const onRenameBranch = vi.fn()
    const onDeleteBranch = vi.fn()
    const onMergeBranch = vi.fn()
    const onDiscardAll = vi.fn()
    render(
      <MenuBar
        {...baseProps({
          onSelectView,
          onShowRepositoryList,
          onShowBranchesList,
          onGoToCommitMessage,
          onExpandSidebar,
          onContractSidebar,
          onPush,
          onPull,
          onFetch,
          onRemoveRepository,
          onManageRemotes,
          onNewBranch,
          onRenameBranch,
          onDeleteBranch,
          onMergeBranch,
          onDiscardAll,
        })}
      />
    )
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    await openMenu('View')
    let menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'History' }))
    expect(onSelectView).toHaveBeenCalledWith('history')

    await openMenu('View')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Repository list' })
    )
    expect(onShowRepositoryList).toHaveBeenCalledOnce()

    await openMenu('View')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Branches list' })
    )
    expect(onShowBranchesList).toHaveBeenCalledOnce()

    await openMenu('View')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Go to Summary' })
    )
    expect(onGoToCommitMessage).toHaveBeenCalledOnce()

    await openMenu('View')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Expand active resizable' })
    )
    expect(onExpandSidebar).toHaveBeenCalledOnce()

    await openMenu('View')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Contract active resizable' })
    )
    expect(onContractSidebar).toHaveBeenCalledOnce()

    await openMenu('Repository')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Push' }))
    expect(onPush).toHaveBeenCalledOnce()

    await openMenu('Repository')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Pull' }))
    expect(onPull).toHaveBeenCalledOnce()

    await openMenu('Repository')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Fetch' }))
    expect(onFetch).toHaveBeenCalledOnce()

    await openMenu('Repository')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Manage remotes…' })
    )
    expect(onManageRemotes).toHaveBeenCalledOnce()

    await openMenu('Repository')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove…' }))
    expect(onRemoveRepository).toHaveBeenCalledOnce()

    await openMenu('Branch')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'New branch…' })
    )
    expect(onNewBranch).toHaveBeenCalledOnce()

    await openMenu('Branch')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    expect(onRenameBranch).toHaveBeenCalledOnce()

    await openMenu('Branch')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete…' }))
    expect(onDeleteBranch).toHaveBeenCalledOnce()

    await openMenu('Branch')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', {
        name: 'Merge into current branch…',
      })
    )
    expect(onMergeBranch).toHaveBeenCalledOnce()

    await openMenu('Branch')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Discard all changes…' })
    )
    expect(onDiscardAll).toHaveBeenCalledWith(false)

    await openMenu('Branch')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', {
        name: 'Permanently discard all changes…',
      })
    )
    expect(onDiscardAll).toHaveBeenCalledWith(true)
  })

  it('opens rdc-owned Help destinations and wires the edit roles', async () => {
    render(<MenuBar {...baseProps({ isDevelopment: true })} />)
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    await openMenu('Help')
    let menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Report issue…' })
    )
    expect(openUrl).toHaveBeenCalledWith(
      'https://github.com/jabelardo/rdc/issues/new'
    )
    await openMenu('Help')
    menu = screen.getByRole('menu')
    await user.click(
      within(menu).getByRole('menuitem', { name: 'View RDC on GitHub' })
    )
    expect(openUrl).toHaveBeenCalledWith('https://github.com/jabelardo/rdc')

    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
      writable: true,
    })
    await openMenu('Edit')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy' }))
    expect(execCommand).toHaveBeenCalledWith('copy')
    await openMenu('Edit')
    menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Select all' }))
    expect(selectAllWindowContents).toHaveBeenCalledOnce()
  })

  it('routes zoom controls through the window zoom factor (regression: silent drop)', async () => {
    getCurrentWindowZoomFactor.mockResolvedValue(1)
    setWindowZoomFactor.mockResolvedValue(undefined)
    render(<MenuBar {...baseProps()} />)
    const user = userEvent.setup()

    await openMenu('View')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Zoom in',
      })
    )
    await vi.waitFor(() => {
      expect(setWindowZoomFactor).toHaveBeenCalledWith(1.05)
    })

    await openMenu('View')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Reset zoom',
      })
    )
    await vi.waitFor(() => {
      expect(setWindowZoomFactor).toHaveBeenCalledWith(1)
    })
  })

  it('wires the dev-only reload and devtools items', async () => {
    render(<MenuBar {...baseProps({ isDevelopment: true })} />)
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    await openMenu('View')
    // jsdom's window.location.reload is non-configurable, so exercise the
    // click path without spying on the reload itself.
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Reload' })
    )

    await openMenu('View')
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: 'Toggle developer tools',
      })
    )
    expect(toggleDevTools).toHaveBeenCalledOnce()
  })
})

describe('menu bar keyboard navigation', () => {
  beforeEach(() => {
    getCurrentWindowZoomFactor.mockResolvedValue(1)
    setWindowZoomFactor.mockResolvedValue(undefined)
  })

  it('closes the dropdown with Escape and returns focus to the trigger', async () => {
    render(<MenuBar {...baseProps()} />)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const trigger = screen.getByRole('menuitem', { name: 'File' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('navigates items with arrow keys', async () => {
    render(<MenuBar {...baseProps()} />)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(
      within(menu).getByRole('menuitem', { name: 'New repository…' })
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Open new window' })
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(
      within(menu).getByRole('menuitem', { name: 'New repository…' })
    ).toHaveFocus()
  })

  it('switches to the adjacent menu with arrow keys', async () => {
    render(<MenuBar {...baseProps()} />)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    const fileMenu = screen.getByRole('menu')

    fireEvent.keyDown(fileMenu, { key: 'ArrowRight' })
    expect(screen.getByRole('menu')).toHaveTextContent('Undo')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowLeft' })
    expect(screen.getByRole('menu')).toHaveTextContent('New repository…')
  })

  it('opens a menu with its Alt mnemonic and activates items by key', async () => {
    render(<MenuBar {...baseProps()} />)
    const menubar = screen.getByRole('menubar')
    fireEvent.keyDown(menubar, { key: 'f', altKey: true })
    expect(screen.getByRole('menu')).toHaveTextContent('New repository…')

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'r' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('moves between triggers with arrow keys from the closed bar', () => {
    render(<MenuBar {...baseProps()} />)
    const file = screen.getByRole('menuitem', { name: 'File' })
    file.focus()
    fireEvent.keyDown(file, { key: 'ArrowRight' })
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit' }), {
      key: 'ArrowLeft',
    })
    expect(screen.getByRole('menuitem', { name: 'File' })).toHaveFocus()
  })
})
