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
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const child = Children.only(children) as ReactElement<TooltipTargetProps>

  const show = (target: HTMLElement) => {
    anchorRect.current = target.getBoundingClientRect()
    setPosition(null)
    setOpen(true)
  }
  const hide = () => {
    setOpen(false)
    setPosition(null)
  }

  useLayoutEffect(() => {
    if (!open || tooltipRef.current === null || anchorRect.current === null) {
      return
    }
    const bubble = tooltipRef.current.getBoundingClientRect()
    const anchor = anchorRect.current
    const margin = 8
    const gap = 7
    const desiredLeft = anchor.left + anchor.width / 2 - bubble.width / 2
    const left = Math.min(
      window.innerWidth - bubble.width - margin,
      Math.max(margin, desiredLeft)
    )
    const below = anchor.bottom + gap
    const top =
      below + bubble.height <= window.innerHeight - margin
        ? below
        : Math.max(margin, anchor.top - bubble.height - gap)
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
        onMouseEnter={event => show(event.currentTarget)}
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
          show(event.currentTarget)
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
