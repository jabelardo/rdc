import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { Tooltip } from './tooltip'

type HorizontalResizerProps = {
  readonly ariaLabel: string
  readonly className?: string
  readonly containerRef: RefObject<HTMLElement | null>
  readonly minimum: number
  readonly maximum?: number
  readonly oppositeMinimum: number
  readonly value: number
  readonly onResize: (value: number) => void
  readonly onMinimumHold?: () => void
  readonly minimumHoldDelay?: number
  readonly onMaximumHold?: () => void
  readonly maximumHoldDelay?: number
}

type PointerStart = {
  readonly pointerID: number
  readonly pointerX: number
  readonly value: number
}

const keyboardStep = 10

/** An accessible vertical separator that changes the width of the region on its left. */
export function HorizontalResizer({
  ariaLabel,
  className,
  containerRef,
  minimum,
  maximum: maximumLimit,
  oppositeMinimum,
  value,
  onResize,
  onMinimumHold,
  minimumHoldDelay = 350,
  onMaximumHold,
  maximumHoldDelay = 350,
}: HorizontalResizerProps) {
  const pointerStart = useRef<PointerStart | null>(null)
  const boundaryHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldBoundary = useRef<'minimum' | 'maximum' | null>(null)
  const [resisting, setResisting] = useState(false)
  const maximum = () =>
    Math.max(
      minimum,
      Math.min(
        maximumLimit ?? Number.POSITIVE_INFINITY,
        (containerRef.current?.getBoundingClientRect().width ??
          minimum + oppositeMinimum) - oppositeMinimum
      )
    )
  const bounded = (nextValue: number) =>
    Math.min(maximum(), Math.max(minimum, nextValue))

  const cancelBoundaryHold = () => {
    if (boundaryHoldTimer.current !== null) {
      clearTimeout(boundaryHoldTimer.current)
      boundaryHoldTimer.current = null
    }
    heldBoundary.current = null
    setResisting(false)
  }

  useEffect(
    () => () => {
      if (boundaryHoldTimer.current !== null) {
        clearTimeout(boundaryHoldTimer.current)
      }
    },
    []
  )

  const beginBoundaryHold = (
    boundary: 'minimum' | 'maximum',
    callback: (() => void) | undefined,
    delay: number
  ) => {
    if (callback === undefined) {
      cancelBoundaryHold()
      return
    }
    if (
      heldBoundary.current === boundary &&
      boundaryHoldTimer.current !== null
    ) {
      return
    }
    cancelBoundaryHold()
    heldBoundary.current = boundary
    setResisting(true)
    boundaryHoldTimer.current = setTimeout(() => {
      boundaryHoldTimer.current = null
      heldBoundary.current = null
      setResisting(false)
      callback()
    }, delay)
  }

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerStart.current?.pointerID !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    pointerStart.current = null
    cancelBoundaryHold()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextValue: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
        if (bounded(value) === minimum && onMinimumHold !== undefined) {
          event.preventDefault()
          onMinimumHold()
          return
        }
        nextValue = value - keyboardStep
        break
      case 'ArrowRight':
        if (bounded(value) === maximum() && onMaximumHold !== undefined) {
          event.preventDefault()
          onMaximumHold()
          return
        }
        nextValue = value + keyboardStep
        break
      case 'Home':
        nextValue = minimum
        break
      case 'End':
        nextValue = maximum()
        break
    }
    if (nextValue !== null) {
      event.preventDefault()
      onResize(bounded(nextValue))
    }
  }

  return (
    <Tooltip label={`${ariaLabel}. Drag or use the arrow keys.`}>
      <div
        className={`horizontal-resizer${className ? ` ${className}` : ''}${
          resisting ? ' is-resisting' : ''
        }`}
        role="separator"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={minimum}
        aria-valuemax={Math.round(maximum())}
        aria-valuenow={Math.round(bounded(value))}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={event => {
          pointerStart.current = {
            pointerID: event.pointerId,
            pointerX: event.clientX,
            value: bounded(value),
          }
          event.currentTarget.setPointerCapture?.(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={event => {
          const start = pointerStart.current
          if (start?.pointerID === event.pointerId) {
            const nextValue = start.value + event.clientX - start.pointerX
            onResize(bounded(nextValue))
            if (nextValue < minimum) {
              beginBoundaryHold('minimum', onMinimumHold, minimumHoldDelay)
            } else if (nextValue > maximum()) {
              beginBoundaryHold('maximum', onMaximumHold, maximumHoldDelay)
            } else {
              cancelBoundaryHold()
            }
          }
        }}
        onPointerUp={finishPointerResize}
        onPointerCancel={finishPointerResize}
      />
    </Tooltip>
  )
}
