import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { AppFileStatusKind } from './models/status'
import type { IStatusResult } from './lib/git-ipc'

// `invoke` is the whole boundary, so it's the thing to mock: these tests cover the frontend half of
// the contract — that the command is called with the right name and camelCase argument names, and
// that each response shape renders. The Rust half (the exact JSON) is pinned by
// `crates/git-ops/tests/wire_contract.rs`.
const invoke = vi.hoisted(() => vi.fn())
const installApplicationMenu = vi.hoisted(() => vi.fn())
const showContextualMenu = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())
const sendReady = vi.hoisted(() => vi.fn())
const openRepositoryInNewWindow = vi.hoisted(() => vi.fn())
const closeWindow = vi.hoisted(() => vi.fn())
const installDefaultCloseRequestHandler = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('./lib/menu/application-menu', () => ({ installApplicationMenu }))
vi.mock('./lib/menu/context-menu', () => ({ showContextualMenu }))
vi.mock('./lib/platform/dialogs', () => ({ showOpenDialog }))
vi.mock('./lib/platform/lifetime', () => ({
  installDefaultCloseRequestHandler,
}))
vi.mock('./lib/platform/window', () => ({
  closeWindow,
  openRepositoryInNewWindow,
  sendReady,
}))

const cleanStatus: IStatusResult = {
  currentBranch: 'main',
  mergeHeadFound: false,
  squashMsgFound: false,
  isCherryPickingHeadFound: false,
  files: [],
  doConflictedFilesExist: false,
}

async function readStatusFor(path: string) {
  const user = userEvent.setup()
  render(<App />)
  await user.type(screen.getByPlaceholderText(/path\/to\/a\/git\/repository/i), path)
  await user.click(screen.getByRole('button', { name: /read status/i }))
}

describe('App', () => {
  beforeEach(() => {
    invoke.mockReset()
    installApplicationMenu.mockReset()
    installApplicationMenu.mockResolvedValue({ dispose: vi.fn() })
    showContextualMenu.mockReset()
    showContextualMenu.mockResolvedValue(undefined)
    showOpenDialog.mockReset()
    showOpenDialog.mockResolvedValue(null)
    sendReady.mockReset()
    sendReady.mockResolvedValue(null)
    openRepositoryInNewWindow.mockReset()
    openRepositoryInNewWindow.mockResolvedValue(undefined)
    closeWindow.mockReset()
    closeWindow.mockResolvedValue(undefined)
    installDefaultCloseRequestHandler.mockReset()
    installDefaultCloseRequestHandler.mockResolvedValue(vi.fn())
  })

  it('reports readiness after the first render', async () => {
    render(<App />)

    expect(sendReady).toHaveBeenCalledOnce()
    expect(sendReady).toHaveBeenCalledWith(expect.any(Number))
  })

  it('installs the frontend-owned native close decision', async () => {
    render(<App />)

    expect(installDefaultCloseRequestHandler).toHaveBeenCalledOnce()
  })

  it('installs the cross-platform application menu owner', async () => {
    render(<App />)

    expect(installApplicationMenu).toHaveBeenCalledOnce()
  })

  it('requests close through the native window boundary', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('button', { name: /request application close/i })
    )

    expect(closeWindow).toHaveBeenCalledOnce()
  })

  it('requests a new repository window with the path unchanged', async () => {
    const user = userEvent.setup()
    render(<App />)
    const path = screen.getByPlaceholderText(
      /path\/to\/a\/git\/repository/i
    )
    await user.type(path, '/repo/../repo')
    await user.click(
      screen.getByRole('button', {
        name: /open repository in new window/i,
      })
    )

    expect(openRepositoryInNewWindow).toHaveBeenCalledWith(
      '/repo/../repo'
    )
  })

  it('renders the repository action returned by the ready handshake', async () => {
    sendReady.mockResolvedValue({
      kind: 'open-repository',
      path: '/repo/../repo',
      persistSelection: false,
    })

    render(<App />)

    expect(
      await screen.findByText(
        'Open repository: /repo/../repo; persist selection: false'
      )
    ).toBeInTheDocument()
  })

  it('invokes get_status with camelCase argument names', async () => {
    // Tauri converts JS argument names to the Rust parameters, so these keys are part of the
    // contract: renaming a Rust parameter without updating them fails silently at runtime.
    invoke.mockResolvedValue(cleanStatus)

    await readStatusFor('/tmp/repo')

    expect(invoke).toHaveBeenCalledWith('get_status', {
      repositoryPath: '/tmp/repo',
      listUntrackedFilesIndividually: true,
    })
  })

  it('renders the current branch and upstream', async () => {
    invoke.mockResolvedValue({
      ...cleanStatus,
      currentUpstreamBranch: 'origin/main',
      branchAheadBehind: { ahead: 2, behind: 1 },
    })

    await readStatusFor('/tmp/repo')

    expect(await screen.findByText('main')).toBeInTheDocument()
    expect(await screen.findByText(/origin\/main/)).toBeInTheDocument()
    expect(await screen.findByText(/ahead 2, behind 1/)).toBeInTheDocument()
  })

  it('renders changed files with their status', async () => {
    invoke.mockResolvedValue({
      ...cleanStatus,
      files: [
        {
          path: 'src/thing.ts',
          status: { kind: AppFileStatusKind.Modified },
          startsUnselected: false,
        },
        {
          path: 'src/new.ts',
          status: { kind: AppFileStatusKind.Untracked },
          startsUnselected: false,
        },
      ],
    })

    await readStatusFor('/tmp/repo')

    expect(await screen.findByText('src/thing.ts')).toBeInTheDocument()
    expect(await screen.findByText('modified')).toBeInTheDocument()
    expect(await screen.findByText('src/new.ts')).toBeInTheDocument()
    expect(await screen.findByText('untracked')).toBeInTheDocument()
  })

  it('reports a clean repository', async () => {
    invoke.mockResolvedValue(cleanStatus)
    await readStatusFor('/tmp/repo')
    expect(await screen.findByText(/no changes/i)).toBeInTheDocument()
  })

  it('distinguishes "not a repository" from a failure', async () => {
    // `null` is a normal answer, not an error — the command reserves rejection for real failures.
    invoke.mockResolvedValue(null)

    await readStatusFor('/tmp/not-a-repo')

    expect(
      await screen.findByText(/not a git repository/i)
    ).toBeInTheDocument()
  })

  it('surfaces a command error', async () => {
    // Rejections arrive as the serialized CommandError, not an Error instance.
    invoke.mockRejectedValue({
      message: 'git failed spectacularly',
      isAuthFailure: false,
    })

    await readStatusFor('/tmp/repo')

    expect(
      await screen.findByText(/git failed spectacularly/i)
    ).toBeInTheDocument()
  })

  it('does not call the command without a path', async () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /read status/i })).toBeDisabled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports a nested native contextual-menu selection', async () => {
    showContextualMenu.mockImplementation(async items => {
      items[1].submenu[0].action()
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('button', { name: /open contextual menu/i })
    )

    expect(showContextualMenu).toHaveBeenCalledOnce()
    expect(await screen.findByText('Selected nested item')).toBeInTheDocument()
  })

  it('reports native contextual-menu dismissal', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('button', { name: /open contextual menu/i })
    )

    expect(
      await screen.findByText('Contextual menu dismissed')
    ).toBeInTheDocument()
  })

  it('reports native directory-dialog dismissal', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('button', { name: /open directory dialog/i })
    )

    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Choose a repository directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    expect(
      await screen.findByText('Directory dialog dismissed')
    ).toBeInTheDocument()
  })
})
