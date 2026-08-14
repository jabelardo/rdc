import type { RemoteOperation } from "./stores/remote-store";

export type RemoteWorkflowPhase = {
  readonly offset: number;
  readonly weight: number;
};

/**
 * Describes the progress phases that a remote action must complete before its repository refresh.
 *
 * This is deliberately a pure description. The store still owns refresh and error handling until
 * the native coordinator can publish those phases through the operation record.
 */
export function remoteWorkflowPhase(
  operation: RemoteOperation,
  phase: "transport" | "fetch" | "refresh",
): RemoteWorkflowPhase {
  if (operation === "fetch") {
    return phase === "refresh" ? { offset: 0.9, weight: 0.1 } : { offset: 0, weight: 0.9 };
  }

  if (phase === "transport") {
    return { offset: 0, weight: 0.65 };
  }
  if (phase === "fetch") {
    return { offset: 0.65, weight: 0.25 };
  }
  return { offset: 0.9, weight: 0.1 };
}
