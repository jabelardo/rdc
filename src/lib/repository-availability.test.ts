import { describe, expect, it } from "vitest";
import { repositoryAvailability } from "./repository-availability";

describe("repositoryAvailability", () => {
  it("accepts an ordinary working repository", () => {
    expect(
      repositoryAvailability("populated", {
        kind: "regular",
        topLevelWorkingDirectory: "/repo",
        gitDir: "/repo/.git",
      }),
    ).toEqual({ available: true });
  });

  // The case from the Phase 8b screenshot: the directory was deleted while it was selected.
  it("explains a repository that is no longer there, without naming a git command", () => {
    const availability = repositoryAvailability("populated", { kind: "missing" });

    expect(availability.available).toBe(false);
    expect(availability).toMatchObject({
      message: "populated is no longer available. It may have been moved, renamed or deleted.",
    });
  });

  it("explains a bare repository", () => {
    expect(repositoryAvailability("mirror", { kind: "bare" })).toMatchObject({
      available: false,
      message: "mirror is a bare repository, which has no working tree to show.",
    });
  });

  it("explains git's dubious-ownership refusal", () => {
    expect(repositoryAvailability("shared", { kind: "unsafe", path: "/repo" })).toMatchObject({
      available: false,
      message: "shared is owned by another user, so Git refuses to open it.",
    });
  });

  // One wording per cause is what lets the message store collapse the copies that different
  // stores would otherwise each produce.
  it("gives the same repository the same wording every time", () => {
    const first = repositoryAvailability("populated", { kind: "missing" });
    const second = repositoryAvailability("populated", { kind: "missing" });

    expect(first).toEqual(second);
  });
});
