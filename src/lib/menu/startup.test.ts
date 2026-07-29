import { describe, expect, it, vi } from 'vitest'
import type { MenuAction, MenuItem } from '../../models/app-menu'
import {
  buildStartupMenu,
  createStartupMenuActionExecutor,
  installMacOSDefaultMenu,
} from './startup'

function allItems(items: ReadonlyArray<MenuItem>): ReadonlyArray<MenuItem> {
  return items.flatMap(item =>
    item.type === 'submenuItem'
      ? [item, ...allItems(item.menu.items)]
      : [item]
  )
}

describe('startup default menu', () => {
  it('keeps supported and native actions enabled while disabling unconnected UI actions', () => {
    const items = allItems(buildStartupMenu().items)
    const byId = (id: string) => items.find(item => item.id === id)

    expect(byId('pull')).toMatchObject({ enabled: false })
    expect(byId('preferences')).toMatchObject({ enabled: false })
    expect(byId('select-all')).toMatchObject({ enabled: true })
    expect(byId('quit')).toMatchObject({ enabled: true })
    expect(byId('reset-zoom')).toMatchObject({ enabled: true })
    expect(
      items.find(
        item =>
          item.type === 'menuItem' &&
          item.action?.type === 'open-external'
      )
    ).toMatchObject({ enabled: true })
    expect(
      items.find(item => item.type === 'menuItem' && item.role === 'copy')
    ).toMatchObject({ enabled: true })
  })

  it('registers the action listener before replacing the bootstrap menu and cleans up', async () => {
    const calls: string[] = []
    const unlisten = vi.fn()
    let onAction: ((action: MenuAction) => void) | undefined
    const execute = vi.fn()
    const install = vi.fn(async () => {
      calls.push('install')
    })
    const listen = vi.fn(async (callback: (action: MenuAction) => void) => {
      calls.push('listen')
      onAction = callback
      return unlisten
    })

    const dispose = await installMacOSDefaultMenu({
      execute,
      install,
      listen,
    })
    onAction?.({ type: 'menu-event', event: 'select-all' })
    dispose()

    expect(calls).toEqual(['listen', 'install'])
    expect(install).toHaveBeenCalledWith(buildStartupMenu())
    expect(execute).toHaveBeenCalledWith({
      type: 'menu-event',
      event: 'select-all',
    })
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('removes the listener when native installation fails', async () => {
    const unlisten = vi.fn()

    await expect(
      installMacOSDefaultMenu({
        execute: vi.fn(),
        install: async () => {
          throw new Error('native menu failed')
        },
        listen: async () => unlisten,
      })
    ).rejects.toThrow('native menu failed')

    expect(unlisten).toHaveBeenCalledOnce()
  })
})

describe('startup menu actions', () => {
  it('executes every action the startup menu leaves enabled', async () => {
    const environment = {
      close: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      reload: vi.fn(),
      selectAll: vi.fn(),
      setZoom: vi.fn(async () => undefined),
    }
    const execute = createStartupMenuActionExecutor(environment)

    await expect(
      execute({ type: 'open-external', url: 'https://example.com' })
    ).resolves.toBe(true)
    await expect(
      execute({ type: 'menu-event', event: 'select-all' })
    ).resolves.toBe(true)
    await expect(
      execute({ type: 'zoom', direction: 'in' })
    ).resolves.toBe(true)
    await expect(
      execute({ type: 'zoom', direction: 'out' })
    ).resolves.toBe(true)
    await expect(
      execute({ type: 'zoom', direction: 'reset' })
    ).resolves.toBe(true)
    await expect(execute({ type: 'reload-window' })).resolves.toBe(true)
    await expect(execute({ type: 'quit' })).resolves.toBe(true)

    expect(environment.openExternal).toHaveBeenCalledWith(
      'https://example.com'
    )
    expect(environment.selectAll).toHaveBeenCalledOnce()
    expect(environment.setZoom.mock.calls).toEqual([[1.1], [1], [1]])
    expect(environment.reload).toHaveBeenCalledOnce()
    expect(environment.close).toHaveBeenCalledOnce()
  })

  it('refuses actions that must wait for the Phase 7 dispatcher', async () => {
    const execute = createStartupMenuActionExecutor({
      close: vi.fn(),
      openExternal: vi.fn(),
      reload: vi.fn(),
      selectAll: vi.fn(),
      setZoom: vi.fn(),
    })

    await expect(
      execute({ type: 'menu-event', event: 'pull' })
    ).resolves.toBe(false)
    await expect(execute({ type: 'show-logs' })).resolves.toBe(false)
    await expect(execute({ type: 'show-devtools' })).resolves.toBe(false)
  })
})
