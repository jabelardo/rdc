import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeShowNotification = vi.hoisted(() => vi.fn())
const onNotificationEvent = vi.hoisted(() => vi.fn())
const focusWindow = vi.hoisted(() => vi.fn())

vi.mock('../platform/notifications', () => ({
  showNotification: nativeShowNotification,
  onNotificationEvent,
}))
vi.mock('../platform/window', () => ({ focusWindow }))

const {
  NotificationCallbackRegistry,
  initializeNotificationHandler,
} = await import('./notification-handler')
const { showNotification } = await import('./show-notification')

describe('notification callbacks', () => {
  beforeEach(() => {
    nativeShowNotification.mockReset()
    onNotificationEvent.mockReset()
    focusWindow.mockReset()
    focusWindow.mockResolvedValue(undefined)
  })

  it('keeps only the 200 newest callbacks', () => {
    const callbacks = new NotificationCallbackRegistry()
    const first = vi.fn()
    callbacks.set('0', first)
    for (let id = 1; id <= 200; id++) {
      callbacks.set(id.toString(), vi.fn())
    }

    expect(callbacks.size).toBe(200)
    expect(callbacks.take('0')).toBeUndefined()
    expect(callbacks.take('1')).toBeTypeOf('function')
  })

  it('stores a callback only after native display returns an id', async () => {
    const callbacks = new NotificationCallbackRegistry()
    const onClick = vi.fn()
    nativeShowNotification.mockResolvedValueOnce('41').mockResolvedValueOnce(null)

    await showNotification(
      {
        title: 'Review',
        body: 'A comment arrived',
        userInfo: { type: 'pr-comment' },
        onClick,
      },
      callbacks
    )
    await showNotification(
      { title: 'Unavailable', body: 'No native backend', onClick },
      callbacks
    )

    expect(nativeShowNotification).toHaveBeenNthCalledWith(
      1,
      'Review',
      'A comment arrived',
      { type: 'pr-comment' }
    )
    expect(callbacks.take('41')).toBe(onClick)
    expect(callbacks.size).toBe(0)
  })

  it('focuses and consumes the matching callback exactly once', async () => {
    const callbacks = new NotificationCallbackRegistry()
    const onClick = vi.fn()
    callbacks.set('7', onClick)
    let listener:
      | ((
          event: 'click',
          id: string,
          userInfo: Record<string, unknown> | undefined
        ) => void)
      | undefined
    const unlisten = vi.fn()
    onNotificationEvent.mockImplementation(async callback => {
      listener = callback
      return unlisten
    })
    const fallback = vi.fn()

    const cleanup = await initializeNotificationHandler(fallback, callbacks)
    listener?.('click', '7', { saved: true })
    listener?.('click', '7', { saved: true })
    cleanup()

    expect(focusWindow).toHaveBeenCalledTimes(2)
    expect(onClick).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledWith('click', '7', { saved: true })
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('sends an unmatched callback payload to the fallback', async () => {
    const callbacks = new NotificationCallbackRegistry()
    let listener:
      | ((
          event: 'click',
          id: string,
          userInfo: Record<string, unknown> | undefined
        ) => void)
      | undefined
    onNotificationEvent.mockImplementation(async callback => {
      listener = callback
      return vi.fn()
    })
    const fallback = vi.fn()
    await initializeNotificationHandler(fallback, callbacks)

    listener?.('click', 'old-id', {
      type: 'pr-checks-failed',
      pull_request_number: 12,
    })

    expect(fallback).toHaveBeenCalledWith('click', 'old-id', {
      type: 'pr-checks-failed',
      pull_request_number: 12,
    })
  })
})
