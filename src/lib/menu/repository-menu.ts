import type { IMenu, MenuItem } from '../../models/app-menu'
import type { MenuEvent } from '../../models/menu-event'
import type { Repository } from '../../models/repository'
import type { AppStoreState } from '../stores/app-store'
import { buildStartupMenu } from './startup'
import type { MenuPlatform } from './default-menu'

type RepositoryMenuStore = {
  readonly state: AppStoreState
  readonly removeRepository: (repository: Repository) => Promise<void>
}

type RepositoryMenuEnvironment = {
  readonly addLocalRepository: () => void | Promise<void>
  readonly chooseRepository: () => void
  readonly openRepositoryInNewWindow: (
    path: string
  ) => void | Promise<void>
  readonly showFolderContents: (path: string) => void | Promise<void>
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
 * Apply the Phase 7a subset of upstream's repository menu policy.
 *
 * Later vertical slices enable their own commands when their backing state
 * and action handlers land; a selected repository alone must not make an
 * unimplemented command appear usable.
 */
export function buildRepositoryMenu(
  state: AppStoreState,
  platform: MenuPlatform
): IMenu {
  const hasRepositories = state.repositories.length > 0
  const hasSelection = state.selectedRepository !== null
  const enabledByID = new Map<string, boolean>([
    ['add-local-repository', true],
    ['new-window', hasSelection],
    ['show-repository-list', hasRepositories],
    ['repository', hasSelection],
    ['remove-repository', hasSelection],
    ['open-working-directory', hasSelection],
  ])
  const menu = buildStartupMenu(platform)

  return {
    ...menu,
    items: menu.items.map(item => withEnablement(item, enabledByID)),
  }
}

/** Execute only menu events whose Phase 7a application-shell behavior exists. */
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
      default:
        return false
    }
  }
}
