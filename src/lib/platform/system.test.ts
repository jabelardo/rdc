import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { getAppleActionOnDoubleClick } = await import('./system')

describe('platform system preferences', () => {
  it('reads the typed Apple title-bar double-click action', async () => {
    invoke.mockResolvedValue('Minimize')

    await expect(getAppleActionOnDoubleClick()).resolves.toBe('Minimize')
    expect(invoke).toHaveBeenCalledWith('get_apple_action_on_double_click')
  })
})
