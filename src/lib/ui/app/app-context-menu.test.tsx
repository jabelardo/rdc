import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AppContextMenu } from './app-context-menu'
import type { ContextMenuItem } from '../../../models/context-menu'

const items: ReadonlyArray<ContextMenuItem> = [
  { label: 'Open', action: vi.fn() },
  { label: 'Disabled', enabled: false, action: vi.fn() },
  { type: 'separator' },
  { label: 'Delete', action: vi.fn() },
]

describe('AppContextMenu', () => {
  it('renders the items, separators and disabled state', () => {
    render(
      <AppContextMenu
        items={items}
        position={{ x: 10, y: 20 }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
    const disabled = screen.getByRole('menuitem', { name: 'Disabled' })
    expect(disabled).toBeDisabled()
    expect(screen.getAllByRole('separator').length).toBeGreaterThanOrEqual(1)
  })

  it('runs the action and closes when an enabled item is clicked', () => {
    const onClose = vi.fn()
    const action = items[0].action as ReturnType<typeof vi.fn>
    render(
      <AppContextMenu
        items={items}
        position={{ x: 0, y: 0 }}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))

    expect(action).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not run the action of a disabled item', () => {
    const onClose = vi.fn()
    const action = items[1].action as ReturnType<typeof vi.fn>
    render(
      <AppContextMenu
        items={items}
        position={{ x: 0, y: 0 }}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }))

    expect(action).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and on window blur, so focus loss cannot wedge the app', () => {
    const onClose = vi.fn()
    render(
      <AppContextMenu
        items={items}
        position={{ x: 0, y: 0 }}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.blur(window)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders nothing when there are no items', () => {
    const { container } = render(
      <AppContextMenu items={null} position={null} onClose={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
