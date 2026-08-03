import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { openUrl } from '@tauri-apps/plugin-opener'
import { quitApp } from '../../platform/lifetime'
import {
  getCurrentWindowZoomFactor,
  setWindowZoomFactor,
  toggleDevTools,
} from '../../platform/window'
import { selectAllWindowContents } from '../../platform/menu'

/**
 * The Linux/Windows in-window application menu, aligned with the MVP baseline
 * in qa/phase-8b/menu-mvp-alignment-checklist.md: the legacy upstream non-Darwin
 * template (labels with access keys, order, accelerators) minus everything not
 * ready for the MVP, plus every implemented product action. The full
 * `default-menu.ts` tree still backs keybindings; this component is the visible
 * surface and must agree with it on inventory, labels, accelerators and
 * enablement policy.
 */

type MenuBarAction =
  | { type: 'create-repository' }
  | { type: 'open-new-window' }
  | { type: 'add-local-repository' }
  | { type: 'clone-repository' }
  | { type: 'show-preferences' }
  | { type: 'quit' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'cut' }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'select-all' }
  | { type: 'show-changes' }
  | { type: 'show-history' }
  | { type: 'show-repository-list' }
  | { type: 'show-branches-list' }
  | { type: 'go-to-commit-message' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-reset' }
  | { type: 'expand-sidebar' }
  | { type: 'contract-sidebar' }
  | { type: 'reload' }
  | { type: 'toggle-devtools' }
  | { type: 'push' }
  | { type: 'pull' }
  | { type: 'fetch' }
  | { type: 'remove-repository' }
  | { type: 'open-in-shell' }
  | { type: 'open-working-directory' }
  | { type: 'open-external-editor' }
  | { type: 'create-branch' }
  | { type: 'rename-branch' }
  | { type: 'delete-branch' }
  | { type: 'discard-all-changes' }
  | { type: 'permanently-discard-all-changes' }
  | { type: 'report-issue' }
  | { type: 'view-rdc-on-github' }
  | { type: 'show-logs' }
  | { type: 'show-about' }

type MenuItem =
  | {
      readonly type: 'item'
      readonly id: string
      readonly label: string
      readonly accelerator?: string
      readonly action?: MenuBarAction
      readonly disabled?: boolean
    }
  | { readonly type: 'separator' }

type MenuDefinition = {
  readonly label: string
  readonly items: ReadonlyArray<MenuItem>
}

export type MenuBarProps = {
  readonly onCreateRepository: () => void
  readonly onAddExistingRepository: () => void
  readonly onCloneRepository: () => void
  readonly onShowPreferences: () => void
  readonly onShowAbout: () => void
  readonly onSelectView: (view: 'changes' | 'history') => void
  readonly onOpenNewWindow: () => void
  readonly onShowRepositoryList: () => void
  readonly onShowBranchesList: () => void
  readonly onGoToCommitMessage: () => void
  readonly onExpandSidebar: () => void
  readonly onContractSidebar: () => void
  readonly onShowFiles: () => void
  readonly onOpenEditor: () => void
  readonly onOpenShell: () => void
  readonly onFetch: () => void
  readonly onPush: () => void
  readonly onPull: () => void
  readonly onRemoveRepository: () => void
  readonly onNewBranch: () => void
  readonly onRenameBranch: () => void
  readonly onDeleteBranch: () => void
  readonly onDiscardAll: (permanent: boolean) => void
  readonly onShowLogs: () => void
  readonly hasRepository: boolean
  readonly hasRepositories: boolean
  readonly hasEditor: boolean
  readonly hasShell: boolean
  readonly canFetch: boolean
  readonly canPush: boolean
  readonly canPull: boolean
  readonly canCreateBranch: boolean
  readonly canRenameBranch: boolean
  readonly canDeleteBranch: boolean
  readonly canDiscardAll: boolean
  readonly selectedShell: string | null
  readonly selectedEditor: string | null
  readonly isDevelopment?: boolean
}

const separator = (): MenuItem => ({ type: 'separator' })

function item(
  id: string,
  label: string,
  accelerator: string | undefined,
  action: MenuBarAction,
  disabled = false
): MenuItem {
  return { type: 'item', id, label, accelerator, action, disabled }
}

/**
 * Split an access-key label ('New &repository…') into the text before the
 * mnemonic, the mnemonic character itself, and the text after it. Labels
 * without a mnemonic return `accessKey: null` and the whole label in `before`.
 */
export function parseAccessKeyLabel(label: string): {
  readonly before: string
  readonly accessKey: string | null
  readonly after: string
} {
  const index = label.indexOf('&')
  if (index === -1 || index === label.length - 1) {
    return { before: label, accessKey: null, after: '' }
  }
  return {
    before: label.slice(0, index),
    accessKey: label[index + 1],
    after: label.slice(index + 2),
  }
}

/** The plain label with its mnemonic marker removed, for aria-label text. */
export function accessKeyStrippedLabel(label: string): string {
  const { before, accessKey, after } = parseAccessKeyLabel(label)
  return accessKey === null ? before : `${before}${accessKey}${after}`
}

function AccessKeyText({ label }: { label: string }) {
  const { before, accessKey, after } = parseAccessKeyLabel(label)
  if (accessKey === null) {
    return <>{label}</>
  }
  return (
    <>
      {before}
      <u className="app-menu-access-key">{accessKey}</u>
      {after}
    </>
  )
}

const ZOOM_STEP = 0.05
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2.0

async function handleZoom(
  direction: 'zoom-in' | 'zoom-out' | 'zoom-reset'
): Promise<void> {
  const current = await getCurrentWindowZoomFactor()
  let next = current
  if (direction === 'zoom-reset') {
    next = 1
  } else if (direction === 'zoom-in') {
    next = Math.min(ZOOM_MAX, current + ZOOM_STEP)
  } else {
    next = Math.max(ZOOM_MIN, current - ZOOM_STEP)
  }
  await setWindowZoomFactor(next)
}

/** Native Edit roles operate on the focused element, like their OS roles. */
function runEditCommand(
  command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste'
): void {
  document.execCommand(command)
}

function executeAction(
  action: MenuBarAction | undefined,
  props: MenuBarProps
): void {
  if (action === undefined) {
    return
  }
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
    case 'open-new-window':
      props.onOpenNewWindow()
      break
    case 'show-repository-list':
      props.onShowRepositoryList()
      break
    case 'show-branches-list':
      props.onShowBranchesList()
      break
    case 'go-to-commit-message':
      props.onGoToCommitMessage()
      break
    case 'expand-sidebar':
      props.onExpandSidebar()
      break
    case 'contract-sidebar':
      props.onContractSidebar()
      break
    case 'open-working-directory':
      props.onShowFiles()
      break
    case 'open-external-editor':
      props.onOpenEditor()
      break
    case 'open-in-shell':
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
    case 'remove-repository':
      props.onRemoveRepository()
      break
    case 'create-branch':
      props.onNewBranch()
      break
    case 'rename-branch':
      props.onRenameBranch()
      break
    case 'delete-branch':
      props.onDeleteBranch()
      break
    case 'discard-all-changes':
      props.onDiscardAll(false)
      break
    case 'permanently-discard-all-changes':
      props.onDiscardAll(true)
      break
    case 'show-logs':
      props.onShowLogs()
      break
    case 'quit':
      void quitApp()
      break
    case 'undo':
    case 'redo':
    case 'cut':
    case 'copy':
    case 'paste':
      runEditCommand(action.type)
      break
    case 'select-all':
      selectAllWindowContents()
      break
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset':
      void handleZoom(action.type)
      break
    case 'reload':
      window.location.reload()
      break
    case 'toggle-devtools':
      void toggleDevTools().catch(() => undefined)
      break
    case 'report-issue':
      void openUrl('https://github.com/jabelardo/rdc/issues/new')
      break
    case 'view-rdc-on-github':
      void openUrl('https://github.com/jabelardo/rdc')
      break
  }
}

