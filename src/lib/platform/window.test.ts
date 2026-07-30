import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ILaunchStats } from '../../models/launch-stats'
import type { CLIAction } from '../../models/cli-action'
import type { WindowState } from '../../models/window-state'

const currentWindow = vi.hoisted(() => ({
  close: vi.fn(),
  isFocused: vi.fn(),
  isFullscreen: vi.fn(),
  isMaximized: vi.fn(),
  isMinimized: vi.fn(),
  isVisible: vi.fn(),
  listen: vi.fn(),
  maximize: vi.fn(),
  minimize: vi.fn(),
  onFocusChanged: vi.fn(),
  onResized: vi.fn(),
  setFocus: vi.fn(),
  setTitle: vi.fn(),
  unmaximize: vi.fn(),
}))
const getCurrentWindow = vi.hoisted(() => vi.fn(() => currentWindow))
const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const {
  closeWindow,
  focusWindow,
  getCurrentWindowState,
  getCurrentWindowZoomFactor,
  isWindowFocused,
  isWindowMaximized,
  maximizeWindow,
  minimizeWindow,
  openRepositoryInNewWindow,
  onWindowFocusChanged,
  onWindowStateChanged,
  onWindowZoomFactorChanged,
  onLaunchTimingStats,
  restoreWindow,
  sendReady,
  setWindowSelectedRepository,
  setWindowTitle,
  setWindowZoomFactor,
} = await import('./window')

