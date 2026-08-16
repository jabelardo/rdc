import type { UnlistenFn } from "@tauri-apps/api/event";
import { AppMenu, type ExecutableMenuItem, type IMenu, type MenuAction } from "@/models/app-menu";
import type { MenuKeybindings } from "@/models/keybinding";
import type { MenuEvent } from "@/models/menu-event";
import { getKeybindings, onKeybindingsChanged } from "@/platform/keybindings";
import { onNativeMenuAction, setNativeMenu } from "@/platform/menu";
import type { MenuPlatform } from "@/models/menu-platform";
import { currentMenuPlatform } from "@/models/menu-platform";
import { buildStartupMenu, createStartupMenuActionExecutor } from "./startup";
import { openUrl } from "@tauri-apps/plugin-opener";
import { quitApp } from "@/platform/lifetime";
import { selectAllWindowContents } from "@/platform/menu";
import { setWindowZoomFactor, toggleDevTools } from "@/platform/window";
import { showApplicationLogs } from "@/lib/resilience/logs";

export type ApplicationMenuDependencies = {
  readonly platform: MenuPlatform;
  readonly initialMenu: IMenu;
  readonly executeAction: (action: MenuAction) => Promise<boolean>;
  readonly getKeybindings: () => Promise<MenuKeybindings>;
  readonly onKeybindingsChanged: (
    callback: (bindings: MenuKeybindings) => void,
  ) => Promise<UnlistenFn>;
  readonly onNativeMenuAction: (callback: (action: MenuAction) => void) => Promise<UnlistenFn>;
  readonly setNativeMenu: (menu: IMenu) => Promise<void>;
};

type NativeMenuSynchronizer = (menu: IMenu) => Promise<void>;

export type ApplicationMenuConfiguration = {
  readonly initialMenu?: IMenu;
  readonly executeMenuEvent?: (event: MenuEvent) => Promise<boolean>;
};

export class ApplicationMenuController {
  private currentMenu: AppMenu;
  private currentBindings: MenuKeybindings;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  public constructor(
    menu: IMenu,
    bindings: MenuKeybindings,
    private readonly executeAction: (action: MenuAction) => Promise<boolean>,
    private readonly synchronizeNativeMenu?: NativeMenuSynchronizer,
  ) {
    this.currentMenu = AppMenu.fromMenu(menu);
    this.currentBindings = bindings;
  }

  public get menu(): AppMenu {
    return this.currentMenu;
  }

  public get bindings(): MenuKeybindings {
    return this.currentBindings;
  }

  public async replaceMenu(menu: IMenu): Promise<void> {
    this.currentMenu = this.currentMenu.withMenu(menu);
    await this.synchronizeNativeMenu?.(this.currentMenu.rootMenu);
  }

  public async replaceBindings(bindings: MenuKeybindings): Promise<void> {
    this.currentBindings = bindings;
    await this.synchronizeNativeMenu?.(this.currentMenu.rootMenu);
  }

  public executeItem(item: ExecutableMenuItem): Promise<boolean> {
    return this.executeItemById(item.id);
  }

  public executeItemById(id: string): Promise<boolean> {
    const item = this.currentMenu.getItemById(id);
    if (
      item === undefined ||
      item.type === "separator" ||
      item.type === "submenuItem" ||
      !item.enabled ||
      !item.visible ||
      item.action === undefined
    ) {
      return Promise.resolve(false);
    }
    return this.executeAction(item.action);
  }

  public executeNativeAction(action: MenuAction): Promise<boolean> {
    return this.executeAction(action);
  }

  public addCleanup(cleanup: () => void): void {
    if (this.disposed) {
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      cleanup();
    }
  }
}

function reportExecutionFailure(error: unknown): void {
  log.error(
    "Failed to execute application menu action",
    error instanceof Error ? error : new Error(String(error)),
  );
}

function defaultDependencies(
  configuration: ApplicationMenuConfiguration,
): ApplicationMenuDependencies {
  const platform = currentMenuPlatform();
  const executeStartupAction = createStartupMenuActionExecutor({
    quit: quitApp,
    openExternal: (url) => openUrl(url),
    reload: () => window.location.reload(),
    selectAll: selectAllWindowContents,
    showLogs: showApplicationLogs,
    setZoom: setWindowZoomFactor,
    toggleDevTools,
  });
  return {
    platform,
    initialMenu: configuration.initialMenu ?? buildStartupMenu(platform),
    executeAction: async (action) => {
      if (
        action.type === "menu-event" &&
        configuration.executeMenuEvent !== undefined &&
        (await configuration.executeMenuEvent(action.event))
      ) {
        return true;
      }
      return executeStartupAction(action);
    },
    getKeybindings,
    onKeybindingsChanged,
    onNativeMenuAction,
    setNativeMenu,
  };
}

/**
 * Install the one application-menu owner. macOS mirrors its tree into the
 * native menu; Linux and Windows keep the same tree local and dispatch
 * structured keybindings from the webview.
 */
export async function installApplicationMenu(
  configuration: ApplicationMenuConfiguration = {},
  dependencies: ApplicationMenuDependencies = defaultDependencies(configuration),
): Promise<ApplicationMenuController> {
  let latestBindings: MenuKeybindings | undefined;
  let controller: ApplicationMenuController | undefined;
  const bindingCleanup = await dependencies.onKeybindingsChanged((bindings) => {
    latestBindings = bindings;
    if (controller !== undefined) {
      void controller.replaceBindings(bindings).catch(reportExecutionFailure);
    }
  });

  try {
    const loadedBindings = await dependencies.getKeybindings();
    const synchronizeNativeMenu = dependencies.setNativeMenu;
    controller = new ApplicationMenuController(
      dependencies.initialMenu,
      latestBindings ?? loadedBindings,
      dependencies.executeAction,
      synchronizeNativeMenu,
    );
    controller.addCleanup(bindingCleanup);

    // Every platform mirrors the canonical tree into the native menu (macOS app
    // menu, Linux/Windows window menu bar) and resolves actions from the native
    // `menu-event` channel. Linux previously rendered the same tree as an
    // in-window DOM menu bar; the native bar removes that layer.
    const nativeCleanup = await dependencies.onNativeMenuAction((action) => {
      void controller?.executeNativeAction(action).catch(reportExecutionFailure);
    });
    controller.addCleanup(nativeCleanup);
    await dependencies.setNativeMenu(controller.menu.rootMenu);

    return controller;
  } catch (error) {
    controller?.dispose();
    if (controller === undefined) {
      bindingCleanup();
    }
    throw error;
  }
}
