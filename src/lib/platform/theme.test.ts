import { beforeEach, describe, expect, it, vi } from 'vitest'

const setAppTheme = vi.hoisted(() => vi.fn())
const currentWindow = vi.hoisted(() => ({
  onThemeChanged: vi.fn(),
  setBackgroundColor: vi.fn(),
  theme: vi.fn(),
}))
const getCurrentWindow = vi.hoisted(() => vi.fn(() => currentWindow))

vi.mock('@tauri-apps/api/app', () => ({ setTheme: setAppTheme }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }))

const {
  onNativeThemeUpdated,
  setNativeThemeSource,
  shouldUseDarkColors,
  updateWindowBackgroundColor,
} = await import('./theme')

describe('native theme integration', () => {
  beforeEach(() => {
    setAppTheme.mockReset()
    setAppTheme.mockResolvedValue(undefined)
    getCurrentWindow.mockClear()
    for (const method of Object.values(currentWindow)) {
      method.mockReset()
      method.mockResolvedValue(undefined)
    }
  })

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', null],
  ] as const)('maps the %s source to Tauri application theme %s', async (source, expected) => {
    await setNativeThemeSource(source)

    expect(setAppTheme).toHaveBeenCalledWith(expected)
  })

  it.each([
    ['dark', true],
    ['light', false],
    [null, false],
  ] as const)('reports resolved theme %s as dark=%s', async (theme, expected) => {
    currentWindow.theme.mockResolvedValue(theme)

    await expect(shouldUseDarkColors()).resolves.toBe(expected)
  })

  it('adapts the theme payload to the upstream payload-free notification', async () => {
    const unlisten = vi.fn()
    const callback = vi.fn()
    currentWindow.onThemeChanged.mockImplementation(async handler => {
      handler({ payload: 'dark' })
      return unlisten
    })

    await expect(onNativeThemeUpdated(callback)).resolves.toBe(unlisten)

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith()
  })

  it('passes CSS colors to the current native window', async () => {
    await updateWindowBackgroundColor('#123456')

    expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith('#123456')
  })
})
