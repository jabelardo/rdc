import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import type { IMenu, MenuAction } from '../../models/app-menu'

export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke('set_native_menu', { menu })
}

/**
 * An item in a native contextual menu.
 *
 * This is a thin union over Tauri's own {@linkcode MenuItemOptions} and
 * {@linkcode PredefinedMenuItemOptions}. Callers pass plain objects; the
 * function constructs the corresponding `MenuItem` or `PredefinedMenuItem`
 * under the hood.
 */
export type ContextMenuItem =
  | {
      readonly id?: string
      readonly text: string
      readonly enabled?: boolean
      readonly action?: () => void
      readonly type?: 'item' | undefined
    }
  | { readonly type: 'separator' }

/**
 * Show a native contextual menu built from Tauri's Menu/MenuItem API. No
 * custom Rust command is involved — this function creates a Tauri `Menu`,
 * positions it via `Menu.popup()` and routes selection to each item's own
 * `action` callback.
 */
export async function showContextMenu(
  items: ReadonlyArray<ContextMenuItem>
): Promise<void> {
  if (items.length === 0) {
    return
  }

  const menuItems = await Promise.all(
    items.map(async item => {
      if (item.type === 'separator') {
        return PredefinedMenuItem.new({ item: 'Separator' })
      }
      return MenuItem.new({
        id: item.id,
        text: item.text,
        enabled: item.enabled ?? true,
        action: () => item.action?.(),
      })
    })
  )

  const menu = await Menu.new({ items: menuItems })
  await menu.popup()
}

export function selectAllWindowContents(): void {
  document.execCommand('selectAll')
}

/** macOS native menu action channel. */
export function onNativeMenuAction(
  callback: (action: MenuAction) => void
): Promise<UnlistenFn> {
  return listen<MenuAction>('menu-event', event => callback(event.payload))
}
