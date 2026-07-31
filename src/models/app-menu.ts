import type { MenuEvent } from './menu-event'

export type MenuItem =
  | IMenuItem
  | ISubmenuItem
  | ISeparatorMenuItem
  | ICheckboxMenuItem
  | IRadioMenuItem

export type ExecutableMenuItem = IMenuItem | ICheckboxMenuItem | IRadioMenuItem

/** Actions remain data so the same tree can drive React and the macOS native menu. */
export type MenuAction =
  | { readonly type: 'menu-event'; readonly event: MenuEvent }
  | { readonly type: 'open-external'; readonly url: string }
  | { readonly type: 'show-logs' }
  | { readonly type: 'zoom'; readonly direction: 'reset' | 'in' | 'out' }
  | { readonly type: 'reload-window' }
  | { readonly type: 'show-devtools' }
  | { readonly type: 'crash-main-process' }
  | { readonly type: 'quit' }

export type NativeMenuRole =
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'front'
  | 'window'
  | 'help'
  | 'togglefullscreen'

interface IBaseMenuItem {
  readonly id: string
  readonly enabled: boolean
  readonly visible: boolean
  readonly label: string
}

export interface IMenuItem extends IBaseMenuItem {
  readonly type: 'menuItem'
  readonly accessKey: string | null
  readonly action?: MenuAction
  readonly role?: NativeMenuRole
}

export interface ISubmenuItem extends IBaseMenuItem {
  readonly type: 'submenuItem'
  readonly menu: IMenu
  readonly accessKey: string | null
  readonly role?: NativeMenuRole
}

export interface ICheckboxMenuItem extends IBaseMenuItem {
  readonly type: 'checkbox'
  readonly accessKey: string | null
  readonly checked: boolean
  readonly action?: MenuAction
}

export interface IRadioMenuItem extends IBaseMenuItem {
  readonly type: 'radio'
  readonly accessKey: string | null
  readonly checked: boolean
  readonly action?: MenuAction
}

export interface ISeparatorMenuItem {
  readonly id: string
  readonly type: 'separator'
  readonly visible: boolean
}

export interface IMenu {
  readonly id?: string
  readonly type: 'menu'
  readonly items: ReadonlyArray<MenuItem>
  readonly selectedItem?: MenuItem
}

/**
 * Return a Windows access key while treating `&&` as an escaped literal
 * ampersand. Electron used to derive this while serializing its Menu; the
 * frontend-owned tree has to do it directly.
 */
export function getAccessKey(text: string): string | null {
  const match = text.match(/(?<!&)&([^&])/)
  return match ? match[1] : null
}

function buildIdMap(
  menu: IMenu,
  map = new Map<string, MenuItem>()
): Map<string, MenuItem> {
  for (const item of menu.items) {
    map.set(item.id, item)
    if (item.type === 'submenuItem') {
      buildIdMap(item.menu, map)
    }
  }
  return map
}

export function itemMayHaveAccessKey(
  item: MenuItem
): item is IMenuItem | ISubmenuItem | ICheckboxMenuItem | IRadioMenuItem {
  return (
    item.type === 'menuItem' ||
    item.type === 'submenuItem' ||
    item.type === 'checkbox' ||
    item.type === 'radio'
  )
}

export function itemIsSelectable(item: MenuItem) {
  return item.type !== 'separator' && item.enabled && item.visible
}

export function findItemByAccessKey(
  accessKey: string,
  items: ReadonlyArray<MenuItem>
): IMenuItem | ISubmenuItem | ICheckboxMenuItem | IRadioMenuItem | null {
  const lowerCaseAccessKey = accessKey.toLowerCase()
  for (const item of items) {
    if (
      itemMayHaveAccessKey(item) &&
      item.accessKey?.toLowerCase() === lowerCaseAccessKey
    ) {
      return item
    }
  }
  return null
}

/**
 * Immutable interaction state for the custom Linux/Windows application menu.
 * The tree itself is pure data and can be replaced whenever frontend state
 * produces new labels or enablement.
 */
export class AppMenu {
  public static fromMenu(menu: IMenu): AppMenu {
    return new AppMenu(menu, [menu], buildIdMap(menu))
  }

  private constructor(
    private readonly menu: IMenu,
    public readonly openMenus: ReadonlyArray<IMenu>,
    private readonly menuItemById: Map<string, MenuItem>
  ) {}

  public get rootMenu(): IMenu {
    return this.menu
  }

  public getItemById(id: string): MenuItem | undefined {
    return this.menuItemById.get(id)
  }

