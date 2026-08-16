import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiffType } from "@/models/diff/diff-data";
import { DiffLineType } from "@/models/diff/diff-line";
import { Image } from "@/models/diff/image";
import { DiffHunk, DiffHunkExpansionType, DiffHunkHeader } from "@/models/diff/raw-diff";
import {
  getHunkHeaderExpansionType,
  getLargestLineNumber,
  HiddenBidiCharsRegex,
} from "@/lib/diff/diff-hunks";
import { IndexStatus } from "@/models/index-status";
import {
  dehydrateTextDiff,
  discardChangesFromSelection,
  hydrateDiff,
  hydrateRawDiff,
  type IDiffWire,
  type IRawDiffData,
  getBranchMergeBaseDiff,
  getBranchMergeBaseChangedFiles,
  getCommitRangeChangedFiles,
} from "./diff-ipc";
import { AppFileStatusKind, CommittedFileChange } from "@/models/status";
import type { IChangesetDataWire } from "@/lib/ipc/log-ipc";
import snapshot from "@/lib/__generated__/wire-snapshot.json";

const REPO = "/tmp/repo";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/**
 * Checks the diff boundary, and pins the one place logic is deliberately implemented twice.
 *
 * `diff_parser.rs` computes `expansionType` and `maxLineNumber` while parsing; `src/lib/diff-hunks.ts`
 * keeps the same rules because Phase 7's `ui/diff/text-diff-expansion.ts` re-applies them after the
 * user expands a hunk, on content that never passed through the Rust parser. Two implementations of
 * one rule is exactly the setup that produced the conflict-shape bug, so rather than trust them to
 * agree, the tests below run the TypeScript versions over Rust's own output and compare.
 */

// `parsedDiff` is emitted by the Rust parser into the snapshot; casting it to the wire type is the
// only place a cast is appropriate, because the JSON import infers widened types (`number` for the
// numeric enum) and this is the boundary being described.
const parsedDiff = snapshot.parsedDiff as IRawDiffData;

// A JSON import widens tuples to arrays — `(string | number)[][]` here — so this needs the
// two-step cast the compiler asks for. The runtime assertions below are what actually check the
// shape; the type only makes the assertions expressible.
const indexChanges = snapshot.indexChanges as unknown as ReadonlyArray<
  readonly [string, IndexStatus]
>;

