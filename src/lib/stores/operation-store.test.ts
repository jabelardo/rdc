import { describe, expect, it, vi } from "vitest";
import type { OperationEventEnvelope, OperationRecord } from "../../models/operation";
import { OperationStore } from "./operation-store";

const record = (id: string, ownerWindow: string | null, state: OperationRecord["state"] = "running"): OperationRecord => ({
  id,
  scope: { kind: "repository", lockKey: "repo-a", repositoryPath: "/repo-a" },
  ownerWindow,
  operation: "fetch",
  state,
  cancellation: { kind: "available", label: "Cancel fetch" },
  progress: { value: 0.5, title: "Fetching" },
  lastActivityAt: 1,
  outcome: null,
  error: null,
});

const recordForScope = (
  lockKey: string,
  id: string,
  ownerWindow: string | null,
): OperationRecord => ({
  ...record(id, ownerWindow),
  scope: { kind: "repository", lockKey, repositoryPath: `/${lockKey}` },
});

const envelope = (operation: OperationRecord): OperationEventEnvelope => ({
  record: operation,
  event: { kind: "progress", operationId: operation.id, progress: operation.progress! },
});

describe("OperationStore", () => {
  it("hydrates and identifies the owner", async () => {
    const store = new OperationStore("window-a", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a")),
      listen: vi.fn().mockResolvedValue(() => {}),
    });
    await store.selectRepository("/repo-a");
    expect(store.state.operation?.id).toBe("operation-1");
    expect(store.state.role).toBe("owner");
    expect(store.state.progress?.value).toBe(0.5);
  });

  it("filters repositories and rejects stale events", async () => {
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a")),
      listen: vi.fn().mockImplementation(async (callback) => {
        receive = callback;
        return () => {};
      }),
    });
    await store.selectRepository("/repo-a");
    receive?.(envelope(record("operation-2", "window-a")));
    expect(store.state.operation?.id).toBe("operation-1");
    receive?.(envelope(record("operation-1", "window-a", "recovering")));
    expect(store.state.recovering).toBe(true);
  });

  it("shows an unowned operation after its owner window closes", async () => {
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a")),
      listen: vi.fn().mockImplementation(async (callback) => {
        receive = callback;
        return () => {};
      }),
    });
    await store.selectRepository("/repo-a");
    receive?.(envelope(record("operation-1", null)));
    expect(store.state.role).toBe("unowned");
  });

  it("does not show progress from a different repository", async () => {
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(recordForScope("repo-a", "operation-a", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(null),
      listen: vi.fn().mockImplementation(async (callback) => {
        receive = callback;
        return () => {};
      }),
    });
    await store.selectRepository("/repo-a");
    receive?.(envelope(recordForScope("repo-b", "operation-b", "window-a")));
    expect(store.state.operation).toBeNull();
  });

  it("isolates selection changes and cleanup", async () => {
    const cleanups = [vi.fn(), vi.fn()];
    let selection = 0;
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockImplementation(async () => record("operation", null).scope),
      getActive: vi.fn().mockImplementation(async () => record(`operation-${selection++}`, null)),
      listen: vi.fn().mockImplementation(async () => cleanups[selection - 1]),
    });
    await store.selectRepository("/repo-a");
    await store.selectRepository(null);
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(store.state.operation).toBeNull();
    store.dispose();
  });
});
