import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))
const listen = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

const { showContextMenu } = await import('./menu')

describe('showContextMenu', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    listen.mockReset()
  })

  function stubSelection(id: string | undefined) {
    let handler: ((event: { payload: string }) => void) | undefined
    listen.mockImplementation((_event, callback) => {
      handler = callback
      return Promise.resolve(vi.fn())
    })
    invoke.mockImplementation(async () => {
      if (id !== undefined) {
        handler?.({ payload: id })
      }
    })
  }

  it('invokes the Rust command with wire items and the given position', async () => {
    stubSelection(undefined)
    await showContextMenu(
      [
        { text: 'Open', action: vi.fn() },
        { type: 'separator' },
        { text: 'Remove', enabled: false },
      ],
      { x: 12, y: 34 }
    )

    expect(invoke).toHaveBeenCalledWith('show_context_menu_at', {
      x: 12,
      y: 34,
      items: [
        { type: 'item', id: '0', label: 'Open', enabled: true },
        { type: 'separator' },
        { type: 'item', id: '2', label: 'Remove', enabled: false },
      ],
    })
  })

  it('runs the action of the selected item and no other', async () => {
    const open = vi.fn()
    const remove = vi.fn()
    stubSelection('1')
    await showContextMenu(
      [
        { text: 'Open', action: open },
        { text: 'Remove', action: remove },
      ],
      { x: 0, y: 0 }
    )

    expect(open).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('runs no action when the menu is dismissed without a selection', async () => {
    const action = vi.fn()
    stubSelection(undefined)
    await showContextMenu([{ text: 'Open', action }], { x: 0, y: 0 })

    expect(action).not.toHaveBeenCalled()
  })

  it('unlistens after the popup closes, selected or not', async () => {
    const unlisten = vi.fn()
    listen.mockResolvedValue(unlisten)
    await showContextMenu([{ text: 'Open', action: vi.fn() }], { x: 0, y: 0 })

    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('does nothing for empty items', async () => {
    await showContextMenu([], { x: 0, y: 0 })

    expect(invoke).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  })
})