describe("the diff wire shape", () => {
  it("hydrates into the ported models/diff classes", () => {
    // If this compiles and runs, the Rust payload can build the real domain objects — which is the
    // check, since the classes have methods and so plain JSON is not assignable to them.
    const diff = hydrateRawDiff(parsedDiff);

    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]).toBeInstanceOf(DiffHunk);
    expect(diff.hunks[0].header).toBeInstanceOf(DiffHunkHeader);
    expect(diff.isBinary).toBe(false);
  });

  it("gives hydrated objects working behaviour, not just fields", () => {
    const diff = hydrateRawDiff(parsedDiff);
    const [hunk] = diff.hunks;

    // `content` strips the diff prefix — a getter, so it only exists after hydration.
    const added = hunk.lines.find((line) => line.type === DiffLineType.Add);
    expect(added?.text).toBe("+after");
    expect(added?.content).toBe("after");
    expect(added?.isIncludeableLine()).toBe(true);

    const context = hunk.lines.find((line) => line.type === DiffLineType.Context);
    expect(context?.isIncludeableLine()).toBe(false);

    expect(hunk.header.toDiffLineRepresentation()).toBe("@@ -10,2 +10,2 @@");
    expect(hunk.equals(hunk)).toBe(true);
    expect(hunk.equals(diff.hunks[1])).toBe(false);
  });

  it("carries the numeric DiffLineType across as integers", () => {
    // A *numeric* TypeScript enum, unlike the string enums in models/status.ts. Rust serializes the
    // discriminant, so a switch to variant names would silently produce NaN-ish line types here.
    const [hunk] = parsedDiff.hunks;
    expect(hunk.lines[0].type).toBe(DiffLineType.Hunk);
    expect(hunk.lines[1].type).toBe(DiffLineType.Context);
    expect(hunk.lines[2].type).toBe(DiffLineType.Delete);
    expect(hunk.lines[3].type).toBe(DiffLineType.Add);
    expect(DiffLineType.Hunk).toBe(3);
  });

  it("sends explicit nulls rather than omitting line numbers", () => {
    // The opposite of the status types: these are `number | null`, not optional, so the properties
    // must be present. `undefined` would break `?? 0` fallbacks differently from `null`.
    const line = parsedDiff.hunks[0].lines[0];
    expect("oldLineNumber" in line).toBe(true);
    expect("newLineNumber" in line).toBe(true);
    expect(line.oldLineNumber).toBeNull();
    expect(line.newLineNumber).toBeNull();
  });

  it("does not count the no-newline marker as a line", () => {
    // The marker describes the previous line. Counting it would misnumber everything after a file
    // whose last line lacks a newline.
    const second = parsedDiff.hunks[1];
    const marked = second.lines.find((line) => line.noTrailingNewLine);

    expect(marked?.text).toBe("-last");
    expect(second.lines.some((line) => line.text.startsWith("\\"))).toBe(false);
    expect(parsedDiff.contents).not.toContain("No newline");
  });

  // --- the duplicated rules, pinned against Rust's own output ---

  it("agrees with Rust on every hunk expansion type", () => {
    const diff = hydrateRawDiff(parsedDiff);

    diff.hunks.forEach((hunk, index) => {
      const previous = index === 0 ? null : diff.hunks[index - 1];
      expect(getHunkHeaderExpansionType(index, hunk.header, previous), `hunk ${index}`).toBe(
        hunk.expansionType,
      );
    });

    // Guard the guard: if the fixture had only one shape, the loop above would pass vacuously.
    expect(diff.hunks.map((h) => h.expansionType)).toEqual([
      DiffHunkExpansionType.Up,
      DiffHunkExpansionType.Both,
    ]);
  });

  it("agrees with Rust on the largest line number", () => {
    const diff = hydrateRawDiff(parsedDiff);
    expect(getLargestLineNumber([...diff.hunks])).toBe(diff.maxLineNumber);
    expect(diff.maxLineNumber).toBeGreaterThan(0);
  });

  it("agrees with Rust that the fixture has no hidden bidi characters", () => {
    expect(HiddenBidiCharsRegex.test(parsedDiff.contents)).toBe(parsedDiff.hasHiddenBidiChars);
  });

  it("still detects hidden bidi characters when they are present", () => {
    // Proves the previous assertion isn't passing because the regex matches nothing at all.
    expect(HiddenBidiCharsRegex.test("sneaky\u202Ereversed")).toBe(true);
  });
});

describe("DiffHunkHeader.equals", () => {
  it("compares newLineCount", () => {
    // UPSTREAM BUG: the original compared oldStartLine twice and never looked at newLineCount, so
    // these two headers — differing only in how many lines they cover on the new side — were equal.
    const a = new DiffHunkHeader(1, 2, 3, 4);
    const b = new DiffHunkHeader(1, 2, 3, 99);

    expect(a.equals(b)).toBe(false);
    expect(a.equals(new DiffHunkHeader(1, 2, 3, 4))).toBe(true);
  });

  it("compares the other three fields too", () => {
    const a = new DiffHunkHeader(1, 2, 3, 4);
    expect(a.equals(new DiffHunkHeader(9, 2, 3, 4))).toBe(false);
    expect(a.equals(new DiffHunkHeader(1, 9, 3, 4))).toBe(false);
    expect(a.equals(new DiffHunkHeader(1, 2, 9, 4))).toBe(false);
  });
});

