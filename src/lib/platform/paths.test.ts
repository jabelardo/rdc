import { beforeEach, describe, expect, it, vi } from 'vitest'

const pathApi = vi.hoisted(() => ({
  appDataDir: vi.fn(),
  appLogDir: vi.fn(),
  dataDir: vi.fn(),
  desktopDir: vi.fn(),
  documentDir: vi.fn(),
  downloadDir: vi.fn(),
  homeDir: vi.fn(),
  pictureDir: vi.fn(),
  resourceDir: vi.fn(),
  tempDir: vi.fn(),
  videoDir: vi.fn(),
  audioDir: vi.fn(),
}))
const arch = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/path', () => pathApi)
vi.mock('@tauri-apps/plugin-os', () => ({ arch }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const {
  getAppArchitecture,
  getAppPathProxy,
  getExecPath,
  getPath,
  isRunningUnderARM64Translation,
} = await import('./paths')

describe('application paths and architecture', () => {
  beforeEach(() => {
    invoke.mockReset()
    arch.mockReset()
    for (const resolver of Object.values(pathApi)) {
      resolver.mockReset()
      resolver.mockResolvedValue('/resolved')
    }
  })

  it.each([
    ['home', 'homeDir'],
    ['appData', 'dataDir'],
    ['userData', 'appDataDir'],
    ['temp', 'tempDir'],
    ['desktop', 'desktopDir'],
    ['documents', 'documentDir'],
    ['downloads', 'downloadDir'],
    ['music', 'audioDir'],
    ['pictures', 'pictureDir'],
    ['videos', 'videoDir'],
    ['logs', 'appLogDir'],
  ] as const)('maps Electron path %s to Tauri %s', async (name, resolver) => {
    pathApi[resolver].mockResolvedValue(`/resolved/${name}`)

    await expect(getPath(name)).resolves.toBe(`/resolved/${name}`)
    expect(pathApi[resolver]).toHaveBeenCalledOnce()
  })

  it('maps the application path to the bundled resource directory', async () => {
    pathApi.resourceDir.mockResolvedValue('/app/resources')

    await expect(getAppPathProxy()).resolves.toBe('/app/resources')
  })

  it('gets the actual executable path from Rust', async () => {
    invoke.mockResolvedValue('/app/rdc')

    await expect(getExecPath()).resolves.toBe('/app/rdc')
    expect(invoke).toHaveBeenCalledWith('get_exec_path')
  })

  it.each([
    ['aarch64', false, 'arm64'],
    ['x86_64', false, 'x64'],
    ['x86_64', true, 'x64-emulated'],
  ] as const)(
    'maps %s with translation=%s to %s',
    async (nativeArch, translated, expected) => {
      arch.mockReturnValue(nativeArch)
      invoke.mockResolvedValue(translated)

      await expect(getAppArchitecture()).resolves.toBe(expected)
    }
  )

  it('exposes the translation query independently', async () => {
    invoke.mockResolvedValue(true)

    await expect(isRunningUnderARM64Translation()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      'is_running_under_arm64_translation'
    )
  })
})
