import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMenuPopup = vi.fn(
  async (_position?: { x: number; y: number }, _window?: unknown) => {}
)
const mockMenuItemNew = vi.fn(
  async (opts: { text: string; action?: () => void }) => ({
    text: opts.text,
    action: opts.action,
  })
)
const mockPredefinedNew = vi.fn(async () => ({}))
const mockMenuNew = vi.fn(async () => ({ popup: mockMenuPopup }))
const listen = vi.hoisted(() => vi.fn())
const mockGetCurrentWindow = vi.fn(() => ({ label: 'main' }))
const mockGetCurrentWindowZoomFactor = vi.fn(async () => 1)

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: mockMenuNew },
  MenuItem: { new: mockMenuItemNew },
  PredefinedMenuItem: { new: mockPredefinedNew },
}))
// A minimal stand-in for Tauri's real class: `showContextMenu` only needs the constructed value to
// carry `x`/`y` through to `menu.popup`, and asserting on that shape is more informative than
// asserting on `instanceof LogicalPosition` against a real Tauri class in a mocked module graph.
vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: mockGetCurrentWindow,
}))
vi.mock('./window', () => ({
  getCurrentWindowZoomFactor: mockGetCurrentWindowZoomFactor,
}))

const { showContextMenu } = await import('./menu')

describe('context menu', () => {
  beforeEach(() => {
    mockMenuPopup.mockReset()
    mockMenuItemNew.mockReset()
    mockPredefinedNew.mockReset()
    mockMenuNew.mockReset()
    listen.mockReset()
    mockGetCurrentWindow.mockClear()
    mockGetCurrentWindowZoomFactor.mockReset().mockResolvedValue(1)
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

  it('pops up at the current pointer position when no coordinates are given', async () => {
    await showContextMenu([{ text: 'Open' }])

    expect(mockMenuPopup).toHaveBeenCalledWith()
    expect(mockGetCurrentWindowZoomFactor).not.toHaveBeenCalled()
  })

  it('anchors to the trigger coordinates, scaled by the window zoom factor', async () => {
    mockGetCurrentWindowZoomFactor.mockResolvedValue(1.15)

    await showContextMenu([{ text: 'Open' }], { x: 100, y: 200 })

    expect(mockGetCurrentWindow).toHaveBeenCalledOnce()
    const [position, window] = mockMenuPopup.mock.calls[0]
    expect(position?.x).toBeCloseTo(115)
    expect(position?.y).toBeCloseTo(230)
    expect(window).toMatchObject({ label: 'main' })
  })

  it('adds the CSD headerbar offset only when native title-bar chrome is present', async () => {
    await showContextMenu([{ text: 'Open' }], {
      x: 10,
      y: 20,
      hasNativeTitleBarChrome: true,
    })

    const [withChrome] = mockMenuPopup.mock.calls[0]
    expect(withChrome).toMatchObject({ x: 10, y: 67 })

    mockMenuPopup.mockClear()
    await showContextMenu([{ text: 'Open' }], {
      x: 10,
      y: 20,
      hasNativeTitleBarChrome: false,
    })

    const [withoutChrome] = mockMenuPopup.mock.calls[0]
    expect(withoutChrome).toMatchObject({ x: 10, y: 20 })
  })
})
