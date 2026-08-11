import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../models/operation";
import { operationPresentationRole } from "./operation-presentation";

const record = (ownerWindow: string | null): OperationRecord => ({
  id: "operation-1",
  scope: { kind: "repository", lockKey: "repo", repositoryPath: "/repo" },
  ownerWindow,
  operation: "fetch",
  state: "running",
  cancellation: { kind: "available", label: "Cancel fetch" },
  progress: null,
  lastActivityAt: 1,
  outcome: null,
  error: null,
});

describe("operation presentation role", () => {
  it("identifies the owner window", () => {
    expect(operationPresentationRole(record("window-a"), "window-a")).toBe("owner");
  });

  it("identifies a peer as an observer", () => {
    expect(operationPresentationRole(record("window-a"), "window-b")).toBe("observer");
  });

  it("identifies an operation whose owner was destroyed", () => {
    expect(operationPresentationRole(record(null), "window-b")).toBe("unowned");
  });
});
