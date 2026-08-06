import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiscardFileList, discardAllQuestion, MaxFilesToList } from "./discard-file-list";

const pathsFor = (count: number) =>
  Array.from({ length: count }, (_unused, index) => `src/file-${index}.ts`);

describe("discardAllQuestion", () => {
  it("states the file count in every form of the question", () => {
    // The count is the one fact conveying how much is about to be lost, so no phrasing omits it —
    // including the listed form, where counting the list yourself is not the same thing.
    for (const count of [1, 2, MaxFilesToList, MaxFilesToList + 1, 5_000]) {
      expect(discardAllQuestion(count)).toMatch(new RegExp(`\\b${count}\\b`));
    }
  });

  it("lists up to the cap and states a bare count past it", () => {
    expect(discardAllQuestion(MaxFilesToList)).toBe(
      `Are you sure you want to discard all changes to these ${MaxFilesToList} files:`,
    );
    expect(discardAllQuestion(MaxFilesToList + 1)).toBe(
      `Are you sure you want to discard all changes to ${MaxFilesToList + 1} changed files?`,
    );
  });

  it("reads correctly for a single file", () => {
    expect(discardAllQuestion(1)).toBe(
      "Are you sure you want to discard all changes to this 1 file:",
    );
  });
});

describe("DiscardFileList", () => {
  it("renders every path up to the cap", () => {
    render(<DiscardFileList paths={pathsFor(MaxFilesToList)} fileCount={MaxFilesToList} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(MaxFilesToList);
  });

  it("renders nothing past the cap, where the question carries the count instead", () => {
    render(<DiscardFileList paths={pathsFor(MaxFilesToList)} fileCount={5_000} />);

    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
