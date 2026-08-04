import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IMenu, MenuAction } from '../../models/app-menu'
import type { SerializableContextMenuItem } from '../../models/context-menu'

export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke('set_native_menu', { menu })
}

export function invokeContextualMenu(
  items: ReadonlyArray<SerializableContextMenuItem>,
  addSpellCheckMenu: boolean
): Promise<ReadonlyArray<number> | null> {
  return invoke('show_contextual_menu', {
    items,
    addSpellCheckMenu,
  })
}

export function selectAllWindowContents(): void {
  document.execCommand('selectAll')
}

export function onNativeMenuAction(
  callback: (action: MenuAction) => void
): Promise<UnlistenFn> {
  return listen<MenuAction>('menu-event', event => callback(event.payload))
}
