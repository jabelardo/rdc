import type { RemoteState } from "./stores/remote-store";

export type RemoteEnablement = {
  readonly canFetch: boolean;
  readonly canPush: boolean;
  readonly canPull: boolean;
};

export type RemoteEnablementInput = {
  readonly hasSelection: boolean;
  readonly selectedRepositoryPath: string | null;
  readonly remoteState?: RemoteState;
  /** Native repository lock state; authoritative when present. */
  readonly repositoryOperationActive?: boolean;
};

export function remoteEnablement(input: RemoteEnablementInput): RemoteEnablement {
  const canFetch =
    input.hasSelection &&
    input.remoteState !== undefined &&
    input.remoteState.repositoryPath === input.selectedRepositoryPath &&
    input.remoteState.currentRemote !== null &&
    !input.remoteState.loading &&
    input.repositoryOperationActive !== true;
  const canPush = canFetch && input.remoteState?.currentBranch !== null;
  const canPull = canPush && typeof input.remoteState?.currentBranch?.upstream === "string";
  return { canFetch, canPush, canPull };
}
