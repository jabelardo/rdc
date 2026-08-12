import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../models/operation";
import {
  isHistoryMovingOperation,
  isTerminalOperation,
  operationPresentationRole,
} from "./operation-presentation";

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

describe("history operation presentation policy", () => {
  it("suppresses stale history for ref-moving history operations", () => {
    expect(isHistoryMovingOperation("merge")).toBe(true);
    expect(isHistoryMovingOperation("rebase")).toBe(true);
    expect(isHistoryMovingOperation("cherryPick")).toBe(true);
    expect(isHistoryMovingOperation("revert")).toBe(true);
  });

  it("leaves non-history operations available", () => {
    expect(isHistoryMovingOperation("fetch")).toBe(false);
    expect(isHistoryMovingOperation("checkout")).toBe(false);
    expect(isHistoryMovingOperation("commit")).toBe(false);
  });
});

describe("terminal operation presentation policy", () => {
  it("refreshes only after terminal lifecycle states", () => {
    expect(isTerminalOperation("completed")).toBe(true);
    expect(isTerminalOperation("cancelled")).toBe(true);
    expect(isTerminalOperation("timedOut")).toBe(true);
    expect(isTerminalOperation("failed")).toBe(true);
    expect(isTerminalOperation("running")).toBe(false);
    expect(isTerminalOperation("recovering")).toBe(false);
  });
});
