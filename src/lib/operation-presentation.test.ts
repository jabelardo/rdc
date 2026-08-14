import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../models/operation";
import {
  isHistoryMovingOperation,
  isTerminalOperation,
  operationProgressViewModel,
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

describe("operation progress view model", () => {
  it("gives only the owner an available cancellation control", () => {
    const owner = operationProgressViewModel(record("window-a"), "window-a");
    const observer = operationProgressViewModel(record("window-a"), "window-b");

    expect(owner.operationLabel).toBe("Fetch");
    expect(owner.cancellationAvailable).toBe(true);
    expect(owner.cancellationLabel).toBe("Cancel fetch");
    expect(observer.cancellationAvailable).toBe(false);
    expect(observer.contextText).toBe("Started in another window");
  });

  it("maps cancellation and recovery lifecycle states to honest status text", () => {
    expect(
      operationProgressViewModel(
        { ...record("window-a"), state: "cancelling" },
        "window-a",
      ).statusText,
    ).toBe("Cancelling…");
    expect(
      operationProgressViewModel(
        { ...record("window-a"), state: "recovering" },
        "window-a",
      ).statusText,
    ).toBe("Recovering repository…");
  });

  it("does not offer cancellation for terminal records", () => {
    expect(
      operationProgressViewModel(
        { ...record("window-a"), state: "completed", outcome: "completed" },
        "window-a",
      ).cancellationAvailable,
    ).toBe(false);
  });

  it("shows the requested and slow lifecycle states instead of stale progress text", () => {
    expect(
      operationProgressViewModel(
        { ...record("window-a"), cancellation: { kind: "requested" } },
        "window-a",
      ).statusText,
    ).toBe("Cancelling…");
    expect(
      operationProgressViewModel(
        {
          ...record("window-a"),
          state: "takingLongerThanExpected",
          progress: { value: 0.5, description: "Receiving objects" },
        },
        "window-a",
      ).statusText,
    ).toBe("Taking longer than expected");
  });

  it.each([
    ["completed", "completed", "Operation completed"],
    ["cancelled", "recovered", "Operation cancelled"],
    ["timedOut", "unchanged", "Operation timed out"],
    ["failed", "unknown", "Outcome unknown"],
  ] as const)("maps %s/%s to its terminal status", (state, outcome, expected) => {
    expect(
      operationProgressViewModel(
        {
          ...record("window-a"),
          state,
          outcome,
          cancellation: { kind: "unavailable" },
        },
        "window-a",
      ).statusText,
    ).toBe(expected);
  });

  it("lets completion win a late cancellation request", () => {
    expect(
      operationProgressViewModel(
        {
          ...record("window-a"),
          state: "completed",
          outcome: "completed",
          cancellation: { kind: "requested" },
        },
        "window-a",
      ).statusText,
    ).toBe("Completed before cancellation");
  });

  it("requires explicit adoption before an unowned window can cancel", () => {
    const model = operationProgressViewModel(
      { ...record(null), cancellation: { kind: "available", label: "Cancel fetch" } },
      "window-b",
    );

    expect(model.adoptionAvailable).toBe(true);
    expect(model.adoptionLabel).toBe("Take control and cancel");
    expect(model.cancellationAvailable).toBe(false);
  });

  it("identifies recovery-required failures separately from ordinary failures", () => {
    const model = operationProgressViewModel(
      {
        ...record("window-a"),
        state: "failed",
        outcome: "unknown",
        error: { kind: "recoveryFailed", message: "could not restore", recoverable: false },
      },
      "window-a",
    );

    expect(model.recoveryRequired).toBe(true);
    expect(model.contextText).toBe("Repository recovery is required before continuing");
    expect(model.retryAvailable).toBe(false);
  });
});