describe("index changes", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("sends the status as a numeric discriminant", () => {
    // IndexStatus is a *numeric* TypeScript enum, so the wire value is the number. Switching Rust to
    // variant names would leave every comparison against IndexStatus.* false.
    expect(snapshot.indexChanges).toEqual([
      ["src/thing.ts", IndexStatus.Modified],
      ["added.ts", IndexStatus.Added],
      ["gone.ts", IndexStatus.Deleted],
    ]);
    expect(IndexStatus.Modified).toBe(4);
  });

  it("arrives as pairs, so a path can be any string", () => {
    // Not a record: a repository path is arbitrary, including names that collide with
    // Object.prototype members.
    const changes = snapshot.indexChanges;
    expect(Array.isArray(changes)).toBe(true);
    expect(changes.every((entry) => Array.isArray(entry) && entry.length === 2)).toBe(true);
  });

  it("builds a usable Map, which is what callers wanting lookup should do", () => {
    const changes = new Map(indexChanges);
    expect(changes.get("src/thing.ts")).toBe(IndexStatus.Modified);
    expect(changes.get("nope")).toBeUndefined();
  });

  it("getIndexChanges sends only the repository path", async () => {
    invoke.mockResolvedValue([]);
    const { getIndexChanges } = await import("./diff-ipc");

    await getIndexChanges("/tmp/repo");

    expect(invoke).toHaveBeenCalledWith("get_index_changes", {
      repositoryPath: "/tmp/repo",
    });
  });
});

describe("the IDiff union", () => {
  // Each of these is emitted by the Rust serializer into the snapshot.
  const textDiff = snapshot.textDiff as IDiffWire;
  const largeTextDiff = snapshot.largeTextDiff as IDiffWire;
  const binaryDiff = snapshot.binaryDiff as IDiffWire;
  const unrenderableDiff = snapshot.unrenderableDiff as IDiffWire;
  const submoduleDiff = snapshot.submoduleDiff as IDiffWire;
  const withLineEndings = snapshot.textDiffWithLineEndingsChange as IDiffWire;

  it("discriminates on a numeric kind", () => {
    // DiffType is a numeric TypeScript enum, so these are numbers on the wire. The values also have
    // to be distinct per variant — Text and LargeText are structurally identical otherwise.
    expect(textDiff.kind).toBe(DiffType.Text);
    expect(largeTextDiff.kind).toBe(DiffType.LargeText);
    expect(binaryDiff.kind).toBe(DiffType.Binary);
    expect(submoduleDiff.kind).toBe(DiffType.Submodule);
    expect(unrenderableDiff.kind).toBe(DiffType.Unrenderable);

    expect(DiffType.Text).toBe(0);
    expect(DiffType.LargeText).toBe(4);
  });

  it("hydrates a text diff, building the hunk classes", () => {
    const diff = hydrateDiff(textDiff);

    expect(diff.kind).toBe(DiffType.Text);
    if (diff.kind !== DiffType.Text) {
      throw new Error("narrowing failed");
    }
    expect(diff.hunks[0]).toBeInstanceOf(DiffHunk);
    expect(diff.hunks[0].header).toBeInstanceOf(DiffHunkHeader);
    expect(diff.maxLineNumber).toBe(1);
    expect(diff.hasHiddenBidiChars).toBe(false);
  });

  it("keeps a large text diff renderable, carrying text and hunks", () => {
    // The whole point of LargeText: the UI can still offer to render it.
    const diff = hydrateDiff(largeTextDiff);
    if (diff.kind !== DiffType.LargeText) {
      throw new Error("narrowing failed");
    }
    expect(diff.hunks.length).toBeGreaterThan(0);
    expect(diff.text).not.toBe("");
  });

  it("omits lineEndingsChange when there is none, and carries it when there is", () => {
    // An optional property, so absent rather than null.
    expect("lineEndingsChange" in textDiff).toBe(false);

    if (withLineEndings.kind !== DiffType.Text) {
      throw new Error("narrowing failed");
    }
    expect(withLineEndings.lineEndingsChange).toEqual({
      from: "LF",
      to: "CRLF",
    });
  });

  it("hydrates the kinds that carry no payload", () => {
    expect(hydrateDiff(binaryDiff)).toEqual({ kind: DiffType.Binary });
    expect(hydrateDiff(unrenderableDiff)).toEqual({
      kind: DiffType.Unrenderable,
    });
  });

  it("hydrates a submodule diff, keeping the SHA field spellings", () => {
    // oldSHA/newSHA are spelled that way in the domain type, so a camelCase rename would leave both
    // undefined and make every submodule look unchanged.
    const diff = hydrateDiff(submoduleDiff);
    if (diff.kind !== DiffType.Submodule) {
      throw new Error("narrowing failed");
    }

    expect(diff.path).toBe("sub");
    expect(diff.url).toBe("https://example.invalid/sub.git");
    expect(diff.status.commitChanged).toBe(true);
    expect(diff.oldSHA).toHaveLength(40);
    expect(diff.newSHA).toHaveLength(40);
    expect(diff.oldSHA).not.toBe(diff.newSHA);
  });

  it("sends null rather than omitting a submodule url", () => {
    // `url` is `string | null` on the domain type, not optional.
    expect("url" in submoduleDiff).toBe(true);
  });
});

