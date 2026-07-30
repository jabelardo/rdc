import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type DesktopNotificationPermission = 'default' | 'granted' | 'denied'
export type NotificationUserInfo = Record<string, unknown>
export type NotificationCallback = (
  event: 'click',
  id: string,
  userInfo: NotificationUserInfo | undefined
) => void

export function showNotification(
  title: string,
  body: string,
  userInfo?: NotificationUserInfo
): Promise<string | null> {
  return invoke<string | null>('show_notification', { title, body, userInfo })
}

export function getNotificationsPermission(): Promise<DesktopNotificationPermission> {
  return invoke('get_notifications_permission')
}

export function requestNotificationsPermission(): Promise<boolean> {
  return invoke('request_notifications_permission')
}

function isUserInfo(value: unknown): value is NotificationUserInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

interface NotificationEventPayload {
  event: 'click'
  id: string
  userInfo?: NotificationUserInfo
}

function isNotificationEventPayload(
  value: unknown
): value is NotificationEventPayload {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<NotificationEventPayload>
  return (
    candidate.event === 'click' &&
    typeof candidate.id === 'string' &&
    (candidate.userInfo === undefined || isUserInfo(candidate.userInfo))
  )
}

export async function onNotificationEvent(
  callback: NotificationCallback
): Promise<UnlistenFn> {
  return listen<unknown>('notification-event', ({ payload }) => {
    if (isNotificationEventPayload(payload)) {
      callback(payload.event, payload.id, payload.userInfo)
    }
  })
}
