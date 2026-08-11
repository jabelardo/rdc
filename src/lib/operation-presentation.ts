import type { OperationPresentationRole, OperationRecord } from "../models/operation";

export function operationPresentationRole(
  record: OperationRecord,
  windowLabel: string,
): OperationPresentationRole {
  if (record.ownerWindow === windowLabel) {
    return "owner";
  }
  return record.ownerWindow === null ? "unowned" : "observer";
}
