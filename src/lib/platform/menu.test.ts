import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMenuPopup = vi.fn(async () => {})
const mockMenuItemNew = vi.fn(
  async (opts: { text: string; action?: () => void }) => ({
    text: opts.text,
    action: opts.action,
  })
)
const mockPredefinedNew = vi.fn(async () => ({}))
const mockMenuNew = vi.fn(async () => ({ popup: mockMenuPopup }))
const listen = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: mockMenuNew },
  MenuItem: { new: mockMenuItemNew },
  PredefinedMenuItem: { new: mockPredefinedNew },
}))

const { showContextMenu } = await import('./menu')

describe('context menu', () => {
  beforeEach(() => {
    mockMenuPopup.mockReset()
    mockMenuItemNew.mockReset()
    mockPredefinedNew.mockReset()
    mockMenuNew.mockReset()
    listen.mockReset()
  })

  it('builds a Menu from items and pops it up', async () => {
    const action = vi.fn()
    await showContextMenu([
      { text: 'Open', action },
      { type: 'separator' },
      { text: 'Remove', enabled: false },
    ])

    expect(mockMenuItemNew).toHaveBeenCalledWith({
      id: undefined,
      text: 'Open',
      enabled: true,
      action: expect.any(Function),
    })
    expect(mockPredefinedNew).toHaveBeenCalledWith({ item: 'Separator' })
    expect(mockMenuItemNew).toHaveBeenCalledWith({
      id: undefined,
      text: 'Remove',
      enabled: false,
      action: expect.any(Function),
    })
    expect(mockMenuNew).toHaveBeenCalledOnce()
    expect(mockMenuPopup).toHaveBeenCalledOnce()
  })

  it('does nothing for empty items', async () => {
    await showContextMenu([])

    expect(mockMenuNew).not.toHaveBeenCalled()
  })
})
