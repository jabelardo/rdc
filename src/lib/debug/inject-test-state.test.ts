import { describe, expect, it } from "vitest";
import { ComputedAction } from "../../models/computed-action";
import { debugMergePreview, debugMergedBranches, debugRebasePreview } from "./inject-test-state";

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

  it("includes a branch too long for the row, so the tooltip has something to reveal", () => {
    // The tooltip's whole purpose is the truncated case; stub data that never truncates would let
    // it look correct while proving nothing.
    const longest = [
      "feature/add-user-authentication-flow",
      "feature/consolidate-address-module-backend-validation-and-error-reporting-pipeline",
    ].sort((left, right) => right.length - left.length)[0];

    expect(longest.length).toBeGreaterThan(60);
    expect(debugMergePreview(longest)?.status.kind).toBe(ComputedAction.Clean);
  });

  it("returns nothing for a branch outside the stub set", () => {
    // A real repository's branches must fall through to git rather than getting a canned answer.
    expect(debugMergePreview("some-real-branch")).toBeNull();
  });
});

/**
 * The rebase dialog's debug previews must reach every state it renders differently, on the same
 * grounds as the merge ones: canned data that stops exercising a state fails silently.
 */
describe("debug rebase previews", () => {
  it("reaches clean, invalid and every clean wording", () => {
    expect(debugRebasePreview("develop")?.kind).toBe(ComputedAction.Clean);
    expect(debugRebasePreview("release/v2.0.0")?.kind).toBe(ComputedAction.Invalid);
  });

  it("covers the fast-forward, update and up-to-date wordings", () => {
    // Fast-forward: behind only.
    expect(debugRebasePreview("hotfix/critical-security-patch")).toEqual({
      kind: ComputedAction.Clean,
      commitsAhead: 0,
      commitsBehind: 4,
    });
    // Update: both ahead and behind.
    expect(debugRebasePreview("develop")).toEqual({
      kind: ComputedAction.Clean,
      commitsAhead: 3,
      commitsBehind: 2,
    });
    // Up to date: not behind, so a rebase would be a no-op.
    expect(debugRebasePreview("feature/update-dashboard-layout")).toEqual({
      kind: ComputedAction.Clean,
      commitsAhead: 2,
      commitsBehind: 0,
    });
  });

  it("covers the singular and thousands wordings of the commit count", () => {
    expect(debugRebasePreview("feature/add-user-authentication-flow")?.kind).toBe(
      ComputedAction.Clean,
    );
    const singular = debugRebasePreview("feature/add-user-authentication-flow");
    expect(singular && singular.kind === ComputedAction.Clean ? singular.commitsAhead : 0).toBe(1);
    const thousands = debugRebasePreview("bugfix/resolve-navigation-issue");
    expect(
      thousands && thousands.kind === ComputedAction.Clean ? thousands.commitsBehind : 0,
    ).toBeGreaterThan(999);
  });

  it("includes a clean branch so the dialog is not all edge cases", () => {
    const preview = debugRebasePreview("origin/develop");

    expect(preview?.kind).toBe(ComputedAction.Clean);
    expect(preview && "commitsBehind" in preview ? preview.commitsBehind : 0).toBeGreaterThan(0);
  });

  it("includes a branch too long for the row, so the tooltip has something to reveal", () => {
    const longest = [
      "feature/add-user-authentication-flow",
      "feature/consolidate-address-module-backend-validation-and-error-reporting-pipeline",
    ].sort((left, right) => right.length - left.length)[0];

    expect(longest.length).toBeGreaterThan(60);
    expect(debugRebasePreview(longest)?.kind).toBe(ComputedAction.Clean);
  });

  it("returns nothing for a branch outside the stub set", () => {
    expect(debugRebasePreview("some-real-branch")).toBeNull();
  });
});
