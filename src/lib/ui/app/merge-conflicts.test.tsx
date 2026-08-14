import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ConflictState, ConflictStore } from "../../stores/conflict-store";
import { MergeConflicts } from "./merge-conflicts";

const state: ConflictState = {
  repositoryPath: "/repo",
  mergeInProgress: false,
  files: [],
  loading: false,
  error: null,
  stagingPath: null,
  operationError: null,
};

const store = { load: vi.fn() } as unknown as ConflictStore;

describe("MergeConflicts recovery presentation", () => {
  it("offers Cherry-pick continuation and abort after resolutions are staged", () => {
    const onContinue = vi.fn();
    const onAbort = vi.fn();
    render(
      <MergeConflicts
        repositoryPath="/repo"
        state={state}
        store={store}
        onStageResolved={vi.fn()}
        recoveryOperation="cherryPick"
        onContinueRecovery={onContinue}
        onAbortRecovery={onAbort}
      />,
    );

    expect(screen.getByRole("region", { name: "Cherry-pick recovery" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue cherry-pick" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort cherry-pick" }));

    expect(onContinue).toHaveBeenCalledOnce();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("offers only abort for Revert recovery", () => {
    render(
      <MergeConflicts
        repositoryPath="/repo"
        state={state}
        store={store}
        onStageResolved={vi.fn()}
        recoveryOperation="revert"
        onAbortRecovery={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Revert recovery" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue cherry-pick" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abort revert" })).toBeInTheDocument();
  });
});