  public withMenu(newMenu: IMenu): AppMenu {
    const newMap = buildIdMap(newMenu)
    const newOpenMenus = new Array<IMenu>()

    for (const openMenu of this.openMenus) {
      let newOpenMenu: IMenu
      if (!openMenu.id) {
        newOpenMenu = newMenu
      } else {
        const item = newMap.get(openMenu.id)
        if (item?.type !== 'submenuItem') {
          break
        }
        newOpenMenu = item.menu
      }

      const newSelectedItem = openMenu.selectedItem
        ? newMap.get(openMenu.selectedItem.id)
        : undefined
      newOpenMenus.push({ ...newOpenMenu, selectedItem: newSelectedItem })
    }

    return new AppMenu(newMenu, newOpenMenus, newMap)
  }

  public withOpenedMenu(
    submenuItem: ISubmenuItem,
    selectFirstItem = false
  ): AppMenu {
    const ourMenuItem = this.menuItemById.get(submenuItem.id)
    if (!ourMenuItem) {
      return this
    }
    if (ourMenuItem.type !== 'submenuItem') {
      throw new Error(
        `Attempt to open a submenu from an item of wrong type: ${ourMenuItem.type}`
      )
    }

    const parentMenuIndex = this.openMenus.findIndex(menu =>
      menu.items.includes(ourMenuItem)
    )
    if (parentMenuIndex === -1) {
      return this
    }

    const newOpenMenus = this.openMenus.slice(0, parentMenuIndex + 1)
    const selectedItem = selectFirstItem
      ? ourMenuItem.menu.items.find(itemIsSelectable)
      : undefined
    newOpenMenus.push(
      selectedItem ? { ...ourMenuItem.menu, selectedItem } : ourMenuItem.menu
    )
    return new AppMenu(this.menu, newOpenMenus, this.menuItemById)
  }

  public withClosedMenu(menu: IMenu) {
    if (!menu.id) {
      return this
    }
    const index = this.openMenus.findIndex(
      candidate => candidate.id === menu.id
    )
    if (index === -1) {
      return this
    }
    return new AppMenu(
      this.menu,
      this.openMenus.slice(0, index),
      this.menuItemById
    )
  }

  public withLastMenu(menu: IMenu) {
    const index = this.openMenus.findIndex(
      candidate => candidate.id === menu.id
    )
    if (index === -1) {
      return this
    }
    return new AppMenu(
      this.menu,
      this.openMenus.slice(0, index + 1),
      this.menuItemById
    )
  }

  public withSelectedItem(menuItem: MenuItem) {
    const ourMenuItem = this.menuItemById.get(menuItem.id)
    if (!ourMenuItem) {
      return this
    }
    const parentMenuIndex = this.openMenus.findIndex(menu =>
      menu.items.includes(ourMenuItem)
    )
    if (parentMenuIndex === -1) {
      return this
    }

    const newOpenMenus = this.openMenus.slice()
    newOpenMenus[parentMenuIndex] = {
      ...newOpenMenus[parentMenuIndex],
      selectedItem: ourMenuItem,
    }
    for (
      let index = parentMenuIndex + 1;
      index < newOpenMenus.length;
      index++
    ) {
      newOpenMenus[index] = {
        ...newOpenMenus[index],
        selectedItem: undefined,
      }
    }
    for (let index = parentMenuIndex - 1; index >= 0; index--) {
      const menu = newOpenMenus[index]
      const childMenu = newOpenMenus[index + 1]
      const selectedItem = menu.items.find(
        item => item.type === 'submenuItem' && item.id === childMenu.id
      )
      newOpenMenus[index] = { ...menu, selectedItem }
    }
    return new AppMenu(this.menu, newOpenMenus, this.menuItemById)
  }

  public withDeselectedMenu(menu: IMenu) {
    const ourMenuIndex = this.openMenus.findIndex(
      candidate => candidate.id === menu.id
    )
    if (ourMenuIndex === -1) {
      return this
    }

    const newOpenMenus = this.openMenus.slice()
    newOpenMenus[ourMenuIndex] = {
      ...newOpenMenus[ourMenuIndex],
      selectedItem: undefined,
    }
    for (let index = ourMenuIndex - 1; index >= 0; index--) {
      const parent = newOpenMenus[index]
      const child = newOpenMenus[index + 1]
      const selectedItem = parent.items.find(
        item => item.type === 'submenuItem' && item.id === child.id
      )
      newOpenMenus[index] = { ...parent, selectedItem }
    }
    return new AppMenu(this.menu, newOpenMenus, this.menuItemById)
  }

  public withReset() {
    return new AppMenu(this.menu, [this.menu], this.menuItemById)
  }
}
