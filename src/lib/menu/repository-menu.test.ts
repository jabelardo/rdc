import { describe, expect, it, vi } from 'vitest'
import type { Repository } from '../../models/repository'
import {
  buildRepositoryMenu,
  createRepositoryMenuEventExecutor,
} from './repository-menu'

const repository = {
  id: 7,
  name: 'rdc',
  path: '/projects/rdc',
} as Repository

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
    expect(byId('show-changes')).toMatchObject({ enabled: false })
  })
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
      addLocalRepository: vi.fn(async () => undefined),
      chooseRepository: vi.fn(),
      openRepositoryInNewWindow: vi.fn(async () => undefined),
      showFolderContents: vi.fn(async () => undefined),
    }
    const execute = createRepositoryMenuEventExecutor(store, environment)

    await expect(execute('add-local-repository')).resolves.toBe(true)
    await expect(execute('choose-repository')).resolves.toBe(true)
    await expect(execute('open-new-window')).resolves.toBe(true)
    await expect(execute('remove-repository')).resolves.toBe(true)
    await expect(execute('open-working-directory')).resolves.toBe(true)

    expect(environment.addLocalRepository).toHaveBeenCalledOnce()
    expect(environment.chooseRepository).toHaveBeenCalledOnce()
    expect(environment.openRepositoryInNewWindow).toHaveBeenCalledWith(
      repository.path
    )
    expect(store.removeRepository).toHaveBeenCalledWith(repository)
    expect(environment.showFolderContents).toHaveBeenCalledWith(
      repository.path
    )
  })

  it('refuses repository actions when the selection disappeared', async () => {
    const store = {
      state: { repositories: [], selectedRepository: null },
      removeRepository: vi.fn(async () => undefined),
    }
    const environment = {
      addLocalRepository: vi.fn(async () => undefined),
      chooseRepository: vi.fn(),
      openRepositoryInNewWindow: vi.fn(async () => undefined),
      showFolderContents: vi.fn(async () => undefined),
    }
    const execute = createRepositoryMenuEventExecutor(store, environment)

    await expect(execute('remove-repository')).resolves.toBe(false)
    await expect(execute('open-new-window')).resolves.toBe(false)
    await expect(execute('open-working-directory')).resolves.toBe(false)
    await expect(execute('pull')).resolves.toBe(false)

    expect(store.removeRepository).not.toHaveBeenCalled()
    expect(
      environment.openRepositoryInNewWindow
    ).not.toHaveBeenCalled()
    expect(environment.showFolderContents).not.toHaveBeenCalled()
  })
})
