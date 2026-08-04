import { describe, expect, it, vi } from 'vitest'
import type {
  ExecutableMenuItem,
  IMenu,
  MenuAction,
} from '../../models/app-menu'
import type { MenuKeybindings } from '../../models/keybinding'
import {
  ApplicationMenuController,
  installApplicationMenu,
  type ApplicationMenuDependencies,
} from './application-menu'

function menu(enabled = true): IMenu {
  return {
    type: 'menu',
    items: [
      {
        id: 'pull',
        type: 'menuItem',
        label: 'Pull',
        enabled,
        visible: true,
        accessKey: null,
        action: { type: 'menu-event', event: 'pull' },
      },
    ],
  }
}

function dependencies(
  platform: ApplicationMenuDependencies['platform']
): ApplicationMenuDependencies {
  const bindings: MenuKeybindings = {
    pull: { modifiers: ['control'], key: 'KeyP' },
  }
  return {
    platform,
    initialMenu: menu(),
    executeAction: vi.fn(async () => true),
    getKeybindings: vi.fn(async () => bindings),
    onKeybindingsChanged: vi.fn(async () => vi.fn()),
    onNativeMenuAction: vi.fn(async () => vi.fn()),
    setNativeMenu: vi.fn(async () => undefined),
  }
}

describe('application menu controller', () => {
  it('executes current enabled items locally by object or id', async () => {
    const executeAction = vi.fn(async () => true)
    const controller = new ApplicationMenuController(menu(), {}, executeAction)
    const item = controller.menu.getItemById('pull') as ExecutableMenuItem

    await expect(controller.executeItem(item)).resolves.toBe(true)
    await expect(controller.executeItemById('pull')).resolves.toBe(true)

    expect(executeAction).toHaveBeenNthCalledWith(1, {
      type: 'menu-event',
      event: 'pull',
    })
    expect(executeAction).toHaveBeenNthCalledWith(2, {
      type: 'menu-event',
      event: 'pull',
    })
  })

  it('rejects disabled, missing, actionless, and stale items', async () => {
    const executeAction = vi.fn(async () => true)
    const controller = new ApplicationMenuController(menu(), {}, executeAction)
    const stale = controller.menu.getItemById('pull') as ExecutableMenuItem

    await controller.replaceMenu(menu(false))

    await expect(controller.executeItem(stale)).resolves.toBe(false)
    await expect(controller.executeItemById('pull')).resolves.toBe(false)
    await expect(controller.executeItemById('does-not-exist')).resolves.toBe(
      false
    )
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('installs the macOS action listeners before its native tree', async () => {
    const calls: string[] = []
    const deps = dependencies('macos')
    let nativeAction: ((action: MenuAction) => void) | undefined
    let keybindingsChanged: ((bindings: MenuKeybindings) => void) | undefined
    const nativeCleanup = vi.fn()
    const bindingCleanup = vi.fn()

    vi.mocked(deps.onNativeMenuAction).mockImplementation(async callback => {
      calls.push('native-listener')
      nativeAction = callback
      return nativeCleanup
    })
    vi.mocked(deps.onKeybindingsChanged).mockImplementation(async callback => {
      calls.push('binding-listener')
      keybindingsChanged = callback
      return bindingCleanup
    })
    vi.mocked(deps.getKeybindings).mockImplementation(async () => {
      calls.push('get-bindings')
      return {}
    })
    vi.mocked(deps.setNativeMenu).mockImplementation(async () => {
      calls.push('set-native-menu')
    })

    const controller = await installApplicationMenu({}, deps)
    expect(calls).toEqual([
      'binding-listener',
      'get-bindings',
      'native-listener',
      'set-native-menu',
    ])

    nativeAction?.({ type: 'menu-event', event: 'pull' })
    await vi.waitFor(() => {
      expect(deps.executeAction).toHaveBeenCalledWith({
        type: 'menu-event',
        event: 'pull',
      })
    })

    await controller.replaceMenu(menu(false))
    expect(deps.setNativeMenu).toHaveBeenCalledTimes(2)

    keybindingsChanged?.({
      pull: { modifiers: ['meta'], key: 'KeyP' },
    })
    await vi.waitFor(() => {
      expect(deps.setNativeMenu).toHaveBeenCalledTimes(3)
    })

    controller.dispose()
    expect(bindingCleanup).toHaveBeenCalledOnce()
    expect(nativeCleanup).toHaveBeenCalledOnce()
  })

  it('cleans up both macOS listeners when native installation fails', async () => {
    const deps = dependencies('macos')
    const nativeCleanup = vi.fn()
    const bindingCleanup = vi.fn()
    vi.mocked(deps.onNativeMenuAction).mockResolvedValue(nativeCleanup)
    vi.mocked(deps.onKeybindingsChanged).mockResolvedValue(bindingCleanup)
    vi.mocked(deps.setNativeMenu).mockRejectedValue(
      new Error('native menu failed')
    )

    await expect(installApplicationMenu({}, deps)).rejects.toThrow(
      'native menu failed'
    )

    expect(nativeCleanup).toHaveBeenCalledOnce()
    expect(bindingCleanup).toHaveBeenCalledOnce()
  })

  it.each(['linux', 'windows'] as const)(
    'mirrors the canonical tree into the native menu on %s',
    async platform => {
      const deps = dependencies(platform)
      const nativeCleanup = vi.fn()
      const bindingCleanup = vi.fn()
      vi.mocked(deps.onNativeMenuAction).mockResolvedValue(nativeCleanup)
      vi.mocked(deps.onKeybindingsChanged).mockResolvedValue(bindingCleanup)

      const controller = await installApplicationMenu({}, deps)

      expect(deps.onNativeMenuAction).toHaveBeenCalledOnce()
      expect(deps.setNativeMenu).toHaveBeenCalledWith(controller.menu.rootMenu)

      controller.dispose()
      expect(bindingCleanup).toHaveBeenCalledOnce()
      expect(nativeCleanup).toHaveBeenCalledOnce()
    }
  )
})