describe('current window controls', () => {
  beforeEach(() => {
    getCurrentWindow.mockClear()
    for (const method of Object.values(currentWindow)) {
      method.mockReset()
      method.mockResolvedValue(undefined)
    }
    currentWindow.isFocused.mockResolvedValue(false)
    currentWindow.isFullscreen.mockResolvedValue(false)
    currentWindow.isMaximized.mockResolvedValue(false)
    currentWindow.isMinimized.mockResolvedValue(false)
    currentWindow.isVisible.mockResolvedValue(true)
    invoke.mockReset()
  })

  it.each([
    ['focusWindow', focusWindow, 'setFocus'],
    ['minimizeWindow', minimizeWindow, 'minimize'],
    ['maximizeWindow', maximizeWindow, 'maximize'],
    ['restoreWindow', restoreWindow, 'unmaximize'],
    ['closeWindow', closeWindow, 'close'],
  ] as const)('%s delegates to the current Tauri window', async (_, action, method) => {
    await action()

    expect(getCurrentWindow).toHaveBeenCalledOnce()
    expect(currentWindow[method]).toHaveBeenCalledOnce()
  })

  it('preserves the upstream restore meaning of unmaximizing', async () => {
    await restoreWindow()

    expect(currentWindow.unmaximize).toHaveBeenCalledOnce()
    expect(currentWindow.maximize).not.toHaveBeenCalled()
  })

  it('reports whether the current window is focused', async () => {
    currentWindow.isFocused.mockResolvedValue(true)

    await expect(isWindowFocused()).resolves.toBe(true)

    expect(currentWindow.isFocused).toHaveBeenCalledOnce()
  })

  it('reports whether the current window is maximized', async () => {
    currentWindow.isMaximized.mockResolvedValue(true)

    await expect(isWindowMaximized()).resolves.toBe(true)

    expect(currentWindow.isMaximized).toHaveBeenCalledOnce()
  })

  it('sets the current window title without translating it', async () => {
    await setWindowTitle('Repository — rdc')

    expect(currentWindow.setTitle).toHaveBeenCalledWith('Repository — rdc')
  })

  it('stores and clears the selected repository through the window-scoped command', async () => {
    invoke.mockResolvedValue(undefined)

    await setWindowSelectedRepository('/repo/../repo')
    await setWindowSelectedRepository(null)

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'set_window_selected_repository',
      { repositoryPath: '/repo/../repo' }
    )
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'set_window_selected_repository',
      { repositoryPath: null }
    )
  })

  it('requests a fresh repository window without normalizing the path', async () => {
    invoke.mockResolvedValue(undefined)

    await openRepositoryInNewWindow('/repo/../repo')

    expect(invoke).toHaveBeenCalledWith(
      'open_repository_in_new_window',
      { repositoryPath: '/repo/../repo' }
    )
  })

  it('unwraps focus and blur events into one boolean subscription', async () => {
    const unlisten = vi.fn()
    const callback = vi.fn()
    currentWindow.onFocusChanged.mockImplementation(
      async (handler: (event: { payload: boolean }) => void) => {
        handler({ payload: true })
        handler({ payload: false })
        return unlisten
      }
    )

    await expect(onWindowFocusChanged(callback)).resolves.toBe(unlisten)

    expect(callback).toHaveBeenNthCalledWith(1, true)
    expect(callback).toHaveBeenNthCalledWith(2, false)
  })

  const stateCases: ReadonlyArray<
    readonly [
      WindowState,
      Partial<
        Record<'fullscreen' | 'maximized' | 'minimized' | 'visible', boolean>
      >,
    ]
  > = [
    ['full-screen', { fullscreen: true }],
    ['maximized', { maximized: true }],
    ['minimized', { minimized: true }],
    ['hidden', { visible: false }],
    ['normal', {}],
  ]

  it.each(stateCases)(
    'reports %s using the upstream state precedence',
    async (expected, state) => {
      currentWindow.isFullscreen.mockResolvedValue(
        state.fullscreen === true
      )
      currentWindow.isMaximized.mockResolvedValue(state.maximized === true)
      currentWindow.isMinimized.mockResolvedValue(state.minimized === true)
      currentWindow.isVisible.mockResolvedValue(state.visible !== false)

      await expect(getCurrentWindowState()).resolves.toBe(expected)
    }
  )

  it('re-reads state when the native window is resized', async () => {
    const unlisten = vi.fn()
    const callback = vi.fn()
    currentWindow.isMaximized.mockResolvedValue(true)
    currentWindow.onResized.mockImplementation(
      async (handler: () => void) => {
        await handler()
        return unlisten
      }
    )

    const cleanup = await onWindowStateChanged(callback)

    expect(callback).toHaveBeenCalledWith('maximized')

    cleanup()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('reports state transitions initiated through the wrapper', async () => {
    const callback = vi.fn()
    currentWindow.onResized.mockResolvedValue(vi.fn())
    currentWindow.isMinimized.mockResolvedValue(true)
    const cleanup = await onWindowStateChanged(callback)

    await minimizeWindow()

    expect(callback).toHaveBeenCalledWith('minimized')
    cleanup()
  })

  it('does not retain a state callback when native subscription fails', async () => {
    const callback = vi.fn()
    currentWindow.onResized.mockRejectedValue(new Error('listener failed'))

    await expect(onWindowStateChanged(callback)).rejects.toThrow(
      'listener failed'
    )

    currentWindow.isMinimized.mockResolvedValue(true)
    await minimizeWindow()
    expect(callback).not.toHaveBeenCalled()
  })

  it('gets and sets the Rust-owned zoom factor', async () => {
    invoke.mockResolvedValueOnce(1.25).mockResolvedValueOnce(undefined)

    await expect(getCurrentWindowZoomFactor()).resolves.toBe(1.25)
    await setWindowZoomFactor(1.5)

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_current_window_zoom_factor')
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_window_zoom_factor', {
      zoomFactor: 1.5,
    })
  })

  it('unwraps per-window zoom events', async () => {
    const unlisten = vi.fn()
    const callback = vi.fn()
    currentWindow.listen.mockImplementation(
      async (_name: string, handler: (event: { payload: number }) => void) => {
        handler({ payload: 1.1 })
        return unlisten
      }
    )

    await expect(onWindowZoomFactorChanged(callback)).resolves.toBe(unlisten)

    expect(currentWindow.listen).toHaveBeenCalledWith(
      'zoom-factor-changed',
      expect.any(Function)
    )
    expect(callback).toHaveBeenCalledWith(1.1)
  })

  it('reports readiness and returns a queued one-shot startup action', async () => {
    const action: CLIAction = {
      kind: 'open-repository',
      path: '/repo',
      persistSelection: false,
    }
    invoke.mockResolvedValue(action)

    await expect(sendReady(42.5)).resolves.toBe(action)

    expect(invoke).toHaveBeenCalledWith('renderer_ready', {
      rendererReadyTime: 42.5,
    })
  })

  it('unwraps launch timing events using the domain model', async () => {
    const unlisten = vi.fn()
    const callback = vi.fn()
    const stats: ILaunchStats = {
      mainReadyTime: 10,
      loadTime: 20,
      rendererReadyTime: 30,
    }
    currentWindow.listen.mockImplementation(
      async (
        _name: string,
        handler: (event: { payload: ILaunchStats }) => void
      ) => {
        handler({ payload: stats })
        return unlisten
      }
    )

    await expect(onLaunchTimingStats(callback)).resolves.toBe(unlisten)

    expect(currentWindow.listen).toHaveBeenCalledWith(
      'launch-timing-stats',
      expect.any(Function)
    )
    expect(callback).toHaveBeenCalledWith(stats)
  })
})
