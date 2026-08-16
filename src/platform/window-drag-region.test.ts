import { describe, expect, it, vi } from "vitest";
import { handleWindowTitleBarDoubleClick, shouldShowWindowDragRegion } from "./window-drag-region";

describe("window drag region policy", () => {
  it("always supplies webview drag chrome for macOS overlay and frameless Windows", () => {
    for (const platform of ["macos", "windows"] as const) {
      expect(shouldShowWindowDragRegion(platform, "native")).toBe(true);
      expect(shouldShowWindowDragRegion(platform, "custom")).toBe(true);
      expect(shouldShowWindowDragRegion(platform, "native-without-menu-bar")).toBe(true);
    }
  });

  it("keeps Linux native decorations and supplies drag chrome only for custom style", () => {
    expect(shouldShowWindowDragRegion("linux", "native")).toBe(false);
    expect(shouldShowWindowDragRegion("linux", "native-without-menu-bar")).toBe(false);
    expect(shouldShowWindowDragRegion("linux", "custom")).toBe(true);
  });
});

describe("window drag region double click", () => {
  const dependencies = (action: "Maximize" | "Minimize" | "None", maximized = false) => ({
    getAction: vi.fn(async () => action),
    isMaximized: vi.fn(async () => maximized),
    maximize: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
  });

  it("toggles maximization for the default action", async () => {
    const normal = dependencies("Maximize");
    await handleWindowTitleBarDoubleClick(normal);
    expect(normal.maximize).toHaveBeenCalledOnce();
    expect(normal.restore).not.toHaveBeenCalled();

    const maximized = dependencies("Maximize", true);
    await handleWindowTitleBarDoubleClick(maximized);
    expect(maximized.restore).toHaveBeenCalledOnce();
    expect(maximized.maximize).not.toHaveBeenCalled();
  });

  it("honors the configured minimize and none actions", async () => {
    const minimize = dependencies("Minimize");
    await handleWindowTitleBarDoubleClick(minimize);
    expect(minimize.minimize).toHaveBeenCalledOnce();
    expect(minimize.isMaximized).not.toHaveBeenCalled();

    const none = dependencies("None");
    await handleWindowTitleBarDoubleClick(none);
    expect(none.minimize).not.toHaveBeenCalled();
    expect(none.isMaximized).not.toHaveBeenCalled();
  });
});
