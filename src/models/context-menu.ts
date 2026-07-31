export type ContextMenuItemType = 'separator' | 'checkbox'

/**
 * Electron expanded this placeholder into the platform edit menu. Its
 * Wayland-safe implementation moves with the text-input UI to Phase 7.
 */
export type ContextMenuRole = 'editMenu'

export interface ContextMenuItem {
  readonly label?: string
  readonly action?: () => void
  readonly type?: ContextMenuItemType
  readonly checked?: boolean
  readonly enabled?: boolean
  readonly role?: ContextMenuRole
  readonly submenu?: ReadonlyArray<ContextMenuItem>
}

/** Context-menu data after renderer-only callbacks have been removed. */
export interface SerializableContextMenuItem extends Omit<
  ContextMenuItem,
  'action' | 'submenu'
> {
  readonly submenu?: ReadonlyArray<SerializableContextMenuItem>
}
