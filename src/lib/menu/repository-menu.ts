import type { IMenu, MenuItem } from '../../models/app-menu'
import type { MenuEvent } from '../../models/menu-event'
import type { Repository } from '../../models/repository'
import type { AppStoreState } from '../stores/app-store'
import type { RemoteState } from '../stores/remote-store'
import { buildStartupMenu } from './startup'
import type { MenuPlatform } from './default-menu'

type RepositoryMenuStore = {
  readonly state: AppStoreState
  readonly removeRepository: (repository: Repository) => Promise<void>
}

type RepositoryMenuEnvironment = {
  readonly addLocalRepository: () => void | Promise<void>
  readonly chooseRepository: () => void
  readonly showChanges: () => void
  readonly showHistory: () => void
  readonly openRepositoryInNewWindow: (
    path: string
  ) => void | Promise<void>
  readonly showFolderContents: (path: string) => void | Promise<void>
  readonly fetch: () => void | Promise<void>
  readonly push: () => void | Promise<void>
  readonly pull: () => void | Promise<void>
  readonly showClone: () => void
}

function withEnablement(
  item: MenuItem,
  enabledByID: ReadonlyMap<string, boolean>
): MenuItem {
  const enabled = enabledByID.get(item.id)
  if (item.type === 'submenuItem') {
    return {
      ...item,
      enabled: enabled ?? item.enabled,
      menu: {
        ...item.menu,
        items: item.menu.items.map(child =>
          withEnablement(child, enabledByID)
        ),
      },
    }
  }
  if (item.type === 'separator' || enabled === undefined) {
    return item
  }
  return { ...item, enabled }
}

/**
 * Apply the repository-shell subset of upstream's menu policy.
 *
 * Later vertical slices enable their own commands when their backing state
 * and action handlers land; a selected repository alone must not make an
 * unimplemented command appear usable.
 */
export function buildRepositoryMenu(
  state: AppStoreState,
  platform: MenuPlatform,
  remoteState?: RemoteState
): IMenu {
  const hasRepositories = state.repositories.length > 0
  const hasSelection = state.selectedRepository !== null
  const canFetch =
    hasSelection &&
    remoteState?.repositoryPath === state.selectedRepository?.path &&
    remoteState.currentRemote !== null &&
    !remoteState.loading &&
    remoteState.operation === null
  const canPush = canFetch && remoteState?.currentBranch !== null
  const canPull =
    canPush &&
    typeof remoteState?.currentBranch?.upstream === 'string'
  const enabledByID = new Map<string, boolean>([
    ['add-local-repository', true],
    ['clone-repository', true],
    ['new-window', hasSelection],
    ['show-repository-list', hasRepositories],
    ['repository', hasSelection],
    ['remove-repository', hasSelection],
    ['open-working-directory', hasSelection],
    ['show-changes', hasSelection],
    ['show-history', hasSelection],
    ['fetch', canFetch],
    ['push', canPush],
    ['pull', canPull],
  ])
  const menu = buildStartupMenu(platform)

  return {
    ...menu,
    items: menu.items.map(item => withEnablement(item, enabledByID)),
  }
}

/** Execute only menu events whose current application-shell behavior exists. */
export function createRepositoryMenuEventExecutor(
  store: RepositoryMenuStore,
  environment: RepositoryMenuEnvironment
): (event: MenuEvent) => Promise<boolean> {
  return async event => {
    switch (event) {
      case 'add-local-repository':
        await environment.addLocalRepository()
        return true
      case 'choose-repository':
        environment.chooseRepository()
        return true
      case 'clone-repository':
        environment.showClone()
        return true
      case 'open-new-window': {
        const repository = store.state.selectedRepository
        if (repository === null) {
          return false
        }
        await environment.openRepositoryInNewWindow(repository.path)
        return true
      }
      case 'remove-repository': {
        const repository = store.state.selectedRepository
        if (repository === null) {
          return false
        }
        await store.removeRepository(repository)
        return true
      }
      case 'open-working-directory': {
        const repository = store.state.selectedRepository
        if (repository === null) {
          return false
        }
        await environment.showFolderContents(repository.path)
        return true
      }
      case 'show-changes':
      case 'show-history': {
        if (store.state.selectedRepository === null) {
          return false
        }
        if (event === 'show-changes') {
          environment.showChanges()
        } else {
          environment.showHistory()
        }
        return true
      }
      case 'fetch':
        if (store.state.selectedRepository === null) {
          return false
        }
        await environment.fetch()
        return true
      case 'push':
        if (store.state.selectedRepository === null) {
          return false
        }
        await environment.push()
        return true
      case 'pull':
        if (store.state.selectedRepository === null) {
          return false
        }
        await environment.pull()
        return true
      default:
        return false
    }
  }
}
