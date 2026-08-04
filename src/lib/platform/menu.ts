import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IMenu, MenuAction } from '../../models/app-menu'

export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke('set_native_menu', { menu })
}

/**
 * An item in a native contextual menu. Callers pass plain objects;
 * {@linkcode showContextMenu} maps each to a wire item the Rust side builds
 * a real menu item or separator from.
 */
export type ContextMenuItem =
  | {
      readonly text: string
      readonly enabled?: boolean
      readonly action?: () => void
      readonly type?: 'item' | undefined
    }
  | { readonly type: 'separator' }

/** Where a context menu was triggered, in screen-relative CSS pixels (`event.screenX/screenY`). */
export type ContextMenuPosition = { readonly x: number; readonly y: number }

const CONTEXT_MENU_EVENT = 'context-menu-event'

/**
 * Show a contextual menu via a custom Rust command (`show_context_menu_at`)
 * rather than the JS `Menu.popup()` API.
 *
 * Ported from Beaver-Notes' `show_edit_context_menu` (`dc692e7e`, issue
 * #429): `popup_menu_at` anchored with a position computed from the
 * window's own `outer_position`/`scale_factor`, on the theory that it might
 * sidestep the Wayland freeze this project hit anchoring through the JS
 * API. It doesn't — muda's GTK backend normalizes either entry point to the
 * same call before it ever reaches the code holding the ungated grab — but
 * it's kept as the literal port, verified on real hardware rather than
 * inferred from source alone.
 *
 * Each item gets a per-invocation id; the Rust side only ever hands that id
 * back (via `context-menu-event`), so the actual `action` closures never
 * cross the IPC boundary.
 */
export async function showContextMenu(
  items: ReadonlyArray<ContextMenuItem>,
  position: ContextMenuPosition
): Promise<void> {
  if (items.length === 0) {
    return
  }

  const actionById = new Map<string, () => void>()
  const wireItems = items.map((item, index) => {
    if (item.type === 'separator') {
      return { type: 'separator' as const }
    }
    const id = String(index)
    if (item.action !== undefined) {
      actionById.set(id, item.action)
    }
    return {
      type: 'item' as const,
      id,
      label: item.text,
      enabled: item.enabled ?? true,
    }
  })

  let selectedId: string | undefined
  const unlisten = await listen<string>(CONTEXT_MENU_EVENT, event => {
    if (actionById.has(event.payload)) {
      selectedId = event.payload
    }
  })
  try {
    await invoke('show_context_menu_at', {
      x: position.x,
      y: position.y,
      items: wireItems,
    })
  } finally {
    unlisten()
  }
  if (selectedId !== undefined) {
    actionById.get(selectedId)?.()
  }
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
