import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  onNotificationEvent,
  type NotificationCallback,
  type NotificationUserInfo,
} from '../platform/notifications'
import { focusWindow } from '../platform/window'

const MaximumCallbacks = 200

export class NotificationCallbackRegistry {
  private readonly callbacks = new Map<string, () => void>()

  public set(id: string, callback: () => void): void {
    this.callbacks.delete(id)
    this.callbacks.set(id, callback)
    if (this.callbacks.size > MaximumCallbacks) {
      const oldest = this.callbacks.keys().next().value
      if (oldest !== undefined) {
        this.callbacks.delete(oldest)
      }
    }
  }

  public take(id: string): (() => void) | undefined {
    const callback = this.callbacks.get(id)
    this.callbacks.delete(id)
    return callback
  }

  public get size(): number {
    return this.callbacks.size
  }
}

export const notificationCallbacks = new NotificationCallbackRegistry()

export type NotificationFallback = (
  event: 'click',
  id: string,
  userInfo: NotificationUserInfo | undefined
) => void

export function initializeNotificationHandler(
  fallback: NotificationFallback,
  callbacks = notificationCallbacks
): Promise<UnlistenFn> {
  const onEvent: NotificationCallback = (event, id, userInfo) => {
    void focusWindow()
    const callback = callbacks.take(id)
    if (callback !== undefined) {
      callback()
    } else {
      fallback(event, id, userInfo)
    }
  }
  return onNotificationEvent(onEvent)
}
