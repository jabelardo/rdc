import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  getAllWindows,
  getCurrentWindow,
} from '@tauri-apps/api/window'
import { exit, relaunch } from '@tauri-apps/plugin-process'

export type CloseRequestDecision = 'quit' | 'hide' | 'close' | 'cancel'

/**
 * Exit only after the frontend has resolved any application-state policy.
 *
 * Unlike Electron's app.quit(), the process plugin exits directly. Callers
 * therefore decide whether quitting is allowed before invoking this function.
 */
export function quitApp(): Promise<void> {
  return exit(0)
}

/** Atomically replace the current process with a new application instance. */
export function restartApp(): Promise<void> {
  return relaunch()
}

/**
 * Replace Electron's will-quit/cancel-quitting flag exchange with one
 * renderer-owned decision at the native close boundary.
 *
 * Close is prevented synchronously before any asynchronous application-state
 * checks run. Repeated native requests share the pending decision instead of
 * opening duplicate confirmation UI.
 */
export function installCloseRequestHandler(
  decide: () => CloseRequestDecision | Promise<CloseRequestDecision>
): Promise<UnlistenFn> {
  const window = getCurrentWindow()
  let decisionPending = false

  return window.onCloseRequested(event => {
    event.preventDefault()
    if (decisionPending) {
      return
    }
    decisionPending = true

    void Promise.resolve()
      .then(decide)
      .then(async decision => {
        switch (decision) {
          case 'quit':
            await quitApp()
            break
          case 'hide':
            await window.hide()
            break
          case 'close':
            // `close()` would emit another preventable request. `destroy()`
            // performs the already-approved close without re-entering here.
            await window.destroy()
            break
          case 'cancel':
            break
        }
      })
      .catch(error => {
        log.error('Failed to resolve native close request', error)
      })
      .finally(() => {
        decisionPending = false
      })
  })
}

/**
 * Preserve upstream's current platform default until Phase 4b supplies the
 * non-macOS hideWindowOnQuit preference: macOS hides, other platforms quit.
 */
export function installDefaultCloseRequestHandler(
  isMacOS = __DARWIN__
): Promise<UnlistenFn> {
  return installCloseRequestHandler(async () => {
    if ((await getAllWindows()).length > 1) {
      return 'close'
    }
    return isMacOS ? 'hide' : 'quit'
  })
}
