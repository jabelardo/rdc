import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { getGUID, saveGUID } = await import('./install-id')

describe('install ID wire contract', () => {
  beforeEach(() => invoke.mockReset())

  it('uses typed get and save commands', async () => {
    const guid = 'f50cbe67-f72a-45a2-97ad-20725a43db06'
    invoke.mockResolvedValueOnce(guid).mockResolvedValueOnce(undefined)

    await expect(getGUID()).resolves.toBe(guid)
    await expect(saveGUID(guid)).resolves.toBeUndefined()

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_guid')
    expect(invoke).toHaveBeenNthCalledWith(2, 'save_guid', { guid })
  })
})
