import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { quitApp } from '../../platform/lifetime'

type MenuBarAction =
  | { type: 'create-repository' }
  | { type: 'add-local-repository' }
  | { type: 'clone-repository' }
  | { type: 'show-preferences' }
  | { type: 'show-about' }
  | { type: 'show-changes' }
  | { type: 'show-history' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-reset' }
  | { type: 'open-in-new-window' }
  | { type: 'show-files' }
  | { type: 'open-editor' }
  | { type: 'open-shell' }
  | { type: 'fetch' }
  | { type: 'push' }
  | { type: 'pull' }
  | { type: 'show-logs' }
  | { type: 'quit' }

type MenuItem =
  | { type: 'item'; label: string; action?: MenuBarAction; disabled?: boolean }
  | { type: 'separator' }

type MenuBarProps = {
  readonly onCreateRepository: () => void
  readonly onAddExistingRepository: () => void
  readonly onCloneRepository: () => void
  readonly onShowPreferences: () => void
  readonly onShowAbout: () => void
  readonly onSelectView: (view: 'changes' | 'history') => void
  readonly repositoryView: 'changes' | 'history'
  readonly onOpenInNewWindow: () => void
  readonly onShowFiles: () => void
  readonly onOpenEditor: () => void
  readonly onOpenShell: () => void
  readonly onFetch: () => void
  readonly onPush: () => void
  readonly onPull: () => void
  readonly onShowLogs: () => void
  readonly hasRepository: boolean
  readonly hasEditor: boolean
  readonly hasShell: boolean
  readonly hasRemote: boolean
}

function executeAction(
  action: MenuBarAction | undefined,
  props: MenuBarProps
): void {
  if (action === undefined) return
  switch (action.type) {
    case 'create-repository':
      props.onCreateRepository()
      break
    case 'add-local-repository':
      props.onAddExistingRepository()
      break
    case 'clone-repository':
      props.onCloneRepository()
      break
    case 'show-preferences':
      props.onShowPreferences()
      break
    case 'show-about':
      props.onShowAbout()
      break
    case 'show-changes':
      props.onSelectView('changes')
      break
    case 'show-history':
      props.onSelectView('history')
      break
    case 'open-in-new-window':
      props.onOpenInNewWindow()
      break
    case 'show-files':
      props.onShowFiles()
      break
    case 'open-editor':
      props.onOpenEditor()
      break
    case 'open-shell':
      props.onOpenShell()
      break
    case 'fetch':
      props.onFetch()
      break
    case 'push':
      props.onPush()
      break
    case 'pull':
      props.onPull()
      break
    case 'show-logs':
      props.onShowLogs()
      break
    case 'quit':
      void quitApp()
      break
  }
}

function buildMenu(
  props: MenuBarProps
): readonly { label: string; items: readonly MenuItem[] }[] {
  const currentView = props.repositoryView
  return [
    {
      label: 'File',
      items: [
        {
          type: 'item',
          label: 'New Repository…',
          action: { type: 'create-repository' },
        },
        {
          type: 'item',
          label: 'Add Local Repository…',
          action: { type: 'add-local-repository' },
        },
        {
          type: 'item',
          label: 'Clone Repository…',
          action: { type: 'clone-repository' },
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Options…',
          action: { type: 'show-preferences' },
        },
        { type: 'separator' },
        { type: 'item', label: 'Exit', action: { type: 'quit' } },
      ],
    },
    {
      label: 'View',
      items: [
        {
          type: 'item',
          label: 'Changes',
          action: { type: 'show-changes' },
          disabled: currentView === 'changes',
        },
        {
          type: 'item',
          label: 'History',
          action: { type: 'show-history' },
          disabled: currentView === 'history',
        },
        { type: 'separator' },
        { type: 'item', label: 'Zoom In', action: { type: 'zoom-in' } },
        { type: 'item', label: 'Zoom Out', action: { type: 'zoom-out' } },
        { type: 'item', label: 'Reset Zoom', action: { type: 'zoom-reset' } },
      ],
    },
    {
      label: 'Repository',
      items: [
        {
          type: 'item',
          label: 'Open in New Window',
          action: { type: 'open-in-new-window' },
          disabled: !props.hasRepository,
        },
        {
          type: 'item',
          label: 'Show in File Manager',
          action: { type: 'show-files' },
          disabled: !props.hasRepository,
        },
        {
          type: 'item',
          label: 'Open in Editor',
          action: { type: 'open-editor' },
          disabled: !props.hasEditor,
        },
        {
          type: 'item',
          label: 'Open in Terminal',
          action: { type: 'open-shell' },
          disabled: !props.hasShell,
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Fetch',
          action: { type: 'fetch' },
          disabled: !props.hasRemote,
        },
        {
          type: 'item',
          label: 'Pull',
          action: { type: 'pull' },
          disabled: !props.hasRemote,
        },
        {
          type: 'item',
          label: 'Push',
          action: { type: 'push' },
          disabled: !props.hasRemote,
        },
      ],
    },
    {
      label: 'Help',
      items: [
        { type: 'item', label: 'Show Logs', action: { type: 'show-logs' } },
        { type: 'separator' },
        { type: 'item', label: 'About RDC', action: { type: 'show-about' } },
      ],
    },
  ]
}

export function MenuBar(props: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const closeIfOutside = useCallback((event: PointerEvent) => {
    const target = event.target as Node
    if (
      menuRef.current?.contains(target) ||
      dropdownRef.current?.contains(target)
    ) {
      return
    }
    setOpenMenu(null)
  }, [])

  useEffect(() => {
    if (openMenu === null) return
    window.addEventListener('pointerdown', closeIfOutside)
    return () => window.removeEventListener('pointerdown', closeIfOutside)
  }, [openMenu, closeIfOutside])

  const toggleMenu = (
    label: string,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (openMenu === label) {
      setOpenMenu(null)
      return
    }
    setAnchor(event.currentTarget)
    setOpenMenu(label)
  }

  const menus = buildMenu(props)

  return (
    <div
      ref={menuRef}
      className="app-menu-bar"
      role="menubar"
      aria-label="Application menu"
    >
      {menus.map(menu => (
        <div key={menu.label} className="app-menu-trigger" role="none">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={openMenu === menu.label}
            onClick={e => toggleMenu(menu.label, e)}
            onMouseEnter={e => {
              if (openMenu !== null) {
                setAnchor(e.currentTarget)
                setOpenMenu(menu.label)
              }
            }}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <MenuDropdown
              dropdownRef={dropdownRef}
              items={menu.items}
              anchor={anchor}
              onAction={action => {
                executeAction(action, props)
                setOpenMenu(null)
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

type MenuDropdownProps = {
  readonly items: readonly MenuItem[]
  readonly anchor: HTMLElement | null
  readonly dropdownRef: React.Ref<HTMLDivElement>
  readonly onAction: (action: MenuBarAction | undefined) => void
}

function MenuDropdown({
  items,
  anchor,
  dropdownRef,
  onAction,
}: MenuDropdownProps) {
  const [position, setPosition] = useState<{
    top: number
    left: number
  } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !dropdownRef) return
    const element = (dropdownRef as React.RefObject<HTMLDivElement>).current
    if (!element) return
    const rect = anchor.getBoundingClientRect()
    const dropdownWidth = element.offsetWidth
    const dropdownHeight = element.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = rect.left
    if (left + dropdownWidth > viewportWidth) {
      left = Math.max(0, viewportWidth - dropdownWidth)
    }
    let top = rect.bottom
    if (top + dropdownHeight > viewportHeight) {
      top = Math.max(0, rect.top - dropdownHeight)
    }
    setPosition({ top, left })
  }, [anchor, dropdownRef])

  return createPortal(
    <div
      ref={dropdownRef}
      className="app-menu-dropdown"
      role="menu"
      style={position ?? { visibility: 'hidden' }}
      onClick={e => e.stopPropagation()}
    >
      {items.map((item, index) => {
        if (item.type === 'separator') {
          return (
            <div key={index} className="app-menu-separator" role="separator" />
          )
        }
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => onAction(item.action)}
          >
            {item.label}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
