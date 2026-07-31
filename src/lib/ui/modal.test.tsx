import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './modal'

function DismissibleModal() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal
          aria-labelledby="test-modal-title"
          onDismiss={() => setOpen(false)}
        >
          <h2 id="test-modal-title">Test modal</h2>
          <button type="button">First</button>
          <button type="button">Last</button>
        </Modal>
      )}
    </>
  )
}

describe('modal accessibility', () => {
  it('enters, traps and restores focus while Escape dismisses', async () => {
    const user = userEvent.setup()
    render(<DismissibleModal />)
    const opener = screen.getByRole('button', { name: 'Open' })

    await user.click(opener)
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('does not dismiss a decision dialog without a safe cancellation path', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <Modal role="alertdialog" aria-labelledby="decision-title">
        <h2 id="decision-title">Decision required</h2>
        <button type="button" onClick={onDismiss}>
          Resolve
        </button>
      </Modal>
    )

    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
