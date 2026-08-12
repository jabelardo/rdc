import type {
  GitOperationKind,
  OperationPresentationRole,
  OperationRecord,
} from "../models/operation";

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
