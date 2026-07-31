import {
  Fragment,
  useCallback,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

const VirtualizationThreshold = 100
const DefaultViewportHeight = 480

export type VirtualListRow = {
  readonly virtualIndex: number
  readonly measureElement: (element: HTMLElement | null) => void
  readonly style: CSSProperties | undefined
  readonly focusIndex: (index: number) => void
}

type VirtualListProps<T> = {
  readonly ariaLabel: string
  readonly className: string
  readonly estimateSize: (index: number) => number
  readonly gap?: number
  readonly getItemKey: (item: T) => string | number
  readonly items: ReadonlyArray<T>
  readonly children: (item: T, index: number, row: VirtualListRow) => ReactNode
}

/**
 * Keep unbounded lists out of the DOM without changing their list semantics.
 *
 * The inner `ul` owns the accessible list while the outer element is only the
 * scroll viewport TanStack observes. Small lists stay complete in the DOM so
 * ordinary dialogs and tests do not pay the complexity cost of windowing.
 */
export function VirtualList<T>({
  ariaLabel,
  children,
  className,
  estimateSize,
  gap = 0,
  getItemKey,
  items,
}: VirtualListProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const virtualized = items.length > VirtualizationThreshold
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled: virtualized,
    estimateSize,
    gap,
    getItemKey: index => getItemKey(items[index]),
    getScrollElement: () => viewportRef.current,
    initialRect: {
      width: 320,
      height: DefaultViewportHeight,
    },
    overscan: 5,
  })

  const focusIndex = useCallback(
    (index: number) => {
      if (virtualized) {
        virtualizer.scrollToIndex(index)
      }
      const focus = () =>
        listRef.current
          ?.querySelector<HTMLElement>(`[data-keyboard-list-index="${index}"]`)
          ?.focus()
      focus()
      requestAnimationFrame(() => requestAnimationFrame(focus))
    },
    [virtualized, virtualizer]
  )

  const virtualItems = virtualized
    ? virtualizer.getVirtualItems()
    : items.map((_, index) => ({
        index,
        key: getItemKey(items[index]),
        start: 0,
      }))

  return (
    <div
      ref={viewportRef}
      className="virtual-list-viewport"
      data-virtualized={virtualized}
    >
      <ul
        ref={listRef}
        className={className}
        aria-label={ariaLabel}
        data-keyboard-list
        data-virtualized={virtualized}
        style={
          virtualized
            ? {
                height: virtualizer.getTotalSize(),
                position: 'relative',
              }
            : undefined
        }
      >
        {virtualItems.map(virtualItem => {
          const index = virtualItem.index
          const style: CSSProperties | undefined = virtualized
            ? {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }
            : undefined
          return (
            <Fragment key={virtualItem.key}>
              {children(items[index], index, {
                virtualIndex: index,
                measureElement: element => {
                  if (virtualized && element !== null) {
                    virtualizer.measureElement(element)
                  }
                },
                style,
                focusIndex,
              })}
            </Fragment>
          )
        })}
      </ul>
    </div>
  )
}
