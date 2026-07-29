import { getCurrentWindow } from '@tauri-apps/api/window'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { IMenu, MenuAction, MenuItem } from '../../models/app-menu'
import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  onNativeMenuAction,
  selectAllWindowContents,
  setNativeMenu,
} from '../platform/menu'
import { setWindowZoomFactor } from '../platform/window'
import { buildDefaultMenu } from './default-menu'

const ZoomFactors = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

const initialLabels = {
  selectedShell: null,
  selectedExternalEditor: null,
  askForConfirmationOnForcePush: false,
  askForConfirmationOnRepositoryRemoval: false,
  gitHubRepositoryType: null,
} as const

function isStartupActionSupported(action: MenuAction): boolean {
  return (
    action.type === 'open-external' ||
    action.type === 'zoom' ||
    action.type === 'reload-window' ||
    action.type === 'quit' ||
    (action.type === 'menu-event' && action.event === 'select-all')
  )
}

function withHonestStartupEnablement(item: MenuItem): MenuItem {
  if (item.type === 'submenuItem') {
    return {
      ...item,
      menu: {
        ...item.menu,
        items: item.menu.items.map(withHonestStartupEnablement),
      },
    }
  }
  if (
    item.type !== 'separator' &&
    item.action !== undefined &&
    !isStartupActionSupported(item.action)
  ) {
    return { ...item, enabled: false }
  }
  return item
}

/**
 * Build the full macOS structure while disabling actions whose Phase 7
 * dispatcher or later platform integration does not exist yet.
 */
export function buildStartupMenu(): IMenu {
  const menu = buildDefaultMenu(initialLabels, 'macos')
  return { ...menu, items: menu.items.map(withHonestStartupEnablement) }
}

type StartupActionEnvironment = {
  readonly close: () => void | Promise<void>
  readonly openExternal: (url: string) => void | Promise<void>
  readonly reload: () => void
  readonly selectAll: () => void
  readonly setZoom: (factor: number) => void | Promise<void>
}

/** Create the small action executor used before Phase 7's dispatcher exists. */
export function createStartupMenuActionExecutor(
  environment: StartupActionEnvironment
): (action: MenuAction) => Promise<boolean> {
  let zoomFactor = 1

  return async action => {
    switch (action.type) {
      case 'open-external':
        await environment.openExternal(action.url)
        return true
      case 'menu-event':
        if (action.event !== 'select-all') {
          return false
        }
        environment.selectAll()
        return true
      case 'zoom': {
        if (action.direction === 'reset') {
          zoomFactor = 1
        } else {
          const closest = ZoomFactors.reduce((previous, current) =>
            Math.abs(current - zoomFactor) < Math.abs(previous - zoomFactor)
              ? current
              : previous
          )
          const ordered =
            action.direction === 'in'
              ? ZoomFactors
              : [...ZoomFactors].reverse()
          zoomFactor =
            ordered.find(factor =>
              action.direction === 'in'
                ? factor > closest
                : factor < closest
            ) ?? closest
        }
        await environment.setZoom(zoomFactor)
        return true
      }
      case 'reload-window':
        environment.reload()
        return true
      case 'quit':
        await environment.close()
        return true
      case 'show-logs':
      case 'show-devtools':
      case 'crash-main-process':
        return false
    }
  }
}

type DefaultMenuDependencies = {
  readonly execute: (action: MenuAction) => void | Promise<unknown>
  readonly install: (menu: IMenu) => Promise<void>
  readonly listen: (
    callback: (action: MenuAction) => void
  ) => Promise<UnlistenFn>
}

const executeStartupMenuAction = createStartupMenuActionExecutor({
  close: () => getCurrentWindow().close(),
  openExternal: url => openUrl(url),
  reload: () => window.location.reload(),
  selectAll: selectAllWindowContents,
  setZoom: setWindowZoomFactor,
})

const defaultDependencies: DefaultMenuDependencies = {
  execute: executeStartupMenuAction,
  install: setNativeMenu,
  listen: onNativeMenuAction,
}

/**
 * Replace Rust's lifecycle-safe bootstrap after the renderer can receive menu
 * actions. Resolves to the listener cleanup function.
 */
export async function installMacOSDefaultMenu(
  dependencies: DefaultMenuDependencies = defaultDependencies
): Promise<UnlistenFn> {
  const unlisten = await dependencies.listen(action => {
    void Promise.resolve(dependencies.execute(action)).catch(error => {
      log.error('Failed to execute startup menu action', error)
    })
  })

  try {
    await dependencies.install(buildStartupMenu())
    return unlisten
  } catch (error) {
    unlisten()
    throw error
  }
}
