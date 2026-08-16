import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

const {
  UpdateController,
  applicationUpdateController,
  checkForUpdates,
  onAutoUpdaterCheckingForUpdate,
  onAutoUpdaterError,
  onAutoUpdaterUpdateAvailable,
  onAutoUpdaterUpdateDownloaded,
  onAutoUpdaterUpdateNotAvailable,
  onShowInstallingUpdate,
  quitAndInstallUpdate,
} = await import("./updater");

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeUpdate(version = "2.0.0") {
  return {
    version,
    download: vi.fn(),
    install: vi.fn(),
    close: vi.fn(),
  };
}

describe("UpdateController", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset();
    relaunch.mockResolvedValue(undefined);
  });

  it("checks, downloads an available update, and retains it ready for install", async () => {
    const update = fakeUpdate();
    update.download.mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 30 } });
      onEvent({ event: "Progress", data: { chunkLength: 12 } });
      onEvent({ event: "Progress", data: { chunkLength: 18 } });
      onEvent({ event: "Finished" });
    });
    const backend = { check: vi.fn().mockResolvedValue(update), relaunch };
    const controller = new UpdateController(backend);
    const states: Array<string> = [];
    controller.onDidChange((state) => states.push(state.status));

    await controller.check();

    expect(backend.check).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledOnce();
    expect(states).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "ready",
    ]);
    expect(controller.state).toEqual({
      status: "ready",
      version: "2.0.0",
      contentLength: 30,
      downloadedBytes: 30,
    });
  });

  it("reports a completed check with no update", async () => {
    const backend = { check: vi.fn().mockResolvedValue(null), relaunch };
    const controller = new UpdateController(backend);

    await controller.check();

    expect(controller.state).toEqual({
      status: "not-available",
      downloadedBytes: 0,
    });
  });

  it("coalesces concurrent checks and refuses to replace a ready update", async () => {
    const pending = deferred<ReturnType<typeof fakeUpdate> | null>();
    const update = fakeUpdate();
    update.download.mockResolvedValue(undefined);
    const backend = { check: vi.fn(() => pending.promise), relaunch };
    const controller = new UpdateController(backend);

    const first = controller.check();
    const second = controller.check();
    expect(backend.check).toHaveBeenCalledOnce();
    pending.resolve(update);
    await Promise.all([first, second]);

    await controller.check();
    expect(backend.check).toHaveBeenCalledOnce();
  });

  it("closes a failed download and emits the useful error", async () => {
    const failure = new Error("download failed");
    const update = fakeUpdate();
    update.download.mockRejectedValue(failure);
    update.close.mockResolvedValue(undefined);
    const controller = new UpdateController({
      check: vi.fn().mockResolvedValue(update),
      relaunch,
    });
    const errors: Array<Error> = [];
    controller.onError((error) => errors.push(error));

    const result = await controller.check();

    expect(result).toBe(failure);
    expect(errors).toEqual([failure]);
    expect(update.close).toHaveBeenCalledOnce();
    expect(controller.state.status).toBe("error");
  });

  it("installs only the retained update, then relaunches", async () => {
    const update = fakeUpdate();
    update.download.mockResolvedValue(undefined);
    update.install.mockResolvedValue(undefined);
    const calls: Array<string> = [];
    update.install.mockImplementation(async () => {
      calls.push("install");
    });
    const backend = {
      check: vi.fn().mockResolvedValue(update),
      relaunch: vi.fn(async () => {
        calls.push("relaunch");
      }),
    };
    const controller = new UpdateController(backend);

    await expect(controller.quitAndInstall()).rejects.toThrow(
      "No downloaded update is ready to install",
    );
    await controller.check();
    await controller.quitAndInstall();

    expect(calls).toEqual(["install", "relaunch"]);
    expect(controller.state.status).toBe("installing");
  });

  it("returns to ready after an install failure so the user can retry", async () => {
    const failure = new Error("install failed");
    const update = fakeUpdate();
    update.download.mockResolvedValue(undefined);
    update.install.mockRejectedValue(failure);
    const controller = new UpdateController({
      check: vi.fn().mockResolvedValue(update),
      relaunch,
    });
    const errors: Array<Error> = [];
    controller.onError((error) => errors.push(error));
    await controller.check();

    await expect(controller.quitAndInstall()).rejects.toBe(failure);

    expect(controller.state.status).toBe("ready");
    expect(errors).toEqual([failure]);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("signals blocked closes only while downloading or installing", async () => {
    const pendingDownload = deferred<void>();
    const update = fakeUpdate();
    update.download.mockReturnValue(pendingDownload.promise);
    update.install.mockResolvedValue(undefined);
    const controller = new UpdateController({
      check: vi.fn().mockResolvedValue(update),
      relaunch,
    });
    const blocked = vi.fn();
    const unsubscribe = controller.onShowInstallingUpdate(blocked);

    const checking = controller.check();
    await vi.waitFor(() => expect(controller.isCloseBlocked).toBe(true));
    controller.notifyCloseBlocked();
    unsubscribe();
    controller.notifyCloseBlocked();
    expect(blocked).toHaveBeenCalledOnce();

    pendingDownload.resolve();
    await checking;
    expect(controller.isCloseBlocked).toBe(false);

    const installing = controller.quitAndInstall();
    await vi.waitFor(() => expect(controller.isCloseBlocked).toBe(true));
    await installing;
  });

  it("disposes listeners and closes a retained native update resource", async () => {
    const update = fakeUpdate();
    update.download.mockResolvedValue(undefined);
    update.close.mockResolvedValue(undefined);
    const controller = new UpdateController({
      check: vi.fn().mockResolvedValue(update),
      relaunch,
    });
    const listener = vi.fn();
    controller.onDidChange(listener);
    await controller.check();
    listener.mockClear();

    await controller.dispose();

    expect(update.close).toHaveBeenCalledOnce();
    await controller.check();
    expect(listener).not.toHaveBeenCalled();
  });

  it("closes an update returned after disposal without starting its download", async () => {
    const pending = deferred<ReturnType<typeof fakeUpdate> | null>();
    const update = fakeUpdate();
    update.close.mockResolvedValue(undefined);
    const controller = new UpdateController({
      check: vi.fn(() => pending.promise),
      relaunch,
    });

    const checking = controller.check();
    await controller.dispose();
    pending.resolve(update);
    await checking;

    expect(update.close).toHaveBeenCalledOnce();
    expect(update.download).not.toHaveBeenCalled();
  });
});

