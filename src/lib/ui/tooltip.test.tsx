import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './tooltip'

// jsdom reports every rect as zero, so the geometry under test has to be supplied. These are the
// real measurements taken from the Linux container when the overlap was first diagnosed: the
// command bar ends at 68.25 while its centred button ends at 59.3, i.e. ~9px of bottom slack —
// more than the 7px gap, which is why clearing only the trigger left the bubble on the bar.
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

    // The bar's bottom plus the 7px gap — not the button's bottom, which would be 66.3px and would
    // leave the bubble covering the bar's bottom rule by ~2px.
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
})
