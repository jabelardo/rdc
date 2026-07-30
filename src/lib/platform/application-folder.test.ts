import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const {
  isInApplicationFolder,
  moveToApplicationsFolder,
} = await import('./application-folder')

describe('macOS application-folder commands', () => {
  it('preserves the nullable query and move contracts', async () => {
    invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined)

    await expect(isInApplicationFolder()).resolves.toBe(false)
    await expect(moveToApplicationsFolder()).resolves.toBeUndefined()

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'is_in_application_folder'
    )
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'move_to_applications_folder'
    )
  })
})
