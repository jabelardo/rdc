import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Component } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FatalErrorBoundary } from './error-boundary'

const showApplicationLogs = vi.hoisted(() => vi.fn())

vi.mock('./logs', () => ({ showApplicationLogs }))

class BrokenView extends Component {
  public render(): never {
    throw new Error('render exploded')
  }
}

describe('fatal error recovery', () => {
  beforeEach(() => {
    showApplicationLogs.mockReset()
    showApplicationLogs.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replaces a failed render with local recovery actions and logs its component stack', async () => {
    const reload = vi.fn()
    const loggedError = vi.spyOn(log, 'error')
    const user = userEvent.setup()

    render(
      <FatalErrorBoundary reload={reload}>
        <BrokenView />
      </FatalErrorBoundary>
    )

    expect(
      screen.getByRole('heading', { name: 'rdc encountered an error' })
    ).toBeInTheDocument()
    expect(screen.getByText('render exploded')).toBeInTheDocument()
    expect(loggedError).toHaveBeenCalledWith(
      'The application interface failed to render',
      expect.objectContaining({
        message: expect.stringContaining('render exploded'),
      })
    )

    await user.click(screen.getByRole('button', { name: 'Show logs' }))
    await user.click(screen.getByRole('button', { name: 'Reload rdc' }))

    expect(showApplicationLogs).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()
  })
})
