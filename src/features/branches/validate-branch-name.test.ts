import { describe, expect, it } from "vitest";
import { validateBranchName } from "./validate-branch-name";

const options = { currentName: "feature/old", existingNames: ["main", "develop"] };

describe("validateBranchName", () => {
  it("treats empty and unchanged as neither valid nor an error", () => {
    // Both block the confirm button, but neither deserves a message: the user is mid-edit, or has
    // simply not changed anything yet. Shouting at them for it would be noise.
    expect(validateBranchName("", options).kind).toBe("empty");
    expect(validateBranchName("   ", options).kind).toBe("empty");
    expect(validateBranchName("feature/old", options).kind).toBe("unchanged");
  });

  it("accepts an ordinary branch name", () => {
    expect(validateBranchName("feature/new-thing", options).kind).toBe("valid");
    expect(validateBranchName("release/v2.0.0", options).kind).toBe("valid");
  });

  it("names the specific rule rather than saying the name is invalid", () => {
    // "Invalid branch name" leaves the user guessing which character to remove.
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ["my new branch", /spaces/i],
      ["a..b", /consecutive dots/i],
      [".hidden", /start or end with a dot/i],
      ["trailing.", /start or end with a dot/i],
      ["thing.lock", /\.lock/i],
      ["/leading", /“\/”/],
      ["double//slash", /“\/”/],
      ["at@{brace}", /@\{/],
      ["car^et", /~ \^ : \? \* \[/],
      ["ti~lde", /~ \^ : \? \* \[/],
      ["question?", /~ \^ : \? \* \[/],
    ];
    for (const [name, expected] of cases) {
      const result = validateBranchName(name, options);
      expect(result.kind, `${name} should be invalid`).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message, `message for ${name}`).toMatch(expected);
      }
    }
  });

  it("catches a name already taken before git does", () => {
    const result = validateBranchName("develop", options);

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.message).toContain("develop");
      expect(result.message).toMatch(/already exists/i);
    }
  });

  it("does not treat the branch's own name as a collision", () => {
    // The caller filters the current name out, but a name differing only by case or surrounding
    // space must still resolve through `unchanged` rather than reporting a collision.
    expect(validateBranchName("  feature/old  ", options).kind).toBe("unchanged");
  });
});
