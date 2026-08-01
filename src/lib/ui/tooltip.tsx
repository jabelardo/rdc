import {
  Children,
  cloneElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type FocusEventHandler,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'

type TooltipTargetProps = {
  readonly disabled?: boolean
  readonly onMouseEnter?: MouseEventHandler<HTMLElement>
  readonly onMouseMove?: MouseEventHandler<HTMLElement>
  readonly onMouseLeave?: MouseEventHandler<HTMLElement>
  readonly onFocus?: FocusEventHandler<HTMLElement>
  readonly onBlur?: FocusEventHandler<HTMLElement>
  readonly 'aria-describedby'?: string
  readonly 'data-tooltip'?: string
}

type TooltipPosition = {
  readonly left: number
  readonly top: number
}

type TooltipProps = {
  readonly label: string
  readonly children: ReactElement
}

/**
 * One application-owned tooltip for pointer and keyboard users.
 *
 * The bubble is portalled to `body`: panes deliberately clip their content, so rendering the
 * bubble beside its trigger would make z-index ineffective at workspace boundaries.
 */
export function Tooltip({ label, children }: TooltipProps) {
  const id = useId()
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const anchorRect = useRef<DOMRect | null>(null)
  const pointerYRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const child = Children.only(children) as ReactElement<TooltipTargetProps>

  const show = (target: HTMLElement, clientY?: number) => {
    anchorRect.current = target.getBoundingClientRect()
    pointerYRef.current = clientY ?? null
    setPosition(null)
    setOpen(true)
  }
  const hide = () => {
    setOpen(false)
    setPosition(null)
    pointerYRef.current = null
  }

  useLayoutEffect(() => {
    if (!open || tooltipRef.current === null || anchorRect.current === null) {
      return
    }
    const bubble = tooltipRef.current.getBoundingClientRect()
    const anchor = anchorRect.current
    const margin = 8
    const titlebarGap = 36
    const gap = 7
    const desiredLeft = anchor.left + anchor.width / 2 - bubble.width / 2
    const left = Math.min(
      window.innerWidth - bubble.width - margin,
      Math.max(margin, desiredLeft)
    )

    let top: number
    if (anchor.height > 100) {
      const targetY = pointerYRef.current ?? anchor.top + anchor.height / 2
      top = Math.min(
        window.innerHeight - bubble.height - margin,
        Math.max(titlebarGap, targetY - bubble.height / 2)
      )
    } else {
      const below = anchor.bottom + gap
      top =
        below + bubble.height <= window.innerHeight - margin
          ? below
          : Math.max(titlebarGap, anchor.top - bubble.height - gap)
    }
    setPosition({ left, top })
  }, [open, label])

  const description = open ? id : child.props['aria-describedby']
  const bubble =
    open &&
    createPortal(
      <span
        ref={tooltipRef}
        id={id}
        className="app-tooltip"
        role="tooltip"
        style={
          position === null
            ? { visibility: 'hidden' }
            : { left: position.left, top: position.top }
        }
      >
        {label}
      </span>,
      document.body
    )

  if (child.props.disabled === true) {
    return (
      <span
        className="disabled-tooltip-anchor"
        data-tooltip={label}
        onMouseEnter={event => show(event.currentTarget, event.clientY)}
        onMouseLeave={hide}
      >
        {cloneElement(child, { 'aria-describedby': description })}
        {bubble}
      </span>
    )
  }

  return (
    <>
      {cloneElement(child, {
        'aria-describedby': description,
        'data-tooltip': label,
        onMouseEnter: (event: MouseEvent<HTMLElement>) => {
          child.props.onMouseEnter?.(event)
          show(event.currentTarget, event.clientY)
        },
        onMouseMove: (event: MouseEvent<HTMLElement>) => {
          if (anchorRect.current && anchorRect.current.height > 100) {
            pointerYRef.current = event.clientY
            if (open && tooltipRef.current && anchorRect.current) {
              const bubble = tooltipRef.current.getBoundingClientRect()
              const margin = 8
              const titlebarGap = 36
              const top = Math.min(
                window.innerHeight - bubble.height - margin,
                Math.max(titlebarGap, event.clientY - bubble.height / 2)
              )
              setPosition(prev => (prev ? { ...prev, top } : prev))
            }
          }
        },
        onMouseLeave: (event: MouseEvent<HTMLElement>) => {
          child.props.onMouseLeave?.(event)
          hide()
        },
        onFocus: (event: FocusEvent<HTMLElement>) => {
          child.props.onFocus?.(event)
          show(event.currentTarget)
        },
        onBlur: (event: FocusEvent<HTMLElement>) => {
          child.props.onBlur?.(event)
          hide()
        },
      })}
      {bubble}
    </>
  )
}
