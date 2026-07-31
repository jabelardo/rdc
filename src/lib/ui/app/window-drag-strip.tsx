import { startWindowDragging } from '../../platform/window'
import { handleWindowTitleBarDoubleClick } from '../../platform/window-drag-region'

/** Native drag affordance for custom/overlay title bars. */
export function WindowDragStrip() {
  return (
    <div
      className="window-drag-region sticky top-0 z-[9] min-w-0 select-none [grid-column:1/-1] bg-[var(--color-surface-subtle)]"
      aria-hidden="true"
      onMouseDown={event => {
        if (event.button === 0 && event.detail === 1) {
          void startWindowDragging().catch(error => {
            log.error('Failed to start native window dragging', error)
          })
        }
      }}
      onDoubleClick={() => {
        void handleWindowTitleBarDoubleClick().catch(error => {
          log.error(
            'Failed to perform native title-bar double-click action',
            error
          )
        })
      }}
    />
  )
}
