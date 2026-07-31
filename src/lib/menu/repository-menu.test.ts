import { describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '../../models/app-menu'
import type { Repository } from '../../models/repository'
import {
  buildRepositoryMenu,
  createRepositoryMenuEventExecutor,
} from './repository-menu'
import type { RemoteState } from '../stores/remote-store'
import type { PreferencesState } from '../stores/preferences-store'
import { createStartupMenuActionExecutor } from './startup'

const repository = {
  id: 7,
  name: 'rdc',
  path: '/projects/rdc',
} as Repository

const remoteState = {
  repositoryPath: repository.path,
  remotes: [{ name: 'origin', url: '/remotes/origin.git' }],
  currentRemote: { name: 'origin', url: '/remotes/origin.git' },
  currentBranch: {
    name: 'main',
    upstream: 'origin/main',
  } as RemoteState['currentBranch'],
  loading: false,
  error: null,
  operation: null,
  progress: null,
  operationError: null,
} satisfies RemoteState

const preferencesState = {
  theme: 'system',
  confirmRepositoryRemoval: true,
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  selectedExternalEditor: 'Zed',
  selectedShell: 'Ghostty',
  editors: [{ editor: 'Zed', path: '/applications/zed' }],
  shells: [{ shell: 'Ghostty', path: '/applications/ghostty' }],
  loading: false,
  error: null,
} as PreferencesState

function allItems(items: ReadonlyArray<MenuItem>): ReadonlyArray<MenuItem> {
  return items.flatMap(item =>
    item.type === 'submenuItem' ? [item, ...allItems(item.menu.items)] : [item]
  )
}

describe('repository application menu', () => {
  it('keeps repository actions disabled until a repository is selected', () => {
    const menu = buildRepositoryMenu(
      { repositories: [], selectedRepository: null },
      'macos'
    )
    const appMenu = menu.items.flatMap(item =>
      item.type === 'submenuItem' ? [item, ...item.menu.items] : [item]
    )
    const byId = (id: string) => appMenu.find(item => item.id === id)

    expect(byId('add-local-repository')).toMatchObject({ enabled: true })
    expect(byId('clone-repository')).toMatchObject({ enabled: true })
    expect(byId('new-window')).toMatchObject({ enabled: false })
    expect(byId('show-repository-list')).toMatchObject({ enabled: false })
    expect(byId('repository')).toMatchObject({ enabled: false })
    expect(byId('remove-repository')).toMatchObject({ enabled: false })
    expect(byId('open-working-directory')).toMatchObject({
      enabled: false,
    })
    expect(byId('pull')).toMatchObject({ enabled: false })
  })

  it('enables only the Phase 7a repository actions backed by the shell', () => {
    const menu = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      'linux'
    )
    const appMenu = menu.items.flatMap(item =>
      item.type === 'submenuItem' ? [item, ...item.menu.items] : [item]
    )
    const byId = (id: string) => appMenu.find(item => item.id === id)

    expect(byId('show-repository-list')).toMatchObject({ enabled: true })
    expect(byId('new-window')).toMatchObject({ enabled: true })
    expect(byId('repository')).toMatchObject({ enabled: true })
    expect(byId('remove-repository')).toMatchObject({ enabled: true })
    expect(byId('open-working-directory')).toMatchObject({
      enabled: true,
    })
    expect(byId('pull')).toMatchObject({ enabled: false })
    expect(byId('show-changes')).toMatchObject({ enabled: true })
    expect(byId('show-history')).toMatchObject({ enabled: true })
  })

  it('enables synchronization only with usable remote state and no operation', () => {
    const enabled = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      'linux',
      remoteState
    )
    const busy = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      'linux',
      { ...remoteState, operation: 'fetch' }
    )
    const byId = (menu: typeof enabled, id: string) =>
      menu.items
        .flatMap(item =>
          item.type === 'submenuItem' ? [item, ...item.menu.items] : [item]
        )
        .find(item => item.id === id)

    expect(byId(enabled, 'fetch')).toMatchObject({ enabled: true })
    expect(byId(busy, 'fetch')).toMatchObject({ enabled: false })
    expect(byId(enabled, 'pull')).toMatchObject({ enabled: true })
    expect(byId(enabled, 'push')).toMatchObject({ enabled: true })
  })

  it('enables preferences globally and installed integration actions for a selection', () => {
    const menu = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      'linux',
      remoteState,
      preferencesState
    )
    const items = menu.items.flatMap(item =>
      item.type === 'submenuItem' ? [item, ...item.menu.items] : [item]
    )
    const byId = (id: string) => items.find(item => item.id === id)

    expect(byId('preferences')).toMatchObject({ enabled: true })
    expect(byId('about')).toMatchObject({ enabled: true })
    expect(byId('remove-repository')).toMatchObject({
      enabled: true,
      label: '&Remove…',
    })
    expect(byId('open-in-shell')).toMatchObject({
      enabled: true,
      label: 'O&pen in Ghostty',
    })
    expect(byId('open-external-editor')).toMatchObject({
      enabled: true,
      label: '&Open in Zed',
    })
  })

  it.each(['macos', 'windows', 'linux'] as const)(
    'has an executor for every enabled %s menu action',
    async platform => {
      const state = {
        repositories: [repository],
        selectedRepository: repository,
      }
      const menu = buildRepositoryMenu(
        state,
        platform,
        remoteState,
        preferencesState
      )
      const executeMenuEvent = createRepositoryMenuEventExecutor(
        {
          state,
          removeRepository: vi.fn(async () => undefined),
        },
        {
          createRepository: vi.fn(),
          addLocalRepository: vi.fn(),
          chooseRepository: vi.fn(),
          showChanges: vi.fn(),
          showHistory: vi.fn(),
          openRepositoryInNewWindow: vi.fn(),
          showFolderContents: vi.fn(),
          fetch: vi.fn(),
          push: vi.fn(),
          pull: vi.fn(),
          showClone: vi.fn(),
          showAbout: vi.fn(),
          showPreferences: vi.fn(),
          removeRepository: vi.fn(),
          openInShell: vi.fn(),
          openInExternalEditor: vi.fn(),
        }
      )
      const executeStartupAction = createStartupMenuActionExecutor({
        quit: vi.fn(),
        openExternal: vi.fn(),
        reload: vi.fn(),
        selectAll: vi.fn(),
        showLogs: vi.fn(),
        setZoom: vi.fn(),
      })
      const enabledActions = allItems(menu.items).flatMap(item =>
        item.type !== 'separator' &&
        item.type !== 'submenuItem' &&
        item.visible &&
        item.enabled &&
        item.action !== undefined
          ? [{ id: item.id, action: item.action }]
          : []
      )
      expect(enabledActions.length).toBeGreaterThan(0)

      for (const { id, action } of enabledActions) {
        const handled =
          action.type === 'menu-event' && (await executeMenuEvent(action.event))
            ? true
            : await executeStartupAction(action)
        expect(handled, `${id} has no action executor`).toBe(true)
      }
    }
  )
})

