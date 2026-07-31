import type { UnlistenFn } from '@tauri-apps/api/event'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import { exit, relaunch } from '@tauri-apps/plugin-process'
import { getMainProcessConfig } from './config'
import { applicationUpdateController } from './updater'

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
        const cause =
          error instanceof Error
            ? error
            : new Error(
                error === undefined
                  ? 'Unknown native close error'
                  : String(error)
              )
        log.error('Failed to resolve native close request', cause)
      })
      .finally(() => {
        decisionPending = false
      })
  })
}

/**
 * Preserve upstream's platform close behavior: macOS always hides the last
 * window, while Linux/Windows follow the persisted preference.
 */
export function installDefaultCloseRequestHandler(
  isMacOS = __DARWIN__
): Promise<UnlistenFn> {
  return installCloseRequestHandler(async () => {
    let decision: CloseRequestDecision
    if ((await getAllWindows()).length > 1) {
      decision = 'close'
    } else if (isMacOS) {
      decision = 'hide'
    } else {
      decision = (await getMainProcessConfig()).hideWindowOnQuit
        ? 'hide'
        : 'quit'
    }

    // Hiding preserves the renderer and its native Update resource. An actual
    // close/quit would destroy the owner while transfer or installation is in
    // progress, so preserve upstream's installing-update warning instead.
    if (decision !== 'hide' && applicationUpdateController.isCloseBlocked) {
      applicationUpdateController.notifyCloseBlocked()
      return 'cancel'
    }
    return decision
  })
}
