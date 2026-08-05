import { beforeEach, describe, expect, it, vi } from "vitest";

const exit = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());
const currentWindow = vi.hoisted(() => ({
  destroy: vi.fn(),
  hide: vi.fn(),
  onCloseRequested: vi.fn(),
}));
const getCurrentWindow = vi.hoisted(() => vi.fn(() => currentWindow));
const getAllWindows = vi.hoisted(() => vi.fn());
const getMainProcessConfig = vi.hoisted(() => vi.fn());
const applicationUpdateController = vi.hoisted(() => ({
  isCloseBlocked: false,
  notifyCloseBlocked: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({ exit, relaunch }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows,
  getCurrentWindow,
}));
vi.mock("./config", () => ({ getMainProcessConfig }));
vi.mock("./updater", () => ({ applicationUpdateController }));

const { installCloseRequestHandler, installDefaultCloseRequestHandler, quitApp, restartApp } =
  await import("./lifetime");

describe("application lifetime", () => {
  beforeEach(() => {
    exit.mockReset();
    exit.mockResolvedValue(undefined);
    relaunch.mockReset();
    relaunch.mockResolvedValue(undefined);
    getCurrentWindow.mockClear();
    getAllWindows.mockReset();
    getAllWindows.mockResolvedValue([currentWindow]);
    getMainProcessConfig.mockReset();
    getMainProcessConfig.mockResolvedValue({
      titleBarStyle: "native",
      hideWindowOnQuit: false,
    });
    applicationUpdateController.isCloseBlocked = false;
    applicationUpdateController.notifyCloseBlocked.mockReset();
    currentWindow.destroy.mockReset();
    currentWindow.destroy.mockResolvedValue(undefined);
    currentWindow.hide.mockReset();
    currentWindow.hide.mockResolvedValue(undefined);
    currentWindow.onCloseRequested.mockReset();
  });

  it("quits with a successful process exit code", async () => {
    await quitApp();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("restarts through the atomic process-plugin relaunch operation", async () => {
    await restartApp();

    expect(relaunch).toHaveBeenCalledOnce();
  });

  it.each([
    ["quit", exit],
    ["hide", currentWindow.hide],
    ["close", currentWindow.destroy],
  ] as const)(
    "prevents native close before asynchronously deciding to %s",
    async (decision, action) => {
      const preventDefault = vi.fn();
      let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
      const unlisten = vi.fn();
      currentWindow.onCloseRequested.mockImplementation(async (handler) => {
        closeHandler = handler;
        return unlisten;
      });

      const cleanup = await installCloseRequestHandler(async () => decision);
      closeHandler?.({ preventDefault });
      await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());

      expect(preventDefault).toHaveBeenCalledOnce();
      cleanup();
      expect(unlisten).toHaveBeenCalledOnce();
    },
  );

  it("leaves the application running when the frontend cancels close", async () => {
    const preventDefault = vi.fn();
    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    currentWindow.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });

    await installCloseRequestHandler(() => "cancel");
    closeHandler?.({ preventDefault });
    await Promise.resolve();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(currentWindow.hide).not.toHaveBeenCalled();
  });

  it("preserves a useful error when a native close operation rejects without one", async () => {
    const loggedError = vi.spyOn(log, "error");
    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    currentWindow.hide.mockRejectedValue(undefined);
    currentWindow.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });

    await installCloseRequestHandler(() => "hide");
    closeHandler?.({ preventDefault: vi.fn() });

    await vi.waitFor(() =>
      expect(loggedError).toHaveBeenCalledWith(
        "Failed to resolve native close request",
        expect.objectContaining({
          message: "Unknown native close error",
        }),
      ),
    );
  });

  it("coalesces repeated close events while a decision is pending", async () => {
    const preventDefault = vi.fn();
    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    let resolveDecision: ((decision: "cancel") => void) | undefined;
    const decide = vi.fn(
      () =>
        new Promise<"cancel">((resolve) => {
          resolveDecision = resolve;
        }),
    );
    currentWindow.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });

    await installCloseRequestHandler(decide);
    closeHandler?.({ preventDefault });
    closeHandler?.({ preventDefault });
    await Promise.resolve();

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledOnce();
    resolveDecision?.("cancel");
  });

  it.each([
    [true, "hide"],
    [false, "quit"],
  ] as const)(
    "defaults to the upstream platform close behavior when macOS=%s",
    async (isMacOS, expected) => {
      let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
      currentWindow.onCloseRequested.mockImplementation(async (handler) => {
        closeHandler = handler;
        return vi.fn();
      });

      await installDefaultCloseRequestHandler(isMacOS);
      closeHandler?.({ preventDefault: vi.fn() });

      const action = expected === "hide" ? currentWindow.hide : exit;
      await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    },
  );

  it("hides the last non-macOS window when configured", async () => {
    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    getMainProcessConfig.mockResolvedValue({
      titleBarStyle: "native",
      hideWindowOnQuit: true,
    });
    currentWindow.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });

    await installDefaultCloseRequestHandler(false);
    closeHandler?.({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(currentWindow.hide).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
  });

  it("cancels destructive close while an update is downloading or installing", async () => {
    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    applicationUpdateController.isCloseBlocked = true;
    currentWindow.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });

    await installDefaultCloseRequestHandler(false);
    closeHandler?.({ preventDefault: vi.fn() });
    await vi.waitFor(() =>
      expect(applicationUpdateController.notifyCloseBlocked).toHaveBeenCalledOnce(),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(currentWindow.destroy).not.toHaveBeenCalled();
    expect(currentWindow.hide).not.toHaveBeenCalled();
  });

  it("still allows a hide-only close while an update is active", async () => {
    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    applicationUpdateController.isCloseBlocked = true;
    currentWindow.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });

    await installDefaultCloseRequestHandler(true);
    closeHandler?.({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(currentWindow.hide).toHaveBeenCalledOnce());
    expect(applicationUpdateController.notifyCloseBlocked).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "destroys a non-last window without quitting or hiding when macOS=%s",
    async (isMacOS) => {
      let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
      getAllWindows.mockResolvedValue([currentWindow, { label: "other" }]);
      currentWindow.onCloseRequested.mockImplementation(async (handler) => {
        closeHandler = handler;
        return vi.fn();
      });

      await installDefaultCloseRequestHandler(isMacOS);
      closeHandler?.({ preventDefault: vi.fn() });

      await vi.waitFor(() => expect(currentWindow.destroy).toHaveBeenCalledOnce());
      expect(exit).not.toHaveBeenCalled();
      expect(currentWindow.hide).not.toHaveBeenCalled();
    },
  );
});
