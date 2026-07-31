import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem } from '../../models/context-menu'

const invokeContextualMenu = vi.hoisted(() => vi.fn())

vi.mock('../platform/menu', () => ({ invokeContextualMenu }))

const { showContextualMenu } = await import('./context-menu')

describe('context menus', () => {
  beforeEach(() => {
    invokeContextualMenu.mockReset()
  })

  it('serializes nested items without crossing action functions', async () => {
    const action = vi.fn()
    const items: ReadonlyArray<ContextMenuItem> = [
      {
        label: 'Parent',
        submenu: [
          { label: 'Disabled', enabled: false },
          { label: 'Chosen', action },
        ],
      },
    ]
    invokeContextualMenu.mockResolvedValue([0, 1])

    await showContextualMenu(items)

    expect(invokeContextualMenu).toHaveBeenCalledWith(
      [
        {
          label: 'Parent',
          submenu: [{ label: 'Disabled', enabled: false }, { label: 'Chosen' }],
        },
      ],
      false
    )
    expect(action).toHaveBeenCalledOnce()
    expect(items[0].submenu?.[1].action).toBe(action)
  })

  it('does nothing when the menu is dismissed or returns an invalid path', async () => {
    const action = vi.fn()
    const items: ReadonlyArray<ContextMenuItem> = [{ label: 'Item', action }]
    invokeContextualMenu.mockResolvedValueOnce(null).mockResolvedValueOnce([4])

    await showContextualMenu(items)
    await showContextualMenu(items)

    expect(action).not.toHaveBeenCalled()
  })

  it('preserves the spell-check request for the later webview integration', async () => {
    invokeContextualMenu.mockResolvedValue(null)

    await showContextualMenu([{ role: 'editMenu' }], true)

    expect(invokeContextualMenu).toHaveBeenCalledWith(
      [{ role: 'editMenu' }],
      true
    )
  })
})
