import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscardFileList, discardAllQuestion } from "./discard-file-list";

const pathsFor = (count: number) =>
  Array.from({ length: count }, (_unused, index) => `src/file-${index}.ts`);

describe("discardAllQuestion", () => {
  it("states the file count at every scale", () => {
    // The count is the one fact conveying how much is about to be lost, so no phrasing omits it.
    for (const count of [1, 2, 10, 100, 5_000]) {
      expect(discardAllQuestion(count)).toMatch(new RegExp(`\\b${count}\\b`));
    }
  });

  it("reads correctly for a single file", () => {
    expect(discardAllQuestion(1)).toBe(
      "Are you sure you want to discard all changes to this 1 file:",
    );
  });

  it("reads correctly for many files", () => {
    expect(discardAllQuestion(100)).toBe(
      "Are you sure you want to discard all changes to these 100 files:",
    );
  });
});

describe("DiscardFileList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists paths with no cap, so a large discard still says which files it covers", () => {
    // The earlier version listed ten and then showed a count alone, which told you nothing about
    // which files a hundred-file discard covered — the point at which you most want to check.
    render(<DiscardFileList paths={pathsFor(40)} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    expect(screen.getByText("src/file-39.ts")).toBeInTheDocument();
  });

  it("windows the DOM once the list is large, keeping the region bounded", () => {
    // jsdom performs no layout, so the virtualizer sees a zero-height viewport and renders nothing.
    // Same measurement stubs as virtual-list.test.tsx, for the same reason.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 240,
      height: 240,
      left: 0,
      right: 480,
      top: 0,
      width: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    render(<DiscardFileList paths={pathsFor(2_000)} />);

    // A viewport's worth of rows in the DOM, not 2,000 — the whole point of not capping the list.
    const rendered = screen.getAllByRole("listitem").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(2_000);
    expect(screen.getByRole("list", { name: "Files to discard" })).toBeInTheDocument();
  });

  it("renders nothing when there is nothing to discard", () => {
    render(<DiscardFileList paths={[]} />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
