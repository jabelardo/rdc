import type { IMenu, MenuAction, MenuItem } from "@/models/app-menu";
import type { MenuLabelsEvent } from "@/models/menu-labels";
import { buildDefaultMenu, currentMenuPlatform, type MenuPlatform } from "./default-menu";

const ZOOM_STEP = 0.05;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

const initialLabels = {
  selectedShell: null,
  selectedExternalEditor: null,
  askForConfirmationOnForcePush: false,
  askForConfirmationOnRepositoryRemoval: false,
  gitHubRepositoryType: null,
} as const;

function isStartupActionSupported(action: MenuAction): boolean {
  return (
    action.type === "open-external" ||
    action.type === "show-logs" ||
    action.type === "zoom" ||
    action.type === "reload-window" ||
    action.type === "show-devtools" ||
    action.type === "quit" ||
    (action.type === "menu-event" && action.event === "select-all")
  );
}

function withHonestStartupEnablement(item: MenuItem): MenuItem {
  if (item.type === "submenuItem") {
    return {
      ...item,
      menu: {
        ...item.menu,
        items: item.menu.items.map(withHonestStartupEnablement),
      },
    };
  }
  if (
    item.type !== "separator" &&
    item.action !== undefined &&
    !isStartupActionSupported(item.action)
  ) {
    return { ...item, enabled: false };
  }
  return item;
}

/**
 * Build the full macOS structure while disabling actions whose Phase 7
 * dispatcher or later platform integration does not exist yet.
 */
export function buildStartupMenu(
  platform: MenuPlatform = currentMenuPlatform(),
  labels: Partial<MenuLabelsEvent> = {},
): IMenu {
  const menu = buildDefaultMenu({ ...initialLabels, ...labels }, platform);
  return { ...menu, items: menu.items.map(withHonestStartupEnablement) };
}

type StartupActionEnvironment = {
  readonly quit: () => void | Promise<void>;
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly reload: () => void;
  readonly selectAll: () => void;
  readonly showLogs: () => void | Promise<void>;
  readonly setZoom: (factor: number) => void | Promise<void>;
  readonly toggleDevTools: () => void | Promise<void>;
};

/** Create the small action executor used before Phase 7's dispatcher exists. */
export function createStartupMenuActionExecutor(
  environment: StartupActionEnvironment,
): (action: MenuAction) => Promise<boolean> {
  let zoomFactor = 1;

  return async (action) => {
    switch (action.type) {
      case "open-external":
        await environment.openExternal(action.url);
        return true;
      case "menu-event":
        if (action.event !== "select-all") {
          return false;
        }
        environment.selectAll();
        return true;
      case "zoom": {
        if (action.direction === "reset") {
          zoomFactor = 1;
        } else if (action.direction === "in") {
          zoomFactor = Math.min(ZOOM_MAX, zoomFactor + ZOOM_STEP);
        } else {
          zoomFactor = Math.max(ZOOM_MIN, zoomFactor - ZOOM_STEP);
        }
        await environment.setZoom(zoomFactor);
        return true;
      }
      case "reload-window":
        environment.reload();
        return true;
      case "quit":
        await environment.quit();
        return true;
      case "show-logs":
        await environment.showLogs();
        return true;
      case "show-devtools":
        await environment.toggleDevTools();
        return true;
      case "crash-main-process":
        return false;
    }
  };
}
