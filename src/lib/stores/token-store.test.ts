import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { TokenStore } = await import('./token-store')

describe('TokenStore', () => {
  beforeEach(() => invoke.mockReset())

  it('preserves the keytar-compatible set/get/delete contract', async () => {
    invoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('secret')
      .mockResolvedValueOnce(true)

    await expect(
      TokenStore.setItem('service', 'login', 'secret')
    ).resolves.toBeUndefined()
    await expect(TokenStore.getItem('service', 'login')).resolves.toBe('secret')
    await expect(TokenStore.deleteItem('service', 'login')).resolves.toBe(true)

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_credential', {
      service: 'service',
      login: 'login',
      value: 'secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_credential', {
      service: 'service',
      login: 'login',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'delete_credential', {
      service: 'service',
      login: 'login',
    })
  })
})
