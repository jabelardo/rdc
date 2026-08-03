import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextMenuItem } from '../../../models/context-menu'

export type ContextMenuPosition = { readonly x: number; readonly y: number }

type AppContextMenuProps = {
  readonly items: ReadonlyArray<ContextMenuItem> | null
  readonly position: ContextMenuPosition | null
  readonly onClose: () => void
}

/**
 * The Linux/Windows in-window context menu, rendered in the webview instead of a
 * native popup.
 *
 * Rendering it here (like the app's in-window menu bar) avoids the native GTK
 * popup's two regressions: imprecise placement at non-100% zoom, and an input
 * grab that survives window focus loss and silently eats every subsequent click
 * (Close, Exit and further context triggers). The menu is positioned from the
 * trigger element's rect in the page's own coordinate space, so it is exact at
 * any zoom, and it closes on blur / click-away, so a window switch can never
 * leave the app wedged.
 */
export function AppContextMenu({
  items,
  position,
  onClose,
}: AppContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ top: number; left: number } | null>(
    null
  )
  const [visible, setVisible] = useState(false)

  // Close on window focus loss and on any pointer-down outside the menu. A DOM
  // menu owns no native grab, so this is all the dismissal that is needed and
  // focus loss cannot leave the app unresponsive.
  useEffect(() => {
    if (items === null) {
      return
    }
    const onBlur = () => onClose()
    const onPointerDown = (event: PointerEvent) => {
      if (
        menuRef.current !== null &&
        !menuRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [items, onClose])

  // Measure after mount and clamp to the viewport so a menu near the bottom or
  // right edge stays on screen.
  useLayoutEffect(() => {
    if (items === null || position === null) {
      setVisible(false)
      return
    }
    setVisible(false)
    const element = menuRef.current
    if (element === null) {
      return
    }
    const width = element.offsetWidth
    const height = element.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    let left = position.x
    let top = position.y
    if (left + width > viewportWidth) {
      left = Math.max(0, viewportWidth - width)
    }
    if (top + height > viewportHeight) {
      top = Math.max(0, viewportHeight - height)
    }
    setPlaced({ top, left })
    setVisible(true)
    element
      .querySelector<HTMLElement>(
        '[role="menuitem"]:not(:disabled):not([aria-hidden="true"])'
      )
      ?.focus()
  }, [items, position])

  if (items === null || position === null) {
    return null
  }

  const run = (item: ContextMenuItem) => {
    onClose()
    item.action?.()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="app-context-menu"
      role="menu"
      style={{
        position: 'fixed',
        top: placed?.top,
        left: placed?.left,
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      {items.map((item, index) =>
        item.type === 'separator' ? (
          <div
            key={index}
            className="app-context-menu-separator"
            role="separator"
          />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.enabled === false}
            aria-hidden={item.role === 'editMenu' ? 'true' : undefined}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}
