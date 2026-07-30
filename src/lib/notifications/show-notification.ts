import {
  showNotification as showNativeNotification,
  type NotificationUserInfo,
} from '../platform/notifications'
import {
  notificationCallbacks,
  type NotificationCallbackRegistry,
} from './notification-handler'

export interface ShowNotificationOptions {
  title: string
  body: string
  userInfo?: NotificationUserInfo
  onClick: () => void
}

export async function showNotification(
  options: ShowNotificationOptions,
  callbacks: NotificationCallbackRegistry = notificationCallbacks
): Promise<void> {
  const id = await showNativeNotification(
    options.title,
    options.body,
    options.userInfo
  )
  if (id !== null) {
    callbacks.set(id, options.onClick)
  }
}
