import { describe, expect, it, vi } from "vitest";
import type { ICloneProgress } from "../../models/progress";
import type { OperationEventEnvelope, OperationRecord } from "../../models/operation";
import { CloneStore } from "./clone-store";

const noNativeTracking = () => ({
  getActive: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
});

const nativeClone = (state: OperationRecord["state"] = "running"): OperationRecord => ({
  id: "clone-operation-1",
  scope: {
    kind: "cloneDestination",
    lockKey: "/work/repo",
    destinationPath: "/work/repo",
  },
  ownerWindow: "window-a",
  operation: "clone",
  state,
  cancellation: { kind: "available", label: "Cancel clone" },
  progress: { value: 0.25, description: "Receiving objects" },
  lastActivityAt: 1,
  outcome: null,
  error: null,
});

describe("CloneStore", () => {
  it("validates the URL and destination before invoking git", async () => {
    const clone = vi.fn(async () => undefined);
    const store = new CloneStore({ clone, ...noNativeTracking() });

    expect(await store.clone("   ", "/work/repo")).toBeNull();
    expect(store.state.error).toBe("Enter a repository URL.");
    expect(await store.clone("/remote.git", "   ")).toBeNull();
    expect(store.state.error).toBe("Choose a destination path.");
    expect(clone).not.toHaveBeenCalled();
  });

  it("clones a generic URL with progress and returns the destination", async () => {
    const progress: ICloneProgress = {
      kind: "clone",
      value: 0.5,
      description: "Receiving objects",
    };
    const clone = vi.fn(
      async (
        _url: string,
        _path: string,
        _login?: string | null,
        _options?: object,
        callback?: (progress: ICloneProgress) => void,
      ) => callback?.(progress),
    );
    const store = new CloneStore({ clone, ...noNativeTracking() });
    const observed: ICloneProgress[] = [];
    store.onDidUpdate((state) => {
      if (state.progress !== null) {
        observed.push(state.progress);
      }
    });

    await expect(store.clone(" /remotes/source.git ", " /work/source ")).resolves.toBe(
      "/work/source",
    );

    expect(clone).toHaveBeenCalledWith(
      "/remotes/source.git",
      "/work/source",
      null,
      {},
      expect.any(Function),
      false,
    );
    expect(observed).toContainEqual(progress);
    expect(store.state).toMatchObject({
      operation: null,
      progress: null,
      error: null,
    });
  });

  it("serializes clone attempts and ignores stale progress after reset", async () => {
    let reportProgress: ((progress: ICloneProgress) => void) | undefined;
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const clone = vi.fn(
      async (
        _url: string,
        _path: string,
        _login?: string | null,
        _options?: object,
        callback?: (progress: ICloneProgress) => void,
      ) => {
        reportProgress = callback;
        await pending;
      },
    );
    const store = new CloneStore({ clone, ...noNativeTracking() });

    const first = store.clone("/remote.git", "/work/repo");
    await Promise.resolve();
    expect(await store.clone("/other.git", "/work/other")).toBeNull();
    store.reset();
    reportProgress?.({
      kind: "clone",
      value: 0.9,
      description: "stale",
    });
    finish?.();
    expect(await first).toBeNull();
    expect(store.state.progress).toBeNull();
    expect(clone).toHaveBeenCalledOnce();
  });

  it("presents authentication failures using the system credential boundary", async () => {
    const store = new CloneStore({
      ...noNativeTracking(),
      clone: vi.fn(async () => {
        throw {
          message: "authentication failed",
          kind: "HTTPSAuthenticationFailed",
          isAuthFailure: true,
        };
      }),
    });

    expect(await store.clone("https://example.com/org/repo.git", "/work/repo")).toBeNull();
    expect(store.state.error).toMatch(/Authentication failed.*credential helper.*SSH agent/s);
  });

  it("hydrates and follows the native destination-scoped operation", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    const store = new CloneStore({
      clone: vi.fn(async () => pending),
      getActive: vi.fn(async () => nativeClone()),
      listen: vi.fn(async (callback) => {
        receive = callback;
        return () => {};
      }),
    });

    const clone = store.clone("/remote.git", "/work/repo");
    await vi.waitFor(() => expect(store.state.nativeOperation?.id).toBe("clone-operation-1"));
    receive?.({
      record: { ...nativeClone(), state: "recovering" },
      event: { kind: "state", operationId: "clone-operation-1", state: "recovering" },
    });
    expect(store.state.nativeOperation?.state).toBe("recovering");

    finish?.();
    await expect(clone).resolves.toBe("/work/repo");
    expect(store.state.nativeOperation).toBeNull();
  });
});
