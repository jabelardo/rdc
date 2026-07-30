import type { IMenu, MenuItem } from '../../models/app-menu'
import type { MenuEvent } from '../../models/menu-event'
import type { Repository } from '../../models/repository'
import type { AppStoreState } from '../stores/app-store'
import type { RemoteState } from '../stores/remote-store'
import type { PreferencesState } from '../stores/preferences-store'
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
  readonly showAbout?: () => void
  readonly showPreferences?: () => void
  readonly removeRepository?: (repository: Repository) => void | Promise<void>
  readonly openInShell?: (path: string) => void | Promise<void>
  readonly openInExternalEditor?: (path: string) => void | Promise<void>
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
  remoteState?: RemoteState,
  preferencesState?: PreferencesState
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
    ['about', true],
    ['preferences', preferencesState !== undefined],
    ['new-window', hasSelection],
    ['show-repository-list', hasRepositories],
    ['repository', hasSelection],
    ['remove-repository', hasSelection],
    ['open-working-directory', hasSelection],
    [
      'open-in-shell',
      hasSelection &&
        !preferencesState?.loading &&
        preferencesState?.selectedShell !== null &&
        preferencesState?.selectedShell !== undefined,
    ],
    [
      'open-external-editor',
      hasSelection &&
        !preferencesState?.loading &&
        preferencesState?.selectedExternalEditor !== null &&
        preferencesState?.selectedExternalEditor !== undefined,
    ],
    ['show-changes', hasSelection],
    ['show-history', hasSelection],
    ['fetch', canFetch],
    ['push', canPush],
    ['pull', canPull],
  ])
  const menu = buildStartupMenu(
    platform,
    preferencesState === undefined
      ? {}
      : {
          selectedShell: preferencesState.selectedShell,
          selectedExternalEditor:
            preferencesState.selectedExternalEditor,
          askForConfirmationOnRepositoryRemoval:
            preferencesState.confirmRepositoryRemoval,
        }
  )

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
      case 'show-about':
        if (environment.showAbout === undefined) {
          return false
        }
        environment.showAbout()
        return true
      case 'show-preferences':
        if (environment.showPreferences === undefined) {
          return false
        }
        environment.showPreferences()
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
        if (environment.removeRepository === undefined) {
          await store.removeRepository(repository)
        } else {
          await environment.removeRepository(repository)
        }
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
      case 'open-in-shell':
      case 'open-external-editor': {
        const repository = store.state.selectedRepository
        const action =
          event === 'open-in-shell'
            ? environment.openInShell
            : environment.openInExternalEditor
        if (repository === null || action === undefined) {
          return false
        }
        await action(repository.path)
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
