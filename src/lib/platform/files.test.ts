import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const openPath = vi.hoisted(() => vi.fn())
const openUrl = vi.hoisted(() => vi.fn())
const revealItemInDir = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath,
  openUrl,
  revealItemInDir,
}))

const {
  moveItemToTrash,
  openExternal,
  showFolderContents,
  showItemInFolder,
  unsafeOpenDirectory,
} = await import('./files')

describe('native file operations', () => {
  beforeEach(() => {
    invoke.mockReset()
    openPath.mockReset()
    openUrl.mockReset()
    revealItemInDir.mockReset()
    openPath.mockResolvedValue(undefined)
    openUrl.mockResolvedValue(undefined)
    revealItemInDir.mockResolvedValue(undefined)
  })

  it.each(['https://example.com', 'http://example.com', 'mailto:a@example.com'])(
    'opens URL %s with the URL-scoped plugin command',
    async url => {
      await expect(openExternal(url)).resolves.toBe(true)
      expect(openUrl).toHaveBeenCalledWith(url)
    }
  )

  it('opens file URLs as paths and preserves the upstream boolean result', async () => {
    await expect(openExternal('file:///tmp/a.txt')).resolves.toBe(true)
    expect(openPath).toHaveBeenCalledWith('/tmp/a.txt')

    openPath.mockRejectedValue(new Error('no association'))
    await expect(openExternal('/tmp/a.txt')).resolves.toBe(false)
  })

  it('reveals an item and absorbs native failures like upstream', async () => {
    revealItemInDir.mockRejectedValue(new Error('missing'))

    await expect(showItemInFolder('/tmp/missing')).resolves.toBeUndefined()
  })

  it.each([
    ['open', 'openPath'],
    ['reveal', 'revealItemInDir'],
  ] as const)('uses the Rust-classified %s folder action', async (action, method) => {
    invoke.mockResolvedValue(action)

    await showFolderContents('/tmp/repository')

    expect({ openPath, revealItemInDir }[method]).toHaveBeenCalledWith(
      '/tmp/repository'
    )
  })

  it('does nothing when folder classification cannot read the path', async () => {
    invoke.mockResolvedValue(null)

    await showFolderContents('/tmp/missing')

    expect(openPath).not.toHaveBeenCalled()
    expect(revealItemInDir).not.toHaveBeenCalled()
  })

  it('absorbs folder classification failures like upstream', async () => {
    invoke.mockRejectedValue(new Error('permission denied'))

    await expect(
      showFolderContents('/tmp/unreadable')
    ).resolves.toBeUndefined()

    expect(openPath).not.toHaveBeenCalled()
    expect(revealItemInDir).not.toHaveBeenCalled()
  })

  it('opens an already validated directory without reclassification', async () => {
    await unsafeOpenDirectory('/tmp/safe')

    expect(openPath).toHaveBeenCalledWith('/tmp/safe')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('moves items through the recoverable Rust trash command', async () => {
    invoke.mockResolvedValue(undefined)

    await moveItemToTrash('/tmp/old')

    expect(invoke).toHaveBeenCalledWith('move_item_to_trash', {
      path: '/tmp/old',
    })
  })
})
