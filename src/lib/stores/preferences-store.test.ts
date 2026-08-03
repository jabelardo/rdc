import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Shell } from '../../models/shell'
import { PreferencesStore, PreferencesStorageKey } from './preferences-store'

/**
 * The zoom default is deliberately platform-dependent — Linux starts at 1.15 for Wayland/HiDPI
 * legibility, every other platform at 1.0. Tests must derive it rather than hardcode one platform's
 * value, or they only hold on that platform.
 */
const expectedDefaultZoomFactor = __LINUX__ ? 1.15 : 1

const editors = [
  { editor: 'Visual Studio Code', path: '/applications/code' },
  { editor: 'Zed', path: '/applications/zed' },
]
const shells = [
  { shell: Shell.Ghostty, path: '/applications/ghostty' },
  { shell: Shell.Terminal, path: '/applications/terminal' },
]

describe('PreferencesStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts with upstream-safe destructive defaults and system theme', () => {
    const store = new PreferencesStore()

    expect(store.state).toMatchObject({
      theme: 'system',
      confirmRepositoryRemoval: true,
      confirmDiscardChanges: true,
      confirmDiscardChangesPermanently: true,
      selectedExternalEditor: null,
      selectedShell: null,
    })
  })

  it('applies the stored theme and resolves installed integration identifiers', async () => {
    localStorage.setItem(
      PreferencesStorageKey,
      JSON.stringify({
        theme: 'dark',
        confirmRepositoryRemoval: false,
        confirmDiscardChanges: false,
        confirmDiscardChangesPermanently: false,
        selectedExternalEditor: 'Zed',
        selectedShell: Shell.Terminal,
      })
    )
    const setTheme = vi.fn(async () => undefined)
    const store = new PreferencesStore({
      getAvailableEditors: vi.fn(async () => editors),
      getAvailableShells: vi.fn(async () => shells),
      setTheme,
    })

    await store.load()

    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(store.state).toMatchObject({
      theme: 'dark',
      confirmRepositoryRemoval: false,
      confirmDiscardChanges: false,
      confirmDiscardChangesPermanently: false,
      selectedExternalEditor: 'Zed',
      selectedShell: Shell.Terminal,
      editors,
      shells,
      loading: false,
      error: null,
    })
    expect(store.selectedEditor).toEqual(editors[1])
    expect(store.selectedShell).toEqual(shells[1])
  })

  it('falls back to the first installed tools when stored choices disappeared', async () => {
    localStorage.setItem(
      PreferencesStorageKey,
      JSON.stringify({
        selectedExternalEditor: 'Missing Editor',
        selectedShell: Shell.Kitty,
      })
    )
    const store = new PreferencesStore({
      getAvailableEditors: vi.fn(async () => editors),
      getAvailableShells: vi.fn(async () => shells),
      setTheme: vi.fn(async () => undefined),
    })

    await store.load()

    expect(store.state.selectedExternalEditor).toBe('Visual Studio Code')
    expect(store.state.selectedShell).toBe(Shell.Ghostty)
    expect(
      JSON.parse(localStorage.getItem(PreferencesStorageKey)!)
    ).toMatchObject({
      selectedExternalEditor: 'Visual Studio Code',
      selectedShell: Shell.Ghostty,
    })
  })

  it('rejects malformed fields without discarding the valid ones', async () => {
    localStorage.setItem(
      PreferencesStorageKey,
      JSON.stringify({
        theme: 'sepia',
        confirmRepositoryRemoval: 'no',
        confirmDiscardChanges: false,
        selectedExternalEditor: 42,
        selectedShell: 'not-a-shell',
      })
    )
    const store = new PreferencesStore({
      getAvailableEditors: vi.fn(async () => []),
      getAvailableShells: vi.fn(async () => []),
      setTheme: vi.fn(async () => undefined),
    })

    await store.load()

    expect(store.state).toMatchObject({
      theme: 'system',
      confirmRepositoryRemoval: true,
      confirmDiscardChanges: false,
      selectedExternalEditor: null,
      selectedShell: null,
    })
  })

  it('persists changes and applies a changed theme immediately', async () => {
    const setTheme = vi.fn(async () => undefined)
    const store = new PreferencesStore({
      getAvailableEditors: vi.fn(async () => editors),
      getAvailableShells: vi.fn(async () => shells),
      setTheme,
    })
    await store.load()

    await store.setTheme('light')
    store.setConfirmRepositoryRemoval(false)
    store.setConfirmDiscardChanges(false)
    store.setConfirmDiscardChangesPermanently(false)
    store.setSelectedExternalEditor('Zed')
    store.setSelectedShell(Shell.Terminal)

    expect(setTheme).toHaveBeenLastCalledWith('light')
    expect(JSON.parse(localStorage.getItem(PreferencesStorageKey)!)).toEqual({
      theme: 'light',
      // Derived from the same build constant the store uses, not the literal 1.15. Zoom is not what
      // this test is about, and hardcoding the Linux value made the test pass on Linux and CI while
      // failing on macOS — a host-dependent assertion that reads as a product bug.
      zoomFactor: expectedDefaultZoomFactor,
      confirmRepositoryRemoval: false,
      confirmDiscardChanges: false,
      confirmDiscardChangesPermanently: false,
      selectedExternalEditor: 'Zed',
      selectedShell: Shell.Terminal,
    })
  })
})
