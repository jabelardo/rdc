import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ConflictState, ConflictStore } from "../../stores/conflict-store";
import { AppFileStatusKind, GitStatusEntry, UnmergedEntrySummary } from "../../../models/status";
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
    const conflictedState: ConflictState = {
      ...state,
      files: [
        {
          path: "conflicted.txt",
          status: {
            kind: AppFileStatusKind.Conflicted,
            entry: {
              kind: "conflicted",
              action: UnmergedEntrySummary.BothModified,
              us: GitStatusEntry.UpdatedButUnmerged,
              them: GitStatusEntry.UpdatedButUnmerged,
            },
            conflictMarkerCount: 0,
          },
          resolvedInWorkingTree: true,
        },
      ],
    };
    render(
      <MergeConflicts
        repositoryPath="/repo"
        state={conflictedState}
        store={store}
        onStageResolved={vi.fn()}
        recoveryOperation="revert"
        onAbortRecovery={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Revert recovery" })).toBeInTheDocument();
    expect(screen.getByText(/Revert can only be aborted from here/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stage resolution for conflicted.txt" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue cherry-pick" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abort revert" })).toBeInTheDocument();
  });

  it("keeps Cherry-pick continuation disabled until every resolved file is staged", () => {
    const onContinue = vi.fn();
    const onStageResolved = vi.fn();
    const unresolvedState: ConflictState = {
      ...state,
      files: [
        {
          path: "conflicted.txt",
          status: {
            kind: AppFileStatusKind.Conflicted,
            entry: {
              kind: "conflicted",
              action: UnmergedEntrySummary.BothModified,
              us: GitStatusEntry.UpdatedButUnmerged,
              them: GitStatusEntry.UpdatedButUnmerged,
            },
            conflictMarkerCount: 1,
          },
          resolvedInWorkingTree: false,
        },
      ],
    };
    const view = render(
      <MergeConflicts
        repositoryPath="/repo"
        state={unresolvedState}
        store={store}
        onStageResolved={onStageResolved}
        recoveryOperation="cherryPick"
        onContinueRecovery={onContinue}
      />,
    );

    expect(screen.getByRole("button", { name: "Continue cherry-pick" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Stage resolution for conflicted.txt" }),
    ).toBeDisabled();

    view.rerender(
      <MergeConflicts
        repositoryPath="/repo"
        state={{
          ...unresolvedState,
          files: [{ ...unresolvedState.files[0], resolvedInWorkingTree: true }],
        }}
        store={store}
        onStageResolved={onStageResolved}
        recoveryOperation="cherryPick"
        onContinueRecovery={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stage resolution for conflicted.txt" }));
    expect(onStageResolved).toHaveBeenCalledWith("conflicted.txt");

    view.rerender(
      <MergeConflicts
        repositoryPath="/repo"
        state={{ ...unresolvedState, files: [] }}
        store={store}
        onStageResolved={onStageResolved}
        recoveryOperation="cherryPick"
        onContinueRecovery={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue cherry-pick" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
