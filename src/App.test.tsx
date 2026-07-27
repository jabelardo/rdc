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
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
})
