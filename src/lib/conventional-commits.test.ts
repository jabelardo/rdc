import { describe, it } from "vitest";
import assert from "node:assert";
import { parseConventionalCommit } from "./conventional-commits";

describe("parseConventionalCommit", () => {
  it("parses a simple type", () => {
    const parsed = parseConventionalCommit("feat: add a new button");
    assert.deepStrictEqual(parsed, {
      rawType: "feat",
      label: "Feat",
      scope: null,
      leftSideText: "",
      rightSideText: "add a new button",
    });
  });

  it("parses a type with a scope", () => {
    const parsed = parseConventionalCommit("fix(parser): handle empty input");
    assert.deepStrictEqual(parsed, {
      rawType: "fix",
      label: "Fix",
      scope: "parser",
      leftSideText: "",
      rightSideText: "handle empty input",
    });
  });

  it("marks breaking changes with a trailing exclamation mark", () => {
    assert.strictEqual(parseConventionalCommit("feat!: drop node 16")?.label, "Feat!");
    assert.strictEqual(
      parseConventionalCommit("refactor(api)!: rename method")?.label,
      "Refactor!",
    );
  });

  it("maps every recognised type to its label", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["feat", "Feat"],
      ["fix", "Fix"],
      ["fixes", "Fixes"],
      ["hotfix", "Hotfix"],
      ["chore", "Chore"],
      ["revert", "Revert"],
      ["style", "Style"],
      ["spelling", "Spelling"],
      ["docs", "Docs"],
      ["doc", "Doc"],
      ["build", "Build"],
      ["refactor", "Refactor"],
      ["test", "Test"],
      ["ci", "CI"],
      ["perf", "Perf"],
      ["deps", "Deps"],
      ["security", "Security"],
      ["release", "Release"],
      ["temp", "Temp"],
      ["wip", "WIP"],
      ["config", "Config"],
      ["infra", "Infra"],
      ["ops", "Ops"],
      ["ui", "UI"],
      ["ux", "UX"],
      ["design", "Design"],
    ];

    for (const [type, label] of cases) {
      const parsed = parseConventionalCommit(`${type}: do the thing`);
      assert.strictEqual(parsed?.rawType, type);
      assert.strictEqual(parsed?.label, label);
    }
  });

  it("tolerates extra whitespace after the colon", () => {
    assert.strictEqual(
      parseConventionalCommit("docs:    update readme")?.rightSideText,
      "update readme",
    );
  });

  it("tolerates leading whitespace before the type", () => {
    assert.deepStrictEqual(parseConventionalCommit(" fix: cache languages"), {
      rawType: "fix",
      label: "Fix",
      scope: null,
      leftSideText: "",
      rightSideText: "cache languages",
    });
    assert.strictEqual(parseConventionalCommit("\tfeat: add thing")?.label, "Feat");
  });

  it("parses unrecognised types using the raw type as the label", () => {
    assert.deepStrictEqual(parseConventionalCommit("note: heads up"), {
      rawType: "note",
      label: "note",
      scope: null,
      leftSideText: "",
      rightSideText: "heads up",
    });
    assert.deepStrictEqual(parseConventionalCommit("abcde: a thing"), {
      rawType: "abcde",
      label: "abcde",
      scope: null,
      leftSideText: "",
      rightSideText: "a thing",
    });
  });

  it("matches the type case-insensitively, normalising rawType to lower case", () => {
    assert.deepStrictEqual(parseConventionalCommit("Feat: capitalized"), {
      rawType: "feat",
      label: "Feat",
      scope: null,
      leftSideText: "",
      rightSideText: "capitalized",
    });
    assert.deepStrictEqual(parseConventionalCommit("FIX(API)!: shouting"), {
      rawType: "fix",
      label: "Fix!",
      scope: "API",
      leftSideText: "",
      rightSideText: "shouting",
    });
  });

  it("badges the conventional commit nested after a Merge prefix", () => {
    assert.deepStrictEqual(
      parseConventionalCommit("Merge test(abc): isolate the verification flow"),
      {
        rawType: "test",
        label: "Test",
        scope: "abc",
        leftSideText: "Merge ",
        rightSideText: "isolate the verification flow",
      },
    );
  });

  it("keeps the Revert prefix and opening quote as left side text", () => {
    assert.deepStrictEqual(parseConventionalCommit('Revert "feat: a thing"'), {
      rawType: "feat",
      label: "Feat",
      scope: null,
      leftSideText: 'Revert "',
      rightSideText: 'a thing"',
    });
  });

  it("badges the conventional commit nested after a quoted Reapply prefix", () => {
    assert.deepStrictEqual(
      parseConventionalCommit('Reapply " fix: don\'t cache empty commerce languages"'),
      {
        rawType: "fix",
        label: "Fix",
        scope: null,
        leftSideText: 'Reapply "',
        rightSideText: "don't cache empty commerce languages\"",
      },
    );
  });

  it("keeps an autosquash prefix as left side text and badges the nested type", () => {
    assert.deepStrictEqual(parseConventionalCommit("fixup! fix(parser): handle empty input"), {
      rawType: "fix",
      label: "Fix",
      scope: "parser",
      leftSideText: "fixup! ",
      rightSideText: "handle empty input",
    });
    assert.deepStrictEqual(parseConventionalCommit("squash! feat(ui): add keyboard shortcut"), {
      rawType: "feat",
      label: "Feat",
      scope: "ui",
      leftSideText: "squash! ",
      rightSideText: "add keyboard shortcut",
    });
    assert.deepStrictEqual(
      parseConventionalCommit("amend! refactor(list): simplify row rendering"),
      {
        rawType: "refactor",
        label: "Refactor",
        scope: "list",
        leftSideText: "amend! ",
        rightSideText: "simplify row rendering",
      },
    );
  });

  it("keeps chained autosquash prefixes as left side text", () => {
    assert.deepStrictEqual(
      parseConventionalCommit("fixup! squash! fix(parser): handle empty input"),
      {
        rawType: "fix",
        label: "Fix",
        scope: "parser",
        leftSideText: "fixup! squash! ",
        rightSideText: "handle empty input",
      },
    );
  });

  it("combines an autosquash prefix with a revert wrapper", () => {
    assert.deepStrictEqual(parseConventionalCommit('fixup! Revert "feat: a thing"'), {
      rawType: "feat",
      label: "Feat",
      scope: null,
      leftSideText: 'fixup! Revert "',
      rightSideText: 'a thing"',
    });
  });

  it("does not badge autosquash commits without a nested type", () => {
    assert.strictEqual(parseConventionalCommit("fixup! update readme"), null);
    assert.strictEqual(parseConventionalCommit("squash! just a normal commit"), null);
  });

  it("does not badge Merge/Revert/Reapply commits without a nested type", () => {
    assert.strictEqual(parseConventionalCommit("Merge branch 'main'"), null);
    assert.strictEqual(parseConventionalCommit('Revert "an unconventional commit"'), null);
  });

  it("returns null for non-conventional summaries", () => {
    assert.strictEqual(parseConventionalCommit("just a normal commit"), null);
    assert.strictEqual(parseConventionalCommit(""), null);
    assert.strictEqual(parseConventionalCommit("feat add button"), null);
  });
});