describe('repository application menu actions', () => {
  it('routes supported actions through the current store state', async () => {
    const store = {
      get state() {
        return {
          repositories: [repository],
          selectedRepository: repository,
        }
      },
      removeRepository: vi.fn(async () => undefined),
    }
    const environment = {
      createRepository: vi.fn(async () => undefined),
      addLocalRepository: vi.fn(async () => undefined),
      chooseRepository: vi.fn(),
      showChanges: vi.fn(),
      showHistory: vi.fn(),
      openRepositoryInNewWindow: vi.fn(async () => undefined),
      showFolderContents: vi.fn(async () => undefined),
      fetch: vi.fn(async () => undefined),
      push: vi.fn(async () => undefined),
      pull: vi.fn(async () => undefined),
      showClone: vi.fn(),
      showAbout: vi.fn(),
      showPreferences: vi.fn(),
      openInShell: vi.fn(async () => undefined),
      openInExternalEditor: vi.fn(async () => undefined),
    }
    const execute = createRepositoryMenuEventExecutor(store, environment)

    await expect(execute('create-repository')).resolves.toBe(true)
    await expect(execute('add-local-repository')).resolves.toBe(true)
    await expect(execute('choose-repository')).resolves.toBe(true)
    await expect(execute('open-new-window')).resolves.toBe(true)
    await expect(execute('remove-repository')).resolves.toBe(true)
    await expect(execute('open-working-directory')).resolves.toBe(true)
    await expect(execute('show-changes')).resolves.toBe(true)
    await expect(execute('show-history')).resolves.toBe(true)
    await expect(execute('fetch')).resolves.toBe(true)
    await expect(execute('push')).resolves.toBe(true)
    await expect(execute('pull')).resolves.toBe(true)
    await expect(execute('clone-repository')).resolves.toBe(true)
    await expect(execute('show-about')).resolves.toBe(true)
    await expect(execute('show-preferences')).resolves.toBe(true)
    await expect(execute('open-in-shell')).resolves.toBe(true)
    await expect(execute('open-external-editor')).resolves.toBe(true)

    expect(environment.createRepository).toHaveBeenCalledOnce()
    expect(environment.addLocalRepository).toHaveBeenCalledOnce()
    expect(environment.chooseRepository).toHaveBeenCalledOnce()
    expect(environment.showChanges).toHaveBeenCalledOnce()
    expect(environment.showHistory).toHaveBeenCalledOnce()
    expect(environment.fetch).toHaveBeenCalledOnce()
    expect(environment.push).toHaveBeenCalledOnce()
    expect(environment.pull).toHaveBeenCalledOnce()
    expect(environment.showClone).toHaveBeenCalledOnce()
    expect(environment.showAbout).toHaveBeenCalledOnce()
    expect(environment.showPreferences).toHaveBeenCalledOnce()
    expect(environment.openInShell).toHaveBeenCalledWith(repository.path)
    expect(environment.openInExternalEditor).toHaveBeenCalledWith(
      repository.path
    )
    expect(environment.openRepositoryInNewWindow).toHaveBeenCalledWith(
      repository.path
    )
    expect(store.removeRepository).toHaveBeenCalledWith(repository)
    expect(environment.showFolderContents).toHaveBeenCalledWith(repository.path)
  })

  it('refuses repository actions when the selection disappeared', async () => {
    const store = {
      state: { repositories: [], selectedRepository: null },
      removeRepository: vi.fn(async () => undefined),
    }
    const environment = {
      createRepository: vi.fn(async () => undefined),
      addLocalRepository: vi.fn(async () => undefined),
      chooseRepository: vi.fn(),
      showChanges: vi.fn(),
      showHistory: vi.fn(),
      openRepositoryInNewWindow: vi.fn(async () => undefined),
      showFolderContents: vi.fn(async () => undefined),
      fetch: vi.fn(async () => undefined),
      push: vi.fn(async () => undefined),
      pull: vi.fn(async () => undefined),
      showClone: vi.fn(),
      showAbout: vi.fn(),
      showPreferences: vi.fn(),
      openInShell: vi.fn(async () => undefined),
      openInExternalEditor: vi.fn(async () => undefined),
    }
    const execute = createRepositoryMenuEventExecutor(store, environment)

    await expect(execute('remove-repository')).resolves.toBe(false)
    await expect(execute('open-new-window')).resolves.toBe(false)
    await expect(execute('open-working-directory')).resolves.toBe(false)
    await expect(execute('show-changes')).resolves.toBe(false)
    await expect(execute('show-history')).resolves.toBe(false)
    await expect(execute('pull')).resolves.toBe(false)
    await expect(execute('clone-repository')).resolves.toBe(true)
    await expect(execute('show-about')).resolves.toBe(true)
    await expect(execute('show-preferences')).resolves.toBe(true)
    await expect(execute('open-in-shell')).resolves.toBe(false)
    await expect(execute('open-external-editor')).resolves.toBe(false)
    await expect(execute('fetch')).resolves.toBe(false)
    await expect(execute('push')).resolves.toBe(false)
    await expect(execute('pull')).resolves.toBe(false)

    expect(store.removeRepository).not.toHaveBeenCalled()
    expect(environment.openRepositoryInNewWindow).not.toHaveBeenCalled()
    expect(environment.showFolderContents).not.toHaveBeenCalled()
    expect(environment.fetch).not.toHaveBeenCalled()
    expect(environment.push).not.toHaveBeenCalled()
    expect(environment.pull).not.toHaveBeenCalled()
    expect(environment.showClone).toHaveBeenCalledOnce()
    expect(environment.showAbout).toHaveBeenCalledOnce()
    expect(environment.showPreferences).toHaveBeenCalledOnce()
  })
})
