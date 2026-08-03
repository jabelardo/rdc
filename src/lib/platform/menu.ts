import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IMenu, MenuAction } from '../../models/app-menu'
import type { SerializableContextMenuItem } from '../../models/context-menu'
import { getCurrentWindowZoomFactor } from './window'

// Track the last pointer-down position so context menus open where the user
// clicked rather than at the (stale) cursor position at IPC round-trip time.
// On Wayland the cursor position queried by GTK after the async boundary is
// often wrong; anchoring to the captured click coordinates fixes it.
let lastPointerX: number | null = null
let lastPointerY: number | null = null

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => {
    lastPointerX = e.clientX
    lastPointerY = e.clientY
  })
}

/**
 * Replace macOS's startup menu after the renderer has produced the canonical
 * state-derived tree. Linux and Windows must not call this.
 */
export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke('set_native_menu', { menu })
}

/**
 * Bounding rect of the element that triggered a context menu, in CSS pixels
 * relative to the viewport.  Passed through so the native popup can anchor
 * below the trigger instead of at the (stale) cursor position.
 */
export interface TriggerRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Show a native contextual menu. The returned indices identify the selected
 * renderer-owned item, or null when the popup was dismissed.
 *
 * When a `triggerRect` is supplied the popup is anchored below that element
 * (using its bottom-left corner) instead of at the captured pointer position.
 * This avoids the stale-cursor problem on Wayland *and* keeps the menu out of
 * the trigger's tooltip area.
 */
export function invokeContextualMenu(
  items: ReadonlyArray<SerializableContextMenuItem>,
  addSpellCheckMenu: boolean,
  triggerRect?: TriggerRect
): Promise<ReadonlyArray<number> | null> {
  // Prefer the trigger's bottom-left corner so the menu opens downward.
  // Fall back to the last pointer-down position for callers that don't have a
  // trigger element (e.g. keyboard-triggered context menus).
  const x = triggerRect ? triggerRect.x : lastPointerX
  const y = triggerRect ? triggerRect.y + triggerRect.height : lastPointerY

  // The native `popup_menu_at` takes *logical* window coordinates, while the
  // trigger rect and pointer positions are CSS (page) pixels. At a non-1 webview
  // zoom these differ by the zoom factor, so a fixed-CSS anchor would drift
  // toward the top-left — and the gap grows with page Y, so the farther down the
  // trigger row, the higher the menu appeared (regression at Linux's 1.15
  // default zoom). Scale to logical pixels before sending.
  return getCurrentWindowZoomFactor().then(zoom => {
    const scaledX = x === null ? null : x * zoom
    const scaledY = y === null ? null : y * zoom
    return invoke('show_contextual_menu', {
      items,
      addSpellCheckMenu,
      x: scaledX,
      y: scaledY,
    })
  })
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
