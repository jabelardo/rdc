import type { TitleBarStyle } from "@/models/main-process-config";
import type { MenuPlatform } from "@/lib/menu/default-menu";
import { getAppleActionOnDoubleClick } from "./system";
import { isWindowMaximized, maximizeWindow, minimizeWindow, restoreWindow } from "./window";

type DoubleClickDependencies = {
  readonly getAction: typeof getAppleActionOnDoubleClick;
  readonly isMaximized: typeof isWindowMaximized;
  readonly maximize: typeof maximizeWindow;
  readonly minimize: typeof minimizeWindow;
  readonly restore: typeof restoreWindow;
};

/**
 * Whether the webview must provide the native window's draggable chrome.
 *
 * macOS always uses Tauri's overlay style, Windows is frameless, and Linux is
 * frameless only for the explicit custom title-bar preference.
 */
export function shouldShowWindowDragRegion(
  platform: MenuPlatform,
  titleBarStyle: TitleBarStyle,
): boolean {
  return platform !== "linux" || titleBarStyle === "custom";
}

/** Preserve macOS's configured title-bar double-click action on webview chrome. */
export async function handleWindowTitleBarDoubleClick(
  dependencies: Partial<DoubleClickDependencies> = {},
): Promise<void> {
  const actions: DoubleClickDependencies = {
    getAction: getAppleActionOnDoubleClick,
    isMaximized: isWindowMaximized,
    maximize: maximizeWindow,
    minimize: minimizeWindow,
    restore: restoreWindow,
    ...dependencies,
  };
  const action = await actions.getAction();
  if (action === "None") {
    return;
  }
  if (action === "Minimize") {
    await actions.minimize();
    return;
  }
  if (await actions.isMaximized()) {
    await actions.restore();
  } else {
    await actions.maximize();
  }
}
