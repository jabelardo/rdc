import { describe, expect, it } from "vitest";
import { deleteBranchRefusal } from "./delete-branch-refusal";

describe("deleteBranchRefusal", () => {
  it("refuses the current branch", () => {
    expect(deleteBranchRefusal("main", "main", "main")).toBe(
      "You cannot delete the current branch 'main'.",
    );
  });

  // Current wins when a branch is both, because that is the one the user can act on: check out
  // something else and the branch becomes deletable, which is not true of being the default.
  it("names the current branch first when it is also the default", () => {
    expect(deleteBranchRefusal("main", "main", "main")).toMatch(/current/);
  });

  it("refuses the default branch from another branch", () => {
    expect(deleteBranchRefusal("main", "feature", "main")).toBe(
      "You cannot delete the default branch 'main'.",
    );
  });

  it("allows an ordinary branch", () => {
    expect(deleteBranchRefusal("feature", "main", "main")).toBeNull();
  });

  // A repository with no default branch must not refuse every branch by matching null to null.
  it("does not refuse when there is no current or default branch", () => {
    expect(deleteBranchRefusal("feature", null, null)).toBeNull();
  });
});
