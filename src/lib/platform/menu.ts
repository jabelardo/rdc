import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { IMenu, MenuAction } from '../../models/app-menu'
import { getCurrentWindowZoomFactor } from './window'

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
 * Where a context menu should anchor, captured from the triggering pointer event.
 *
 * `x`/`y` are webview-viewport CSS pixels (`MouseEvent.clientX/clientY`) — zoom-invariant layout
 * coordinates, not the physical/window pixels the native popup positioning API expects.
 * `hasNativeTitleBarChrome` says whether the OS is drawing real window chrome above the webview
 * (Linux CSD with the native, non-custom title bar): pass `true` there, `false`/omitted everywhere
 * else, including the Linux custom-title-bar mode where the app draws its own in-webview drag strip
 * and the viewport already starts at the window's true top.
 */
export type ContextMenuPosition = {
  readonly x: number
  readonly y: number
  readonly hasNativeTitleBarChrome?: boolean
}

/**
 * On Linux with the native (non-custom) title bar, GTK draws its own client-side-decoration
 * headerbar above the webview, so the viewport's y=0 is not the GTK window's y=0 — the popup
 * position must add this offset to land on the clicked row instead of drifting upward by roughly
 * a headerbar's height.
 *
 * This is a constant, not a measurement, and that is a known, accepted approximation carried over
 * from the positioning code this replaces: Wayland denies `outer_position`/`inner_position`
 * queries, so there is no portable way to ask GTK for the real headerbar height from the webview
 * side. A more precise value would mean adding `gtk` as a direct dependency and reading
 * `header_bar().allocated_height()` on the Rust side. This GNOME-default value is "good enough",
 * not exact — expect a few pixels of drift on non-GNOME desktop environments or non-default GTK
 * themes.
 */
const LINUX_CSD_HEADERBAR_HEIGHT = 47

export async function showContextMenu(
  items: ReadonlyArray<ContextMenuItem>,
  position?: ContextMenuPosition
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

  if (position === undefined) {
    // No trigger coordinates: let the native menu fall back to the current pointer position.
    // Kept as a real fallback, not dead code — every current caller supplies coordinates, but a
    // future keyboard-triggered menu (e.g. a "menu" key handler) legitimately has none to give.
    await menu.popup()
    return
  }

  // Convert webview CSS pixels to the window-relative logical pixels the native popup positioning
  // API expects: undo the app's own content zoom (Linux defaults to 1.15, so this is not optional
  // even at the "default" zoom), then add the CSD headerbar offset, which is a *window*-chrome
  // measurement and is therefore independent of that content zoom.
  const zoomFactor = await getCurrentWindowZoomFactor()
  const windowX = position.x * zoomFactor
  const windowY =
    position.y * zoomFactor +
    (position.hasNativeTitleBarChrome ? LINUX_CSD_HEADERBAR_HEIGHT : 0)

  await menu.popup(new LogicalPosition(windowX, windowY), getCurrentWindow())
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
