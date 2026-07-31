import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn())
const save = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-dialog', () => ({ open, save }))

const { showOpenDialog, showSaveDialog } = await import('./dialogs')

describe('native file dialogs', () => {
  beforeEach(() => {
    open.mockReset()
    save.mockReset()
  })

  it('translates Electron directory properties and returns the first path', async () => {
    open.mockResolvedValue(['/first', '/second'])

    await expect(
      showOpenDialog({
        title: 'Choose',
        defaultPath: '/repos',
        properties: ['openDirectory', 'createDirectory', 'multiSelections'],
        filters: [{ name: 'Repositories', extensions: ['git'] }],
      })
    ).resolves.toBe('/first')

    expect(open).toHaveBeenCalledWith({
      title: 'Choose',
      defaultPath: '/repos',
      directory: true,
      canCreateDirectories: true,
      multiple: true,
      filters: [{ name: 'Repositories', extensions: ['git'] }],
    })
  })

  it.each([null, []])(
    'preserves cancellation represented as %j',
    async result => {
      open.mockResolvedValue(result)

      await expect(showOpenDialog({})).resolves.toBeNull()
    }
  )

  it('preserves a single-selection plugin result', async () => {
    open.mockResolvedValue('/chosen')

    await expect(showOpenDialog({})).resolves.toBe('/chosen')
  })

  it('maps supported save options and ignores Electron-only presentation fields', async () => {
    save.mockResolvedValue('/repos/new-name')

    await expect(
      showSaveDialog({
        title: 'Clone',
        defaultPath: '/repos/new-name',
        filters: [{ name: 'All', extensions: ['*'] }],
        properties: ['createDirectory'],
        buttonLabel: 'Select',
        nameFieldLabel: 'Clone As:',
        showsTagField: false,
      })
    ).resolves.toBe('/repos/new-name')

    expect(save).toHaveBeenCalledWith({
      title: 'Clone',
      defaultPath: '/repos/new-name',
      filters: [{ name: 'All', extensions: ['*'] }],
      canCreateDirectories: true,
    })
  })
})
