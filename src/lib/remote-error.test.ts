import { describe, expect, it } from "vitest";
import { GitErrorKind } from "../models/git-error-kind";
import { describeRemoteError, NetworkGuidance } from "./remote-error";

/** A command-shaped rejection. `kind` undefined mimics an unclassified (kind-null) git failure. */
function commandError(message: string, kind?: GitErrorKind, isAuthFailure = false): unknown {
  return { message, isAuthFailure, ...(kind === undefined ? {} : { kind }) };
}

describe("describeRemoteError", () => {
  it("adds network guidance only to a classified transport failure", () => {
    expect(
      describeRemoteError(
        commandError("fatal: The remote end hung up", GitErrorKind.RemoteDisconnection),
      ),
    ).toContain(NetworkGuidance);
  });

  it("adds network guidance to unclassified prose that smells like transport", () => {
    expect(
      describeRemoteError(
        commandError(
          "fatal: unable to access 'https://example.invalid/repo.git': Could not resolve host: example.invalid",
        ),
      ),
    ).toContain(NetworkGuidance);
  });

  it("does not add network guidance to a local clone failure, and says what to do instead", () => {
    const message = describeRemoteError(
      commandError(
        "fatal: destination path '/tmp/rdc' already exists and is not an empty directory.",
      ),
    );

    expect(message).toContain("The destination folder already exists and is not empty.");
    expect(message).not.toContain(NetworkGuidance);
    expect(message.match(/network/gi)).toBeNull();
  });

  it("returns the raw git message for an unrelated local failure, with no network advice", () => {
    const message = describeRemoteError(
      commandError("fatal: could not lock config file .git/config: File exists"),
    );

    expect(message).toBe("fatal: could not lock config file .git/config: File exists");
    expect(message).not.toContain(NetworkGuidance);
  });

  it("keeps the authentication-specific copy, without the PAC guidance", () => {
    const message = describeRemoteError(
      commandError(
        "fatal: Authentication failed for 'https://...'",
        GitErrorKind.HTTPSAuthenticationFailed,
        true,
      ),
    );

    expect(message).toContain("Authentication failed.");
    expect(message).not.toContain(NetworkGuidance);
  });

  it("keeps the fast-forward recovery for sync races", () => {
    expect(describeRemoteError(commandError("", GitErrorKind.PushNotFastForward))).toContain(
      "Fetch and pull its changes",
    );
  });

  it("treats a non-command error like a plain failure", () => {
    expect(describeRemoteError(new Error("boom"))).toBe("boom");
  });
});
