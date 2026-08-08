import { GitErrorKind } from "../models/git-error-kind";
import { describeError } from "./format-error";
import { isCommandError, type ICommandError } from "./git-ipc";

/**
 * Kinds where the failure is **provably** about reaching a remote: authentication and
 * transport. The network guidance below is only truthful for these.
 */
const TransportKinds = new Set<GitErrorKind>([
  GitErrorKind.SSHKeyAuditUnverified,
  GitErrorKind.SSHAuthenticationFailed,
  GitErrorKind.SSHPermissionDenied,
  GitErrorKind.HTTPSAuthenticationFailed,
  GitErrorKind.RemoteDisconnection,
  GitErrorKind.HostDown,
  GitErrorKind.HTTPSRepositoryNotFound,
  GitErrorKind.SSHRepositoryNotFound,
]);

/** Transport-sounding prose in an *unclassified* git message. */
const TransportMessage = [
  /unable to access/i,
  /could not resolve host/i,
  /connection (?:refused|timed out|reset|closed)/i,
  /remote end hung up/i,
  /early EOF/i,
  /unexpected (?:disconnect|eof)/i,
  /ssl certificate/i,
  /self-signed certificate/i,
  /could not read from remote repository/i,
  /the requested url returned error/i,
  /failed to connect/i,
  /proxy/i,
  /fetch-pack/i,
  /http request failed/i,
  /unable to connect/i,
];

function isTransportFailure(error: ICommandError): boolean {
  if (error.kind !== undefined && TransportKinds.has(error.kind)) {
    return true;
  }
  return TransportMessage.some((pattern) => pattern.test(error.message));
}

export const NetworkGuidance =
  "rdc currently relies on system Git configuration for network access. Application-managed PAC/proxy and certificate trust are not supported yet; configure the proxy or certificate for system Git and try again.";

/**
 * User-facing recovery for failures shared by clone/fetch/pull/push.
 *
 * The network guidance is attached **only** when the failure is actually about reaching a remote
 * — a classified transport/auth kind, or unclassified prose that smells like transport. A local
 * failure (destination folder not empty, a locked repository, a bad path) gets its raw git message
 * instead; appending network advice to those would blame connectivity for a problem connectivity
 * had nothing to do with.
 */
export function describeRemoteError(error: unknown): string {
  if (isCommandError(error)) {
    if (
      error.kind === GitErrorKind.PushNotFastForward ||
      error.kind === GitErrorKind.NoExistingRemoteBranch
    ) {
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
    // A clone into a folder that already has content is a local, actionable mistake — say exactly
    // that rather than the raw git line or, worse, the network guidance.
    if (/already exists and is not an empty directory/i.test(error.message)) {
      return "The destination folder already exists and is not empty. Choose a different destination path or empty the folder, then try again.";
    }

    if (isTransportFailure(error)) {
      return [error.message, NetworkGuidance].join("\n\n");
    }

    return error.message;
  }

  return describeError(error);
}
