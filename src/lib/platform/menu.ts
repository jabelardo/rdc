import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { IMenu, MenuAction } from '../../models/app-menu'
import type { SerializableContextMenuItem } from '../../models/context-menu'

export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke('set_native_menu', { menu })
}

/**
 * Show a native contextual menu. The returned indices identify the selected
 * renderer-owned item, or null when the popup was dismissed.
 *
 * The menu is placed by moving the OS cursor to `x, y` (CSS-pixel viewport
 * coordinates) *before* invoking the native popup, so the popup appears exactly
 * at the click. This is the only reliable approach on Wayland, where querying
 * the cursor position yields a fixed point and explicitly anchored popups
 * retain an input grab through window focus changes.
 */
export async function invokeContextualMenu(
  items: ReadonlyArray<SerializableContextMenuItem>,
  addSpellCheckMenu: boolean,
  x?: number,
  y?: number
): Promise<ReadonlyArray<number> | null> {
  if (x !== undefined && y !== undefined) {
    try {
      await getCurrentWindow().setCursorPosition(
        new LogicalPosition(Math.round(x), Math.round(y))
      )
    } catch {
      // Best-effort: if cursor placement fails, the popup falls back to the
      // current cursor position.
    }
  }
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
