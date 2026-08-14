import type {
  GitOperationKind,
  OperationError,
  OperationProgress,
  OperationPresentationRole,
  OperationRecord,
} from "../models/operation";

export type OperationProgressViewModel = {
  readonly operation: GitOperationKind;
  readonly operationLabel: string;
  readonly state: OperationRecord["state"];
  readonly progress: OperationProgress;
  readonly role: OperationPresentationRole;
  readonly cancellationAvailable: boolean;
  readonly cancellationLabel: string | null;
  readonly statusText: string;
  readonly contextText: string | null;
  readonly error: OperationError | null;
  readonly outcome: OperationRecord["outcome"];
};

export function operationPresentationRole(
  record: OperationRecord,
  windowLabel: string,
): OperationPresentationRole {
  if (record.ownerWindow === windowLabel) {
    return "owner";
  }
  return record.ownerWindow === null ? "unowned" : "observer";
}

/** History is stale while one of these operations is moving repository refs. */
export function isHistoryMovingOperation(operation: GitOperationKind): boolean {
  return ["merge", "rebase", "cherryPick", "revert"].includes(operation);
}

export function isTerminalOperation(state: OperationRecord["state"]): boolean {
  return ["completed", "cancelled", "timedOut", "failed"].includes(state);
}

function operationLabel(operation: GitOperationKind): string {
  const labels: Record<GitOperationKind, string> = {
    fetch: "Fetch",
    push: "Push",
    pull: "Pull",
    checkout: "Checkout",
    clone: "Clone",
    commit: "Commit",
    merge: "Merge",
    rebase: "Rebase",
    cherryPick: "Cherry-pick",
    revert: "Revert",
  };
  return labels[operation];
}

function lifecycleStatus(record: OperationRecord): string {
  if (record.cancellation.kind === "requested") {
    return "Cancelling…";
  }
  switch (record.state) {
    case "cancelling":
      return "Cancelling…";
    case "recovering":
      return "Recovering repository…";
    case "timedOut":
      return record.error?.message ?? "Operation timed out";
    case "cancelled":
      return record.outcome === "completed"
        ? "Completed before cancellation"
        : (record.error?.message ?? "Operation cancelled");
    case "failed":
      return record.error?.message ?? "Operation failed";
    case "completed":
      return record.outcome === "unknown" ? "Outcome unknown" : "Operation completed";
    case "takingLongerThanExpected":
      return "Taking longer than expected";
    case "running":
      return record.progress?.description ?? record.progress?.title ?? "Operation in progress";
  }
}

export function operationProgressViewModel(
  record: OperationRecord,
  windowLabel: string,
  roleOverride?: OperationPresentationRole,
): OperationProgressViewModel {
  const role = roleOverride ?? operationPresentationRole(record, windowLabel);
  return {
    operation: record.operation,
    operationLabel: operationLabel(record.operation),
    state: record.state,
    progress: record.progress ?? { value: 0 },
    role,
    cancellationAvailable:
      role === "owner" &&
      record.cancellation.kind === "available" &&
      (record.state === "running" || record.state === "takingLongerThanExpected"),
    cancellationLabel:
      record.cancellation.kind === "available" ? record.cancellation.label : null,
    statusText: lifecycleStatus(record),
    contextText:
      role === "observer"
        ? "Started in another window"
        : role === "unowned"
          ? "The window that started this operation is no longer open"
          : null,
    error: record.error,
    outcome: record.outcome,
  };
}