function buildMenu(
  props: MenuBarProps,
  isDevelopment: boolean
): readonly MenuDefinition[] {
  const shellLabel = props.selectedShell ?? 'shell'
  const editorLabel = props.selectedEditor ?? 'external editor'
  return [
    {
      label: '&File',
      items: [
        item('new-repository', 'New &repository…', 'Ctrl+N', {
          type: 'create-repository',
        }),
        item(
          'new-window',
          'Open new window',
          'Ctrl+Alt+N',
          { type: 'open-new-window' },
          !props.hasRepository
        ),
        separator(),
        item('add-local-repository', 'Add &local repository…', 'Ctrl+O', {
          type: 'add-local-repository',
        }),
        item('clone-repository', 'Clo&ne repository…', 'Ctrl+Shift+O', {
          type: 'clone-repository',
        }),
        separator(),
        item('preferences', '&Options…', 'Ctrl+,', {
          type: 'show-preferences',
        }),
        separator(),
        item('quit', 'E&xit', 'Ctrl+Q', { type: 'quit' }),
      ],
    },
    {
      label: '&Edit',
      items: [
        item('undo', '&Undo', 'Ctrl+Z', { type: 'undo' }),
        item('redo', '&Redo', 'Ctrl+Y', { type: 'redo' }),
        separator(),
        item('cut', 'Cu&t', 'Ctrl+X', { type: 'cut' }),
        item('copy', '&Copy', 'Ctrl+C', { type: 'copy' }),
        item('paste', '&Paste', 'Ctrl+V', { type: 'paste' }),
        item('select-all', 'Select &all', 'Ctrl+A', { type: 'select-all' }),
      ],
    },
    {
      label: '&View',
      items: [
        item(
          'show-changes',
          '&Changes',
          'Ctrl+1',
          { type: 'show-changes' },
          !props.hasRepository
        ),
        item(
          'show-history',
          '&History',
          'Ctrl+2',
          { type: 'show-history' },
          !props.hasRepository
        ),
        item(
          'show-repository-list',
          'Repository &list',
          'Ctrl+T',
          { type: 'show-repository-list' },
          !props.hasRepositories
        ),
        item(
          'show-branches-list',
          '&Branches list',
          'Ctrl+B',
          { type: 'show-branches-list' },
          !props.hasRepository
        ),
        separator(),
        item(
          'go-to-commit-message',
          'Go to &Summary',
          'Ctrl+G',
          { type: 'go-to-commit-message' },
          !props.hasRepository
        ),
        separator(),
        item('reset-zoom', 'Reset zoom', 'Ctrl+0', { type: 'zoom-reset' }),
        item('zoom-in', 'Zoom in', 'Ctrl+=', { type: 'zoom-in' }),
        item('zoom-out', 'Zoom out', 'Ctrl+-', { type: 'zoom-out' }),
        item(
          'increase-active-resizable-width',
          'Expand active resizable',
          'Ctrl+9',
          { type: 'expand-sidebar' }
        ),
        item(
          'decrease-active-resizable-width',
          'Contract active resizable',
          'Ctrl+8',
          { type: 'contract-sidebar' }
        ),
        ...(isDevelopment
          ? [
              separator(),
              item('reload-window', '&Reload', 'Ctrl+Alt+R', {
                type: 'reload',
              }),
              item('show-devtools', '&Toggle developer tools', 'Ctrl+Shift+I', {
                type: 'toggle-devtools',
              }),
            ]
          : []),
      ],
    },
    {
      label: '&Repository',
      items: [
        item('push', 'P&ush', 'Ctrl+P', { type: 'push' }, !props.canPush),
        item('pull', 'Pu&ll', 'Ctrl+Shift+P', { type: 'pull' }, !props.canPull),
        item(
          'fetch',
          '&Fetch',
          'Ctrl+Shift+T',
          { type: 'fetch' },
          !props.canFetch
        ),
        item(
          'remove-repository',
          '&Remove…',
          'Ctrl+Backspace',
          { type: 'remove-repository' },
          !props.hasRepository
        ),
        separator(),
        item(
          'open-in-shell',
          `O&pen in ${shellLabel}`,
          'Ctrl+`',
          { type: 'open-in-shell' },
          !props.hasShell || !props.hasRepository
        ),
        item(
          'open-working-directory',
          'Show in your File Manager',
          'Ctrl+Shift+F',
          { type: 'open-working-directory' },
          !props.hasRepository
        ),
        item(
          'open-external-editor',
          `&Open in ${editorLabel}`,
          'Ctrl+Shift+A',
          { type: 'open-external-editor' },
          !props.hasEditor || !props.hasRepository
        ),
      ],
    },
    {
      label: '&Branch',
      items: [
        item(
          'create-branch',
          'New &branch…',
          'Ctrl+Shift+N',
          { type: 'create-branch' },
          !props.canCreateBranch
        ),
        item(
          'rename-branch',
          '&Rename…',
          'Ctrl+Shift+R',
          { type: 'rename-branch' },
          !props.canRenameBranch
        ),
        item(
          'delete-branch',
          '&Delete…',
          'Ctrl+Shift+D',
          { type: 'delete-branch' },
          !props.canDeleteBranch
        ),
        separator(),
        item(
          'discard-all-changes',
          'Discard all changes…',
          'Ctrl+Shift+Backspace',
          { type: 'discard-all-changes' },
          !props.canDiscardAll
        ),
        item(
          'permanently-discard-all-changes',
          'Permanently discard all changes…',
          undefined,
          { type: 'permanently-discard-all-changes' },
          !props.canDiscardAll
        ),
      ],
    },
    {
      label: '&Help',
      items: [
        item('report-issue', 'Report issue…', undefined, {
          type: 'report-issue',
        }),
        item('view-rdc-on-github', 'View RDC on &GitHub', undefined, {
          type: 'view-rdc-on-github',
        }),
        item('show-logs', 'S&how logs in your File Manager', undefined, {
          type: 'show-logs',
        }),
        separator(),
        item('about', '&About RDC', undefined, { type: 'show-about' }),
      ],
    },
  ]
}

