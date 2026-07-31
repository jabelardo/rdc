import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { ILaunchStats } from '../../models/launch-stats'
import type { OpenRepositoryAction } from '../../models/cli-action'
import type { WindowState } from '../../models/window-state'

const windowStateListeners = new Set<(state: WindowState) => void>()

async function notifyWindowStateChanged(): Promise<void> {
  if (windowStateListeners.size === 0) {
    return
  }

  const state = await getCurrentWindowState()
  for (const listener of windowStateListeners) {
    listener(state)
  }
}

/**
 * Window controls stay in the renderer because Tauri already scopes each call
 * to the window that owns the current webview.
 */
export function isWindowFocused(): Promise<boolean> {
  return getCurrentWindow().isFocused()
}

export function focusWindow(): Promise<void> {
  return getCurrentWindow().setFocus()
}

export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize()
  await notifyWindowStateChanged()
}

export async function maximizeWindow(): Promise<void> {
  await getCurrentWindow().maximize()
  await notifyWindowStateChanged()
}

export async function restoreWindow(): Promise<void> {
  await getCurrentWindow().unmaximize()
  await notifyWindowStateChanged()
}

export function closeWindow(): Promise<void> {
  return getCurrentWindow().close()
}

export function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized()
}

export function startWindowDragging(): Promise<void> {
  return getCurrentWindow().startDragging()
}

export function setWindowTitle(title: string): Promise<void> {
  return getCurrentWindow().setTitle(title)
}

/** Match native modal behavior without notifying an already-focused app. */
export async function sendDialogDidOpen(): Promise<void> {
  const window = getCurrentWindow()
  if (await window.isFocused()) {
    return
  }
  if (__DARWIN__) {
    await invoke('beep')
  }
  await window.requestUserAttention(UserAttentionType.Critical)
}

/**
 * Record the repository selected in this window for native-process routing.
 * Rust stores the value verbatim; the future routing operation owns path
 * normalization and most-specific-window matching, as upstream did.
 */
export function setWindowSelectedRepository(
  repositoryPath: string | null
): Promise<void> {
  return invoke('set_window_selected_repository', { repositoryPath })
}

/** Create a distinct native window and queue its one-shot repository action. */
export function openRepositoryInNewWindow(
  repositoryPath: string
): Promise<void> {
  return invoke('open_repository_in_new_window', { repositoryPath })
}

/**
 * Electron exposed focus and blur as separate IPC channels. Tauri reports
 * both transitions through one window-scoped boolean event.
 */
export function onWindowFocusChanged(
  callback: (focused: boolean) => void
): Promise<UnlistenFn> {
  return getCurrentWindow().onFocusChanged(event => callback(event.payload))
}

/** Read state in the same precedence order as upstream's BrowserWindow helper. */
export async function getCurrentWindowState(): Promise<WindowState> {
  const window = getCurrentWindow()

  if (await window.isFullscreen()) {
    return 'full-screen'
  }
  if (await window.isMaximized()) {
    return 'maximized'
  }
  if (await window.isMinimized()) {
    return 'minimized'
  }
  if (!(await window.isVisible())) {
    return 'hidden'
  }
  return 'normal'
}

/**
 * Tauri has no maximized/minimized event, but native state transitions resize
 * the window. Wrapper-initiated transitions also notify directly; duplicate
 * events are permitted by the upstream contract.
 */
export async function onWindowStateChanged(
  callback: (state: WindowState) => void
): Promise<UnlistenFn> {
  windowStateListeners.add(callback)
  let unlisten: UnlistenFn
  try {
    unlisten = await getCurrentWindow().onResized(async () => {
      callback(await getCurrentWindowState())
    })
  } catch (error) {
    windowStateListeners.delete(callback)
    throw error
  }

  return () => {
    windowStateListeners.delete(callback)
    unlisten()
  }
}

export function getCurrentWindowZoomFactor(): Promise<number> {
  return invoke<number>('get_current_window_zoom_factor')
}

export function setWindowZoomFactor(zoomFactor: number): Promise<void> {
  return invoke('set_window_zoom_factor', { zoomFactor })
}

export function onWindowZoomFactorChanged(
  callback: (zoomFactor: number) => void
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<number>('zoom-factor-changed', event =>
    callback(event.payload)
  )
}

/** Tell Rust that the renderer has completed its initial application load. */
export function sendReady(
  rendererReadyTime: number
): Promise<OpenRepositoryAction | null> {
  return invoke('renderer_ready', { rendererReadyTime })
}

export function onLaunchTimingStats(
  callback: (stats: ILaunchStats) => void
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<ILaunchStats>('launch-timing-stats', event =>
    callback(event.payload)
  )
}
