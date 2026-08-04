export type ContextMenuItemType = 'separator' | 'checkbox'

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

export interface SerializableContextMenuItem extends Omit<
  ContextMenuItem,
  'action' | 'submenu'
> {
  readonly submenu?: ReadonlyArray<SerializableContextMenuItem>
}
