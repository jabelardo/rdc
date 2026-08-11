import { describe, expect, it } from "vitest";
import type { OperationEventEnvelope, OperationScope } from "../models/operation";
import {
  createOperationEventFilter,
  isOperationEventForScope,
  OperationEventRouter,
} from "./operation-events";

const scope = (lockKey: string): OperationScope => ({
  kind: "repository",
  lockKey,
  repositoryPath: `/work/${lockKey}`,
});

const event = (lockKey: string): OperationEventEnvelope => ({
  record: {
    id: `operation-${lockKey}`,
    scope: scope(lockKey),
    ownerWindow: "repository-1",
    operation: "fetch",
    state: "running",
    cancellation: { kind: "unavailable" },
    progress: null,
    lastActivityAt: 1,
    outcome: null,
    error: null,
  },
  event: { kind: "state", operationId: `operation-${lockKey}`, state: "recovering" },
});

describe("operation event routing", () => {
  it("matches by stable scope identity", () => {
    expect(isOperationEventForScope(event("repo-a"), scope("repo-a"))).toBe(true);
    expect(isOperationEventForScope(event("repo-a"), scope("repo-b"))).toBe(false);
  });

  it("filters events for a window without changing the operation record", () => {
    const filter = createOperationEventFilter(scope("repo-a"));
    expect([event("repo-a"), event("repo-b")].filter(filter)).toHaveLength(1);
    expect(filter(event("repo-a")).record.ownerWindow).toBe("repository-1");
  });

  it("routes only the currently selected scope after a selection change", () => {
    const received: OperationEventEnvelope[] = [];
    const router = new OperationEventRouter((operationEvent) => received.push(operationEvent));

    router.selectScope(scope("repo-a"));
    router.receive(event("repo-a"));
    router.receive(event("repo-b"));
    router.selectScope(scope("repo-b"));
    router.receive(event("repo-a"));
    router.receive(event("repo-b"));

    expect(received.map((operationEvent) => operationEvent.record.scope.lockKey)).toEqual([
      "repo-a",
      "repo-b",
    ]);
  });

  it("stops routing while no repository is selected", () => {
    const received: OperationEventEnvelope[] = [];
    const router = new OperationEventRouter((operationEvent) => received.push(operationEvent));
    router.selectScope(scope("repo-a"));
    router.clear();
    router.receive(event("repo-a"));
    expect(received).toHaveLength(0);
  });
});