export function MenuBar(props: MenuBarProps) {
  const isDevelopment =
    props.isDevelopment ?? __RELEASE_CHANNEL__ === 'development'
  const menus = buildMenu(props, isDevelopment)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [activeTriggerIndex, setActiveTriggerIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([])

  const openMenuAt = useCallback(
    (index: number, viaKeyboard: boolean) => {
      setActiveTriggerIndex(index)
      setAnchor(triggerRefs.current[index])
      setOpenMenu(menus[index].label)
      if (viaKeyboard) {
        requestAnimationFrame(() => {
          const buttons =
            dropdownRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)'
            )
          buttons?.[0]?.focus()
        })
      }
    },
    [menus]
  )

  const closeMenu = useCallback(() => {
    setOpenMenu(null)
    triggerRefs.current[activeTriggerIndex]?.focus()
  }, [activeTriggerIndex])

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

  const focusTrigger = useCallback((index: number) => {
    setActiveTriggerIndex(index)
    triggerRefs.current[index]?.focus()
  }, [])

  const switchMenu = useCallback(
    (direction: 1 | -1, viaKeyboard: boolean) => {
      const openIndex = menus.findIndex(menu => menu.label === openMenu)
      const base = openIndex === -1 ? activeTriggerIndex : openIndex
      const next = (base + direction + menus.length) % menus.length
      openMenuAt(next, viaKeyboard)
    },
    [menus, openMenu, activeTriggerIndex, openMenuAt]
  )

  const onContainerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.length === 1
    ) {
      const key = event.key.toLowerCase()
      const index = menus.findIndex(
        menu => parseAccessKeyLabel(menu.label).accessKey?.toLowerCase() === key
      )
      if (index !== -1) {
        event.preventDefault()
        if (openMenu === menus[index].label) {
          setOpenMenu(null)
          triggerRefs.current[index]?.focus()
        } else {
          openMenuAt(index, true)
        }
      }
    }
  }

  const toggleMenu = (
    label: string,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (openMenu === label) {
      setOpenMenu(null)
      return
    }
    const index = menus.findIndex(menu => menu.label === label)
    setActiveTriggerIndex(index)
    setAnchor(event.currentTarget)
    setOpenMenu(label)
  }

  return (
    <div
      ref={menuRef}
      className="app-menu-bar"
      role="menubar"
      aria-label="Application menu"
      onKeyDown={onContainerKeyDown}
    >
      {menus.map((menu, index) => (
        <div key={menu.label} className="app-menu-trigger" role="none">
          <button
            ref={element => {
              triggerRefs.current[index] = element
            }}
            type="button"
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={openMenu === menu.label}
            aria-label={accessKeyStrippedLabel(menu.label)}
            tabIndex={index === activeTriggerIndex ? 0 : -1}
            onClick={event => toggleMenu(menu.label, event)}
            onMouseEnter={event => {
              if (openMenu !== null) {
                const hovered = menus.findIndex(
                  candidate => candidate.label === menu.label
                )
                setActiveTriggerIndex(hovered)
                setAnchor(event.currentTarget)
                setOpenMenu(menu.label)
              }
            }}
            onKeyDown={event => {
              switch (event.key) {
                case 'ArrowDown':
                case 'Enter':
                case ' ':
                  event.preventDefault()
                  openMenuAt(index, true)
                  break
                case 'ArrowRight':
                  event.preventDefault()
                  focusTrigger((index + 1) % menus.length)
                  if (openMenu !== null) {
                    openMenuAt((index + 1) % menus.length, true)
                  }
                  break
                case 'ArrowLeft':
                  event.preventDefault()
                  focusTrigger((index - 1 + menus.length) % menus.length)
                  if (openMenu !== null) {
                    openMenuAt((index - 1 + menus.length) % menus.length, true)
                  }
                  break
                case 'Escape':
                  if (openMenu !== null) {
                    event.preventDefault()
                    setOpenMenu(null)
                    triggerRefs.current[index]?.focus()
                  }
                  break
              }
            }}
          >
            <AccessKeyText label={menu.label} />
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
              onClose={closeMenu}
              onSwitchMenu={switchMenu}
            />
          )}
        </div>
      ))}
    </div>
  )
}

