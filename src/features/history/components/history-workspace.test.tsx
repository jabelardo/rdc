import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Commit } from "@/models/commit";
import type { HistoryState, HistoryStore } from "@/features/history/stores/history-store";
import { HistoryWorkspace } from "./history-workspace";

const commit = (sha: string) =>
  new Commit(
    sha,
    sha,
    `Commit ${sha}`,
    "",
    { name: "Author", email: "author@example.com", date: new Date(0), tzOffset: 0 },
    { name: "Committer", email: "committer@example.com", date: new Date(0), tzOffset: 0 },
    [],
    [],
    [],
  );

const commits = [commit("a"), commit("b"), commit("c")];
const state: HistoryState = {
  repositoryPath: "/repo",
  commits,
  selectedCommitSHA: null,
  changeset: null,
  selectedFileID: null,
  loading: false,
  loadFailed: false,
  detailsLoading: false,
  diff: null,
  diffLoading: false,
  diffFailed: false,
};
const store = { selectCommit: vi.fn(), selectFile: vi.fn() } as unknown as HistoryStore;

describe("HistoryWorkspace interactive operations", () => {
  it("selects commits and exposes keyboard-accessible squash/reorder actions", () => {
    const onSquashSelected = vi.fn();
    const onReorderSelected = vi.fn();
    render(
      <HistoryWorkspace
        visible
        state={state}
        store={store}
        onSquashSelected={onSquashSelected}
        onReorderSelected={onReorderSelected}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Commit a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Commit b" }));
    expect(screen.getByRole("button", { name: "Squash selected" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Squash selected" }));
    expect(onSquashSelected).toHaveBeenCalledWith([commits[0], commits[1]]);

    fireEvent.change(screen.getByRole("combobox", { name: "Move selected before" }), {
      target: { value: "c" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reorder selected" }));
    expect(onReorderSelected).toHaveBeenCalledWith([commits[0], commits[1]], commits[2]);
  });

  it("rejects non-contiguous squash and supports reordering to the end", () => {
    const onSquashSelected = vi.fn();
    const onReorderSelected = vi.fn();
    render(
      <HistoryWorkspace
        visible
        state={state}
        store={store}
        onSquashSelected={onSquashSelected}
        onReorderSelected={onReorderSelected}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Commit a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Commit c" }));
    expect(screen.getByRole("button", { name: "Squash selected" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reorder selected" }));
    expect(onReorderSelected).toHaveBeenCalledWith([commits[0], commits[2]], null);
    expect(onSquashSelected).not.toHaveBeenCalled();
  });
});