describe("updater compatibility facade", () => {
  it("adapts the six former push subscriptions to the singleton controller", async () => {
    const update = fakeUpdate("3.0.0");
    update.download.mockResolvedValue(undefined);
    update.install.mockResolvedValue(undefined);
    check.mockResolvedValueOnce(update);
    const checking = vi.fn();
    const available = vi.fn();
    const downloaded = vi.fn();
    const unavailable = vi.fn();
    const failed = vi.fn();
    const blocked = vi.fn();
    const cleanup = [
      onAutoUpdaterCheckingForUpdate(checking),
      onAutoUpdaterUpdateAvailable(available),
      onAutoUpdaterUpdateDownloaded(downloaded),
      onAutoUpdaterUpdateNotAvailable(unavailable),
      onAutoUpdaterError(failed),
      onShowInstallingUpdate(blocked),
    ];

    await expect(
      checkForUpdates("https://desktop-plus.invalid/ignored-by-tauri"),
    ).resolves.toBeUndefined();

    expect(checking).toHaveBeenCalledOnce();
    expect(available).toHaveBeenCalledOnce();
    expect(downloaded).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();

    applicationUpdateController.notifyCloseBlocked();
    expect(blocked).not.toHaveBeenCalled();
    await quitAndInstallUpdate();
    cleanup.forEach((unsubscribe) => unsubscribe());
  });
});
