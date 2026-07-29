import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IMenu, MenuAction } from '../../models/app-menu'
import type { SerializableContextMenuItem } from '../../models/context-menu'

/**
 * Replace macOS's startup menu after the renderer has produced the canonical
 * state-derived tree. Linux and Windows must not call this.
 */
export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke('set_native_menu', { menu })
}

/**
 * Show a native contextual menu. The returned indices identify the selected
 * renderer-owned item, or null when the popup was dismissed.
 */
export function invokeContextualMenu(
  items: ReadonlyArray<SerializableContextMenuItem>,
  addSpellCheckMenu: boolean
): Promise<ReadonlyArray<number> | null> {
  return invoke('show_contextual_menu', { items, addSpellCheckMenu })
}

/** Select all content in the current webview; Electron IPC is unnecessary. */
export function selectAllWindowContents(): void {
  document.execCommand('selectAll')
}

/** macOS native selection re-enters the same typed frontend action path. */
export function onNativeMenuAction(
  callback: (action: MenuAction) => void
): Promise<UnlistenFn> {
  return listen<MenuAction>('menu-event', event => callback(event.payload))
}
