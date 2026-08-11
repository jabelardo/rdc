import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  OperationEvent,
  OperationEventEnvelope,
  OperationRecord,
  OperationScope,
} from "../models/operation";

export type { OperationEventEnvelope } from "../models/operation";

export function getActiveOperationForRepository(
  repositoryPath: string,
): Promise<OperationRecord | null> {
  return invoke<OperationRecord | null>("get_active_operation_for_repository", { repositoryPath });
}

export function getOperationScopeForRepository(
  repositoryPath: string,
): Promise<OperationScope | null> {
  return invoke<OperationScope | null>("get_operation_scope_for_repository", { repositoryPath });
}

export function getLatestOperationEvent(operationId: string): Promise<OperationEvent | null> {
  return invoke<OperationEvent | null>("get_latest_operation_event", { operationId });
}

export function requestOperationCancellation(
  operationId: string,
  confirmObserver = false,
): Promise<OperationRecord> {
  return invoke<OperationRecord>("request_operation_cancellation", {
    operationId,
    confirmObserver,
  });
}

/** Listen to all native operation events; callers must filter by the selected repository scope. */
export function listenToOperationEvents(
  callback: (event: OperationEventEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<OperationEventEnvelope>("operation-event", (event) => callback(event.payload));
}
