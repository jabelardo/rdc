import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainProcessConfig } from '../../models/main-process-config'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { getMainProcessConfig, updateMainProcessConfig } =
  await import('./config')

describe('main-process config wire contract', () => {
  beforeEach(() => invoke.mockReset())

  it('uses typed get and partial-update commands', async () => {
    const config: MainProcessConfig = {
      titleBarStyle: 'native',
      hideWindowOnQuit: true,
    }
    invoke.mockResolvedValue(config)

    await expect(getMainProcessConfig()).resolves.toBe(config)
    await expect(
      updateMainProcessConfig({ hideWindowOnQuit: true })
    ).resolves.toBe(config)

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_main_process_config')
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'update_main_process_config',
      { configDiff: { hideWindowOnQuit: true } }
    )
  })
})
