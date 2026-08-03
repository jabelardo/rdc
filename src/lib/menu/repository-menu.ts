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
  readonly createRepository: () => void | Promise<void>
  readonly addLocalRepository: () => void | Promise<void>
  readonly chooseRepository: () => void
  readonly showChanges: () => void
  readonly showHistory: () => void
  readonly openRepositoryInNewWindow: (path: string) => void | Promise<void>
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
  // Linux/Windows in-window-menu companions: these route the keybinding-tree
  // accelerators (Ctrl+B, Ctrl+G, Ctrl+9/8, Ctrl+Shift+N) to the same actions
  // as the visible menu bar. They are required because the enablement map
  // below enables the corresponding items on non-macOS platforms; macOS keeps
  // those items disabled and so never reaches these callbacks.
  readonly showBranches: () => void
  readonly goToCommitMessage: () => void
  readonly increaseActiveResizableWidth: () => void
  readonly decreaseActiveResizableWidth: () => void
  readonly createBranch: () => void
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
        items: item.menu.items.map(child => withEnablement(child, enabledByID)),
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
    canPush && typeof remoteState?.currentBranch?.upstream === 'string'
  const enabledByID = new Map<string, boolean>([
    ['new-repository', true],
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
  // Enabled on every platform, deliberately. These five actions are implemented, so membership
  // rule (b) of the menu baseline makes them MVP — "an implemented capability is MVP by definition
  // and must be reachable from the menu". They were once gated to non-macOS because the development
  // host could not run macOS, which left the macOS Branch menu with *no* usable item at all: even
  // `create-branch`, the one branch operation that exists, was greyed out while Linux offered it.
  // A menu that hides working features is as wrong as one that offers broken ones.
  //
  // Each routes to a `RepositoryMenuEnvironment` callback shared with the Linux in-window menu bar,
  // and the per-platform executor contract in this module's tests proves macOS has an executor for
  // every one. What automation still cannot prove is native WKWebView dispatch — there is no
  // `tauri-driver` backend for it — so the macOS checklist carries an explicit verification item.
  //
  // `create-branch` is only selection-gated here, matching what the Linux keybinding tree already
  // did: the visible menu bar applies the stricter operation/merge guards, and the sidebar form
  // disables its own submit.
  enabledByID.set('show-branches-list', hasSelection)
  enabledByID.set('go-to-commit-message', hasSelection)
  enabledByID.set('increase-active-resizable-width', true)
  enabledByID.set('decrease-active-resizable-width', true)
  enabledByID.set('create-branch', hasSelection)
  const menu = buildStartupMenu(
    platform,
    preferencesState === undefined
      ? {}
      : {
          selectedShell: preferencesState.selectedShell,
          selectedExternalEditor: preferencesState.selectedExternalEditor,
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
      case 'create-repository':
        await environment.createRepository()
        return true
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
      case 'show-branches':
        if (store.state.selectedRepository === null) {
          return false
        }
        environment.showBranches()
        return true
      case 'go-to-commit-message':
        if (store.state.selectedRepository === null) {
          return false
        }
        environment.goToCommitMessage()
        return true
      case 'increase-active-resizable-width':
        environment.increaseActiveResizableWidth()
        return true
      case 'decrease-active-resizable-width':
        environment.decreaseActiveResizableWidth()
        return true
      case 'create-branch':
        if (store.state.selectedRepository === null) {
          return false
        }
        environment.createBranch()
        return true
      default:
        return false
    }
  }
}
