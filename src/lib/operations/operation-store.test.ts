import { describe, expect, it, vi } from "vitest";
import type { OperationEventEnvelope, OperationRecord } from "@/models/operation";
import { OperationStore } from "./operation-store";

const record = (
  id: string,
  ownerWindow: string | null,
  state: OperationRecord["state"] = "running",
): OperationRecord => ({
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

  it("exposes the native terminal refresh requirement", async () => {
    const operation = {
      ...record("operation-1", "window-a", "completed"),
      refresh: { remoteNames: ["origin"], repositoryFacts: true },
    };
    const store = new OperationStore("window-a", {
      getScope: vi.fn().mockResolvedValue(operation.scope),
      getActive: vi.fn().mockResolvedValue(operation),
      listen: vi.fn().mockResolvedValue(() => {}),
    });

    await store.selectRepository("/repo-a");

    expect(store.state.refresh).toEqual({ remoteNames: ["origin"], repositoryFacts: true });
  });

  it("subscribes before hydration and preserves an event that arrives before the snapshot", async () => {
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    let resolveActive: ((record: OperationRecord | null) => void) | undefined;
    const active = new Promise<OperationRecord | null>((resolve) => {
      resolveActive = resolve;
    });
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockReturnValue(active),
      listen: vi.fn().mockImplementation(async (callback) => {
        receive = callback;
        return () => {};
      }),
    });

    const selecting = store.selectRepository("/repo-a");
    await vi.waitFor(() => expect(receive).toBeDefined());
    receive?.(envelope(record("operation-2", "window-a")));
    resolveActive?.(record("operation-1", "window-a"));
    await selecting;

    expect(store.state.operation?.id).toBe("operation-2");
    expect(store.state.role).toBe("observer");
  });

  it("remembers its window label before an operation is hydrated", async () => {
    const store = new OperationStore("", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a")),
      listen: vi.fn().mockResolvedValue(() => {}),
    });
    store.setWindowLabel("window-a");
    await store.selectRepository("/repo-a");
    expect(store.state.role).toBe("owner");
  });

  it("reconciles an active operation after a window misses its start event", async () => {
    const getActive = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record("operation-1", "window-a"));
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive,
      listen: vi.fn().mockResolvedValue(() => {}),
    });
    await store.selectRepository("/repo-a");
    expect(store.state.operation).toBeNull();

    await store.refreshActiveOperation();

    expect(store.state.operation?.id).toBe("operation-1");
    expect(store.state.role).toBe("observer");
  });

  it("clears an active operation after a window misses its finish event", async () => {
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi
        .fn()
        .mockResolvedValueOnce(record("operation-1", "window-a"))
        .mockResolvedValueOnce(null),
      listen: vi.fn().mockResolvedValue(() => {}),
    });
    await store.selectRepository("/repo-a");
    expect(store.state.operation?.id).toBe("operation-1");

    await store.refreshActiveOperation();

    expect(store.state.operation).toBeNull();
    expect(store.state.repositoryPath).toBe("/repo-a");
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
      getScope: vi
        .fn()
        .mockResolvedValue(recordForScope("repo-a", "operation-a", "window-a").scope),
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

  it("publishes cancellation and timeout state from native records", async () => {
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    const cancel = vi.fn().mockResolvedValue({
      ...record("operation-1", "window-a", "cancelling"),
      cancellation: { kind: "requested" },
    });
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a")),
      listen: vi.fn().mockImplementation(async (callback) => {
        receive = callback;
        return () => {};
      }),
      cancel,
    });
    await store.selectRepository("/repo-a");
    receive?.(envelope(record("operation-1", "window-a", "takingLongerThanExpected")));
    expect(store.state.takingLonger).toBe(true);

    await store.requestCancellation(true);
    expect(cancel).toHaveBeenCalledWith("operation-1", true);
    expect(store.state.cancellationRequested).toBe(true);
  });

  it("preserves recovery and terminal error state", async () => {
    let receive: ((event: OperationEventEnvelope) => void) | undefined;
    const store = new OperationStore("window-a", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a")),
      listen: vi.fn().mockImplementation(async (callback) => {
        receive = callback;
        return () => {};
      }),
    });
    await store.selectRepository("/repo-a");
    const recovering = record("operation-1", "window-a", "recovering");
    receive?.(envelope(recovering));
    expect(store.state.recovering).toBe(true);

    const failed = {
      ...record("operation-1", "window-a", "failed"),
      outcome: "unknown" as const,
      error: { kind: "failed" as const, message: "recovery failed", recoverable: false },
    };
    receive?.(envelope(failed));
    expect(store.state.outcome).toBe("unknown");
    expect(store.state.error?.message).toBe("recovery failed");
  });

  it("dismisses a terminal operation after its outcome is presented", async () => {
    const store = new OperationStore("window-a", {
      getScope: vi.fn().mockResolvedValue(record("operation-1", "window-a").scope),
      getActive: vi.fn().mockResolvedValue(record("operation-1", "window-a", "completed")),
      listen: vi.fn().mockResolvedValue(() => {}),
    });
    await store.selectRepository("/repo-a");

    store.dismissTerminalOperation();

    expect(store.state.operation).toBeNull();
    expect(store.state.repositoryPath).toBe("/repo-a");
  });

  it("isolates selection changes and cleanup", async () => {
    const cleanups = [vi.fn(), vi.fn()];
    let selection = 0;
    let subscription = 0;
    const store = new OperationStore("window-b", {
      getScope: vi.fn().mockImplementation(async () => record("operation", null).scope),
      getActive: vi.fn().mockImplementation(async () => record(`operation-${selection++}`, null)),
      listen: vi.fn().mockImplementation(async () => cleanups[subscription++]),
    });
    await store.selectRepository("/repo-a");
    await store.selectRepository(null);
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(store.state.operation).toBeNull();
    store.dispose();
  });
});
