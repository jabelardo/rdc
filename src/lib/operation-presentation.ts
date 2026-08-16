import type {
  GitOperationKind,
  OperationError,
  OperationProgress,
  OperationPresentationRole,
  OperationRecord,
} from "@/models/operation";

export type OperationProgressViewModel = {
  readonly operation: GitOperationKind;
  readonly operationLabel: string;
  readonly state: OperationRecord["state"];
  readonly progress: OperationProgress;
  readonly role: OperationPresentationRole;
  readonly cancellationAvailable: boolean;
  readonly cancellationLabel: string | null;
  readonly adoptionAvailable: boolean;
  readonly adoptionLabel: string | null;
  readonly statusText: string;
  readonly contextText: string | null;
  readonly recoveryRequired: boolean;
  /** Retry is opt-in per operation policy; recoverable errors do not imply it is safe. */
  readonly retryAvailable: boolean;
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

function operationLabel(record: OperationRecord): string {
  if (record.operation === "rebase") {
    const metadata = [
      record.cancellation.kind === "available" ? record.cancellation.label : "",
      record.progress?.title ?? "",
      record.progress?.description ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (metadata.includes("squash")) {
      return "Squash";
    }
    if (metadata.includes("reorder")) {
      return "Reorder";
    }
  }
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
  return labels[record.operation];
}

function lifecycleStatus(record: OperationRecord): string {
  if (record.cancellation.kind === "requested" && !isTerminalOperation(record.state)) {
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
      return record.outcome === "unknown"
        ? "Outcome unknown"
        : (record.error?.message ?? "Operation failed");
    case "completed":
      if (record.outcome === "unknown") {
        return "Outcome unknown";
      }
      return record.cancellation.kind === "requested"
        ? "Completed before cancellation"
        : "Operation completed";
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
  const recoveryRequired = record.error?.kind === "recoveryFailed";
  return {
    operation: record.operation,
    operationLabel: operationLabel(record),
    state: record.state,
    progress: record.progress ?? { value: 0 },
    role,
    cancellationAvailable:
      role === "owner" &&
      record.cancellation.kind === "available" &&
      (record.state === "running" || record.state === "takingLongerThanExpected"),
    cancellationLabel: record.cancellation.kind === "available" ? record.cancellation.label : null,
    adoptionAvailable:
      role === "unowned" &&
      record.cancellation.kind === "available" &&
      !isTerminalOperation(record.state),
    adoptionLabel: role === "unowned" ? "Take control and cancel" : null,
    statusText: lifecycleStatus(record),
    contextText: recoveryRequired
      ? "Repository recovery is required before continuing"
      : role === "observer"
        ? "Started in another window"
        : role === "unowned"
          ? "The window that started this operation is no longer open"
          : null,
    recoveryRequired,
    retryAvailable: false,
    error: record.error,
    outcome: record.outcome,
  };
}