type MenuDropdownProps = {
  readonly items: ReadonlyArray<MenuItem>
  readonly anchor: HTMLElement | null
  readonly dropdownRef: React.Ref<HTMLDivElement>
  readonly onAction: (action: MenuBarAction | undefined) => void
  readonly onClose: () => void
  readonly onSwitchMenu: (direction: 1 | -1, viaKeyboard: boolean) => void
}

function MenuDropdown({
  items,
  anchor,
  dropdownRef,
  onAction,
  onClose,
  onSwitchMenu,
}: MenuDropdownProps) {
  const [position, setPosition] = useState<{
    top: number
    left: number
  } | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)

  const focusableIndices = useMemo(
    () =>
      items.flatMap((candidate, index) =>
        candidate.type === 'item' && !candidate.disabled ? [index] : []
      ),
    [items]
  )

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

  const moveFocus = (direction: 1 | -1) => {
    if (focusableIndices.length === 0) return
    const current = focusedIndex === null ? -1 : focusedIndex
    const positionInList = focusableIndices.indexOf(current)
    const nextPosition =
      direction === 1
        ? (positionInList + 1) % focusableIndices.length
        : (positionInList - 1 + focusableIndices.length) %
          focusableIndices.length
    itemRefs.current[focusableIndices[nextPosition]]?.focus()
  }

  return createPortal(
    <div
      ref={dropdownRef}
      className="app-menu-dropdown"
      role="menu"
      style={position ?? { visibility: 'hidden' }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault()
            moveFocus(1)
            break
          case 'ArrowUp':
            event.preventDefault()
            moveFocus(-1)
            break
          case 'Home':
            event.preventDefault()
            itemRefs.current[focusableIndices[0]]?.focus()
            break
          case 'End':
            event.preventDefault()
            itemRefs.current[
              focusableIndices[focusableIndices.length - 1]
            ]?.focus()
            break
          case 'ArrowRight':
            event.preventDefault()
            onSwitchMenu(1, true)
            break
          case 'ArrowLeft':
            event.preventDefault()
            onSwitchMenu(-1, true)
            break
          case 'Escape':
            event.preventDefault()
            onClose()
            break
          case 'Tab':
            event.preventDefault()
            onClose()
            break
          default:
            if (
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              event.key.length === 1
            ) {
              const key = event.key.toLowerCase()
              const index = items.findIndex(
                candidate =>
                  candidate.type === 'item' &&
                  !candidate.disabled &&
                  parseAccessKeyLabel(
                    candidate.label
                  ).accessKey?.toLowerCase() === key
              )
              if (index !== -1) {
                event.preventDefault()
                onAction(
                  items[index].type === 'item' ? items[index].action : undefined
                )
              }
            }
            break
        }
      }}
    >
      {items.map((candidate, index) => {
        if (candidate.type === 'separator') {
          return (
            <div key={index} className="app-menu-separator" role="separator" />
          )
        }
        return (
          <button
            key={index}
            ref={element => {
              itemRefs.current[index] = element
            }}
            type="button"
            role="menuitem"
            aria-label={accessKeyStrippedLabel(candidate.label)}
            disabled={candidate.disabled}
            onFocus={() => setFocusedIndex(index)}
            onClick={() => onAction(candidate.action)}
          >
            <span>
              <AccessKeyText label={candidate.label} />
            </span>
            {candidate.accelerator !== undefined && (
              <span className="app-menu-accelerator" aria-hidden="true">
                {candidate.accelerator}
              </span>
            )}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
