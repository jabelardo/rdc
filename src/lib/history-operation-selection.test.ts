import { describe, expect, it } from "vitest";
import { Commit } from "../models/commit";
import { isContiguousSelection, orderSelectedCommits } from "./history-operation-selection";

const commit = (sha: string): Commit =>
  new Commit(
    sha,
    sha.slice(0, 7),
    sha,
    "",
    { name: "Author", email: "author@example.com", date: new Date(0), tzOffset: 0 },
    { name: "Committer", email: "committer@example.com", date: new Date(0), tzOffset: 0 },
    [],
    [],
    [],
  );

const history = [commit("a"), commit("b"), commit("c"), commit("d")];

describe("history operation selection", () => {
  it("orders selected commits by the displayed history", () => {
    expect(orderSelectedCommits(history, [history[2], history[0]])).toEqual([history[0], history[2]]);
  });

  it("accepts only contiguous squash ranges", () => {
    expect(isContiguousSelection(history, [history[1], history[2]])).toBe(true);
    expect(isContiguousSelection(history, [history[0], history[2]])).toBe(false);
    expect(isContiguousSelection(history, [history[1]])).toBe(false);
  });
});
