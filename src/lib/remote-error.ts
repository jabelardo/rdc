import { GitErrorKind } from "../models/git-error-kind";
import { describeError } from "./format-error";
import { isCommandError } from "./git-ipc";

/** User-facing recovery for failures shared by clone/fetch/pull/push. */
export function describeRemoteError(error: unknown): string {
  if (isCommandError(error)) {
    if (error.kind === GitErrorKind.PushNotFastForward) {
      return "The remote has been updated since your last synchronization. Fetch and pull its changes before pushing again.";
    }
    if (error.kind === GitErrorKind.MergeConflicts) {
      return "Pull produced merge conflicts. Resolve the conflicted files, stage the resolutions, and commit the merge before synchronizing again.";
    }
    if (
      error.kind === GitErrorKind.LocalChangesOverwritten ||
      error.kind === GitErrorKind.MergeWithLocalChanges
    ) {
      return "Local changes prevent this pull. Commit or discard the affected changes before pulling again.";
    }
    if (error.isAuthFailure) {
      return [
        "Authentication failed.",
        "rdc currently uses credentials available to the system Git credential helper or SSH agent. Confirm that the remote is accessible with system Git, that your SSH key is loaded, and that your account has permission to access the repository.",
      ].join("\n\n");
    }

    return [
      error.message,
      "rdc currently relies on system Git configuration for network access. Application-managed PAC/proxy and certificate trust are not supported yet; configure the proxy or certificate for system Git and try again.",
    ].join("\n\n");
  }

  return describeError(error);
}
