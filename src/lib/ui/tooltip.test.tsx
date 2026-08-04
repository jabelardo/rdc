import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissAllTooltips, Tooltip } from './tooltip'

// jsdom reports every rect as zero, so the geometry under test has to be supplied. Illustrative
// numbers, not measurements: a bar whose centred control leaves bottom slack larger than the 7px
// gap, which is the case this boundary logic exists for.
//
// Worth knowing, because it was originally misread: the 1.95px the visual E2E once reported was
// *not* bar padding. It was `tooltip-appear` held at `translateY(-0.15rem)` while a stray
// `opacity: 1 !important` kept the bubble visible through the animation delay. That is fixed in
// App.css. This boundary behaviour is a separate, deliberate choice — clearance from the bar reads
// better than a bubble abutting its bottom rule — and these tests pin it on its own terms.
const barRect = {
  top: 40,
  bottom: 68.25,
  left: 0,
  right: 400,
  width: 400,
  height: 28.25,
}
const triggerRect = {
  top: 46,
  bottom: 59.3,
  left: 10,
  right: 34,
  width: 24,
  height: 13.3,
}
const bubbleRect = {
  top: 0,
  bottom: 20,
  left: 0,
  right: 120,
  width: 120,
  height: 20,
}

function stubRects() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const source = this.classList.contains('app-tooltip')
        ? bubbleRect
        : this.hasAttribute('data-tooltip-boundary')
          ? barRect
          : triggerRect
      return { ...source, x: source.left, y: source.top, toJSON: () => source }
    }
  )
}

function bubbleTop() {
  return screen.getByRole('tooltip').style.top
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Tooltip', () => {
  it('clears the whole command bar when its trigger sits inside one', async () => {
    stubRects()
    render(
      <div data-tooltip-boundary="">
        <Tooltip label="Fetch">
          <button type="button">Fetch</button>
        </Tooltip>
      </div>
    )

    await userEvent.hover(screen.getByRole('button', { name: 'Fetch' }))

    // The bar's bottom plus the 7px gap, rather than the button's bottom plus the same gap, which
    // would put the bubble inside the bar's lower padding.
    expect(bubbleTop()).toBe('75.25px')
  })

  it('clears only the trigger when there is no boundary', async () => {
    stubRects()
    render(
      <Tooltip label="Fetch">
        <button type="button">Fetch</button>
      </Tooltip>
    )

    await userEvent.hover(screen.getByRole('button', { name: 'Fetch' }))

    expect(bubbleTop()).toBe('66.3px')
  })

  it('describes its trigger while open', async () => {
    stubRects()
    render(
      <Tooltip label="Fetch">
        <button type="button">Fetch</button>
      </Tooltip>
    )
    const trigger = screen.getByRole('button', { name: 'Fetch' })

    expect(trigger.getAttribute('aria-describedby')).toBeNull()

    await userEvent.hover(trigger)

    expect(trigger.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip').id
    )
  })

  // Regression coverage for the macOS report: hovering a row's "more actions" button, then
  // clicking it to open a native context menu, left the tooltip visible behind the menu. Neither
  // `onBlur` fires — WebKit does not focus a <button> on an ordinary mouse click — nor does
  // `onMouseLeave`, since the native menu then owns the pointer. `dismissAllTooltips` is the only
  // path that closes it in that sequence, so this asserts closing it *without* touching either
  // event.
  it('closes on dismissAllTooltips without a blur or mouseleave event', async () => {
    stubRects()
    render(
      <Tooltip label="More actions for popular">
        <button type="button">More actions</button>
      </Tooltip>
    )

    await userEvent.hover(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    // `dismissAllTooltips` is called from plain application code (a controller function, not a
    // simulated DOM event), so the resulting `setOpen(false)` needs `act` to flush here — the
    // event wrappers above do that automatically.
    act(() => {
      dismissAllTooltips()
    })

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stops calling a tooltip once it unmounts', async () => {
    stubRects()
    const { unmount } = render(
      <Tooltip label="More actions">
        <button type="button">More actions</button>
      </Tooltip>
    )

    await userEvent.hover(screen.getByRole('button', { name: 'More actions' }))
    unmount()

    // Must not throw by calling a hide function whose component is gone.
    expect(() => dismissAllTooltips()).not.toThrow()
  })
})
