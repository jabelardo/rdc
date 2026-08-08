import { describe, expect, it } from "vitest";
import { ComputedAction } from "../../models/computed-action";
import { debugMergePreview, debugMergedBranches } from "./inject-test-state";

/**
 * The debug menu exists so a dialog can be reviewed without a repository behind it. That is only
 * true while the stub data actually reaches every state the dialog distinguishes — otherwise the
 * preview looks fine and proves nothing, which is exactly how it drifted before.
 */
describe("debug merge previews", () => {
  it("reaches every outcome the merge dialog renders differently", () => {
    const kinds = new Set(
      [
        "feature/add-user-authentication-flow",
        "hotfix/critical-security-patch",
        "bugfix/resolve-navigation-issue",
        "feature/update-dashboard-layout",
        "release/v2.0.0",
        "origin/develop",
        "develop",
      ].map((name) => debugMergePreview(name)?.status.kind),
    );

    expect(kinds).toContain(ComputedAction.Clean);
    expect(kinds).toContain(ComputedAction.Conflicts);
    expect(kinds).toContain(ComputedAction.Invalid);
  });

  it("covers the singular, plural and thousands wordings of the commit count", () => {
    expect(debugMergePreview("hotfix/critical-security-patch")?.commitCount).toBe(1);
    expect(debugMergePreview("feature/add-user-authentication-flow")?.commitCount).toBe(4);
    expect(debugMergePreview("bugfix/resolve-navigation-issue")?.commitCount).toBeGreaterThan(999);
  });

  it("includes a branch that merges cleanly, so the dialog is not all edge cases", () => {
    const preview = debugMergePreview("feature/add-user-authentication-flow");

    expect(preview?.status.kind).toBe(ComputedAction.Clean);
    expect(preview?.commitCount).toBeGreaterThan(0);
  });

  it("names one already-merged branch, so the candidate filter has something to remove", () => {
    const merged = debugMergedBranches();

    expect([...merged.keys()]).toEqual(["refs/heads/develop"]);
  });

  it("returns nothing for a branch outside the stub set", () => {
    // A real repository's branches must fall through to git rather than getting a canned answer.
    expect(debugMergePreview("some-real-branch")).toBeNull();
  });
});