describe("sending a diff back for a partial discard", () => {
  const textDiff = snapshot.textDiff as IDiffWire;

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("dehydration reverses hydration exactly", () => {
    // The two directions have to agree byte for byte, because Rust re-reads what it sent. Comparing
    // against Rust's own snapshot output — not against a hand-written fixture — is what makes this a
    // check of the boundary rather than of my transcription.
    if (textDiff.kind !== DiffType.Text) {
      throw new Error("the snapshot fixture should be a text diff");
    }
    const hydrated = hydrateDiff(textDiff);
    if (hydrated.kind !== DiffType.Text) {
      throw new Error("narrowing failed");
    }

    const { kind, ...wire } = textDiff;
    expect(dehydrateTextDiff(hydrated)).toEqual(wire);
    expect(kind).toBe(DiffType.Text);
  });

  it("keeps the hunk classes out of the payload", () => {
    // A structured clone of a DiffHunk would carry its prototype's shape along; dehydration returns
    // plain data, which is what serde deserializes into.
    if (textDiff.kind !== DiffType.Text) {
      throw new Error("the snapshot fixture should be a text diff");
    }
    const hydrated = hydrateDiff(textDiff);
    if (hydrated.kind !== DiffType.Text) {
      throw new Error("narrowing failed");
    }

    expect(hydrated.hunks[0]).toBeInstanceOf(DiffHunk);
    expect(dehydrateTextDiff(hydrated).hunks[0]).not.toBeInstanceOf(DiffHunk);
  });

  it("sends the diff alongside the selected line indices", async () => {
    if (textDiff.kind !== DiffType.Text) {
      throw new Error("the snapshot fixture should be a text diff");
    }
    const hydrated = hydrateDiff(textDiff);
    if (hydrated.kind !== DiffType.Text) {
      throw new Error("narrowing failed");
    }

    await discardChangesFromSelection("/tmp/repo", "a.txt", hydrated, [4, 5]);

    const { kind, ...wire } = textDiff;
    expect(invoke).toHaveBeenCalledWith("discard_changes_from_selection", {
      repositoryPath: "/tmp/repo",
      filePath: "a.txt",
      diff: wire,
      selectedLines: [4, 5],
    });
    expect(kind).toBe(DiffType.Text);
  });
});

