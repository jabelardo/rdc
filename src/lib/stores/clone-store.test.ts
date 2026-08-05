import { describe, expect, it, vi } from "vitest";
import type { ICloneProgress } from "../../models/progress";
import { CloneStore } from "./clone-store";

describe("CloneStore", () => {
  it("validates the URL and destination before invoking git", async () => {
    const clone = vi.fn(async () => undefined);
    const store = new CloneStore({ clone });

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
    const store = new CloneStore({ clone });
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
    const store = new CloneStore({ clone });

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
});
