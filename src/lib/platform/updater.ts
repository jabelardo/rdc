import {
  check as checkForTauriUpdate,
  type DownloadEvent,
} from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export type UpdateControllerStatus =
  | 'not-checked'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'not-available'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateControllerState {
  readonly status: UpdateControllerStatus
  readonly version?: string
  readonly contentLength?: number
  readonly downloadedBytes: number
  readonly error?: Error
}

interface UpdateHandle {
  readonly version: string
  download(onEvent?: (event: DownloadEvent) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

export interface UpdaterBackend {
  check(): Promise<UpdateHandle | null>
  relaunch(): Promise<void>
}

type Unsubscribe = () => void
type StateListener = (state: UpdateControllerState) => void
type ErrorListener = (error: Error) => void

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

const tauriBackend: UpdaterBackend = {
  check: checkForTauriUpdate,
  relaunch,
}

/**
 * Owns the complete updater lifecycle in one renderer.
 *
 * Squirrel exposed each transition as a main-process event. Tauri returns a
 * retained Update resource instead, so keeping the state machine beside that
 * resource avoids recreating six cross-process channels.
 */
export class UpdateController {
  private currentState: UpdateControllerState = {
    status: 'not-checked',
    downloadedBytes: 0,
  }
  private update: UpdateHandle | null = null
  private activeCheck: Promise<Error | undefined> | null = null
  private disposed = false
  private readonly stateListeners = new Set<StateListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  private readonly blockedCloseListeners = new Set<() => void>()

  public constructor(private readonly backend: UpdaterBackend = tauriBackend) {}

  public get state(): UpdateControllerState {
    return this.currentState
  }

  public get isCloseBlocked(): boolean {
    return (
      this.currentState.status === 'downloading' ||
      this.currentState.status === 'installing'
    )
  }

  public onDidChange(listener: StateListener): Unsubscribe {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  public onError(listener: ErrorListener): Unsubscribe {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  public onShowInstallingUpdate(listener: () => void): Unsubscribe {
    this.blockedCloseListeners.add(listener)
    return () => this.blockedCloseListeners.delete(listener)
  }

  public notifyCloseBlocked(): void {
    if (!this.isCloseBlocked) {
      return
    }
    for (const listener of this.blockedCloseListeners) {
      listener()
    }
  }

  /**
   * Coalesce concurrent checks and never replace an update which is already
   * downloaded. Tauri Update objects are native resources, not plain metadata.
   */
  public check(): Promise<Error | undefined> {
    if (this.disposed || this.update !== null) {
      return Promise.resolve(undefined)
    }
    if (this.activeCheck !== null) {
      return this.activeCheck
    }

    const operation = this.runCheck().finally(() => {
      if (this.activeCheck === operation) {
        this.activeCheck = null
      }
    })
    this.activeCheck = operation
    return operation
  }

  private async runCheck(): Promise<Error | undefined> {
    this.setState({ status: 'checking', downloadedBytes: 0 })
    let update: UpdateHandle | null = null
    try {
      update = await this.backend.check()
      if (update === null) {
        this.setState({ status: 'not-available', downloadedBytes: 0 })
        return undefined
      }
      if (this.disposed) {
        await update.close()
        return undefined
      }

      this.update = update
      this.setState({
        status: 'available',
        version: update.version,
        downloadedBytes: 0,
      })
      // Block destructive close as soon as the download is requested. Waiting
      // for the native Started event leaves a small window where the transfer
      // exists but close policy still sees only "available".
      this.setState({
        status: 'downloading',
        version: update.version,
        downloadedBytes: 0,
      })
      await update.download(event => this.onDownloadEvent(event))
      this.setState({
        ...this.currentState,
        status: 'ready',
        version: update.version,
      })
      return undefined
    } catch (value) {
      const error = asError(value)
      this.update = null
      if (update !== null) {
        await update.close().catch(() => undefined)
      }
      this.setState({
        status: 'error',
        downloadedBytes: this.currentState.downloadedBytes,
        error,
      })
      this.emitError(error)
      return error
    }
  }

  private onDownloadEvent(event: DownloadEvent): void {
    switch (event.event) {
      case 'Started':
        this.setState({
          status: 'downloading',
          version: this.update?.version,
          contentLength: event.data.contentLength,
          downloadedBytes: 0,
        })
        break
      case 'Progress':
        this.setState({
          ...this.currentState,
          status: 'downloading',
          downloadedBytes:
            this.currentState.downloadedBytes + event.data.chunkLength,
        })
        break
      case 'Finished':
        break
    }
  }

  public async quitAndInstall(): Promise<void> {
    const update = this.update
    if (update === null || this.currentState.status !== 'ready') {
      throw new Error('No downloaded update is ready to install')
    }

    this.setState({ ...this.currentState, status: 'installing' })
    try {
      await update.install()
      await this.backend.relaunch()
    } catch (value) {
      const error = asError(value)
      this.setState({ ...this.currentState, status: 'ready', error })
      this.emitError(error)
      throw value
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const update = this.update
    this.update = null
    this.stateListeners.clear()
    this.errorListeners.clear()
    this.blockedCloseListeners.clear()
    if (update !== null) {
      await update.close()
    }
  }

  private setState(state: UpdateControllerState): void {
    if (this.disposed) {
      return
    }
    this.currentState = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error)
    }
  }
}

export const applicationUpdateController = new UpdateController()

/**
 * The URL argument survives only as source compatibility. Tauri's signed
 * endpoint and public key are package configuration owned by Phase 9.
 */
export function checkForUpdates(_url: string): Promise<Error | undefined> {
  return applicationUpdateController.check()
}

export function quitAndInstallUpdate(): Promise<void> {
  return applicationUpdateController.quitAndInstall()
}

export function onAutoUpdaterError(listener: ErrorListener): Unsubscribe {
  return applicationUpdateController.onError(listener)
}

export function onAutoUpdaterCheckingForUpdate(
  listener: () => void
): Unsubscribe {
  return applicationUpdateController.onDidChange(state => {
    if (state.status === 'checking') {
      listener()
    }
  })
}

export function onAutoUpdaterUpdateAvailable(
  listener: () => void
): Unsubscribe {
  return applicationUpdateController.onDidChange(state => {
    if (state.status === 'available') {
      listener()
    }
  })
}

export function onAutoUpdaterUpdateNotAvailable(
  listener: () => void
): Unsubscribe {
  return applicationUpdateController.onDidChange(state => {
    if (state.status === 'not-available') {
      listener()
    }
  })
}

export function onAutoUpdaterUpdateDownloaded(
  listener: () => void
): Unsubscribe {
  return applicationUpdateController.onDidChange(state => {
    if (state.status === 'ready') {
      listener()
    }
  })
}

export function onShowInstallingUpdate(listener: () => void): Unsubscribe {
  return applicationUpdateController.onShowInstallingUpdate(listener)
}