describe("image diffs", () => {
  const imageDiff = snapshot.imageDiff as IDiffWire;
  const addedImageDiff = snapshot.addedImageDiff as IDiffWire;
  const svgImageDiff = snapshot.svgImageDiff as IDiffWire;

  it("hydrates both sides into the Image class", () => {
    const diff = hydrateDiff(imageDiff);
    if (diff.kind !== DiffType.Image) {
      throw new Error("narrowing failed");
    }

    expect(diff.previous).toBeInstanceOf(Image);
    expect(diff.current).toBeInstanceOf(Image);
    expect(diff.previous?.mediaType).toBe("image/png");
    expect(diff.current?.bytes).toBe(4096);
  });

  it("carries a URL rather than the bytes", () => {
    // The reason for the protocol: a 4 MB PNG would otherwise be ~5.5 MB of JSON, copied twice, held for as
    // long as the diff is open. `<img src>` fetches this instead.
    const diff = hydrateDiff(imageDiff);
    if (diff.kind !== DiffType.Image) {
      throw new Error("narrowing failed");
    }

    expect(diff.current?.url).toMatch(/^rdc-blob:/);
    // Nothing in the payload should look like base64 image data.
    expect(JSON.stringify(imageDiff)).not.toContain("base64");
  });

  it("leaves an absent side absent rather than empty", () => {
    // An added image has no previous version, and an empty Image would make the viewer render a broken one.
    expect("previous" in addedImageDiff).toBe(false);

    const diff = hydrateDiff(addedImageDiff);
    if (diff.kind !== DiffType.Image) {
      throw new Error("narrowing failed");
    }
    expect(diff.previous).toBeUndefined();
    expect(diff.current).toBeInstanceOf(Image);
  });

  it("gives an SVG both a picture and a text diff", () => {
    // An SVG is text that can also be rendered, so the viewer offers both — upstream's behaviour, and
    // nothing is lost by keeping it.
    const diff = hydrateDiff(svgImageDiff);
    if (diff.kind !== DiffType.Image) {
      throw new Error("narrowing failed");
    }

    expect(diff.current?.mediaType).toBe("image/svg+xml");
    expect(diff.textDiff?.text).toContain("<svg/>");
  });

  it("uses the numeric DiffType the ported enum declares", () => {
    expect(snapshot.imageDiff.kind).toBe(DiffType.Image);
    expect(DiffType.Image).toBe(1);
  });
});

describe("comparing branches and ranges", () => {
  const changeset = snapshot.changesetData as IChangesetDataWire;

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(changeset);
  });

  it("getBranchMergeBaseDiff names both branches and the commit it labels the result with", async () => {
    invoke.mockResolvedValue(snapshot.textDiff);

    await getBranchMergeBaseDiff(
      REPO,
      "a.txt",
      // The enum member, not the string: TypeScript string enums are nominal, which is the property that
      // makes these fixtures a real check rather than a restatement.
      { kind: AppFileStatusKind.Modified },
      "main",
      "topic",
      "abc123",
    );

    expect(invoke).toHaveBeenCalledWith("get_branch_merge_base_diff", {
      repositoryPath: REPO,
      path: "a.txt",
      status: { kind: AppFileStatusKind.Modified },
      baseBranch: "main",
      comparisonBranch: "topic",
      latestCommit: "abc123",
      hideWhitespace: false,
    });
  });

  it("getBranchMergeBaseChangedFiles hydrates the changeset", async () => {
    const files = await getBranchMergeBaseChangedFiles(REPO, "main", "topic", "abc123");

    expect(files?.files[0]).toBeInstanceOf(CommittedFileChange);
    expect(files?.linesAdded).toBe(changeset.linesAdded);
  });

  it("getBranchMergeBaseChangedFiles passes null through for unrelated histories", async () => {
    // No common ancestor is a real state — there is no point to compare from — so it must not look like a
    // failure or like an empty changeset.
    invoke.mockResolvedValue(null);

    await expect(
      getBranchMergeBaseChangedFiles(REPO, "main", "unrelated", "abc123"),
    ).resolves.toBeNull();
  });

  it("getCommitRangeChangedFiles sends the shas oldest first", async () => {
    await getCommitRangeChangedFiles(REPO, ["oldest", "newest"]);

    expect(invoke).toHaveBeenCalledWith("get_commit_range_changed_files", {
      repositoryPath: REPO,
      shas: ["oldest", "newest"],
    });
  });
});
