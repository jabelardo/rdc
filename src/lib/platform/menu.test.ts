import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IMenu, MenuAction } from '../../models/app-menu'
import type { SerializableContextMenuItem } from '../../models/context-menu'

const invoke = vi.hoisted(() => vi.fn())
const listen = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

const {
  invokeContextualMenu,
  onNativeMenuAction,
  selectAllWindowContents,
  setNativeMenu,
} = await import('./menu')

describe('native macOS menu bridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
  })

  it('pushes the frontend-owned tree without translating it', async () => {
    const menu: IMenu = { type: 'menu', items: [] }
    invoke.mockResolvedValue(undefined)

    await setNativeMenu(menu)

    expect(invoke).toHaveBeenCalledWith('set_native_menu', { menu })
  })

  it('unwraps native menu actions into the frontend execution path', async () => {
    const action: MenuAction = { type: 'menu-event', event: 'pull' }
    const callback = vi.fn()
    listen.mockImplementation(
      async (_name: string, handler: (event: unknown) => void) => {
        handler({ payload: action })
        return vi.fn()
      }
    )

    await onNativeMenuAction(callback)

    expect(listen).toHaveBeenCalledWith('menu-event', expect.any(Function))
    expect(callback).toHaveBeenCalledWith(action)
  })

  it('asks Rust to show a contextual menu and returns the selected path', async () => {
    const items: ReadonlyArray<SerializableContextMenuItem> = [
      { label: 'Parent', submenu: [{ label: 'Child' }] },
    ]
    invoke.mockResolvedValue([0, 0])

    await expect(invokeContextualMenu(items, false, 100, 150)).resolves.toEqual(
      [0, 0]
    )

    expect(invoke).toHaveBeenCalledWith('show_contextual_menu', {
      items,
      addSpellCheckMenu: false,
    })
  })

  it('selects the current web contents without crossing IPC', () => {
    const execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    selectAllWindowContents()

    expect(execCommand).toHaveBeenCalledWith('selectAll')
    expect(invoke).not.toHaveBeenCalled()
  })
})
