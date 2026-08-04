import type {
  ContextMenuItem,
  SerializableContextMenuItem,
} from '../../models/context-menu'
import { invokeContextualMenu } from '../platform/menu'

/** Show a native contextual menu and invoke the renderer callback it selects. */
export async function showContextualMenu(
  items: ReadonlyArray<ContextMenuItem>,
  addSpellCheckMenu = false,
  x?: number,
  y?: number
): Promise<void> {
  const indices = await invokeContextualMenu(
    serializeContextMenuItems(items),
    addSpellCheckMenu,
    x,
    y
  )

  if (indices === null) {
    return
  }

  findContextMenuItem(items, indices)?.action?.()
}

function serializeContextMenuItems(
  items: ReadonlyArray<ContextMenuItem>
): ReadonlyArray<SerializableContextMenuItem> {
  return items.map(({ action: _action, submenu, ...item }) => ({
    ...item,
    ...(submenu === undefined
      ? {}
      : { submenu: serializeContextMenuItems(submenu) }),
  }))
}

function findContextMenuItem(
  items: ReadonlyArray<ContextMenuItem>,
  indices: ReadonlyArray<number>
): ContextMenuItem | undefined {
  let currentItems = items
  let found: ContextMenuItem | undefined

  for (const index of indices) {
    found = currentItems[index]
    if (found === undefined) {
      return undefined
    }
    currentItems = found.submenu ?? []
  }

  return found
}
