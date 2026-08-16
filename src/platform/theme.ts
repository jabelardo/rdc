import { setTheme } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type ThemeSource = "light" | "dark" | "system";

/** Electron called this nativeTheme.themeSource; Tauri owns it application-wide too. */
export function setNativeThemeSource(source: ThemeSource): Promise<void> {
  return setTheme(source === "system" ? null : source);
}

export async function shouldUseDarkColors(): Promise<boolean> {
  return (await getCurrentWindow().theme()) === "dark";
}

/**
 * Upstream's notification was payload-free. Consumers re-read the resolved
 * theme, so keep that contract instead of leaking Tauri's event shape.
 */
export function onNativeThemeUpdated(callback: () => void): Promise<UnlistenFn> {
  return getCurrentWindow().onThemeChanged(() => callback());
}

export function updateWindowBackgroundColor(color: string): Promise<void> {
  return getCurrentWindow().setBackgroundColor(color);
}
