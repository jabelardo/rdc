import { describe, expect, it, vi } from "vitest";
import { AppFileStatusKind, GitStatusEntry, UnmergedEntrySummary } from "../../models/status";
import type { IStatusResult } from "../git-ipc";
import { ConflictStore } from "./conflict-store";

function status(conflictMarkerCount: number, mergeHeadFound = true): IStatusResult {
  return {
    currentBranch: "main",
    mergeHeadFound,
    squashMsgFound: false,
    isCherryPickingHeadFound: false,
    doConflictedFilesExist: true,
    files: [
      {
        path: "conflicted.txt",
        startsUnselected: false,
        status: {
          kind: AppFileStatusKind.Conflicted,
          entry: {
            kind: "conflicted",
            action: UnmergedEntrySummary.BothModified,
            us: GitStatusEntry.UpdatedButUnmerged,
            them: GitStatusEntry.UpdatedButUnmerged,
          },
          conflictMarkerCount,
        },
      },
      {
        path: "ordinary.txt",
        startsUnselected: false,
        status: { kind: AppFileStatusKind.Modified },
      },
    ],
  };
}

describe("ConflictStore", () => {
  it("loads merge state and only conflicted paths", async () => {
    const getStatus = vi.fn(async () => status(2));
    const store = new ConflictStore({ getStatus });

    await store.load("/repo");

    expect(getStatus).toHaveBeenCalledWith("/repo", true);
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      mergeInProgress: true,
      files: [expect.objectContaining({ path: "conflicted.txt" })],
      loading: false,
      error: null,
    });
    expect(store.state.files[0].resolvedInWorkingTree).toBe(false);
  });

  it("stages a marker-free resolution with its exact index entries and refreshes", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(status(0))
      .mockResolvedValueOnce({
        ...status(0),
        doConflictedFilesExist: false,
        files: [],
      });
    const stageResolvedConflictFiles = vi.fn(async () => undefined);
    const store = new ConflictStore({
      getStatus,
      stageResolvedConflictFiles,
    });
    await store.load("/repo");

    const staged = await store.stageResolvedFile("conflicted.txt");

    expect(staged).toBe(true);
    expect(stageResolvedConflictFiles).toHaveBeenCalledWith("/repo", [
      {
        path: "conflicted.txt",
        entries: [GitStatusEntry.UpdatedButUnmerged, GitStatusEntry.UpdatedButUnmerged],
        conflictMarkerCount: 0,
      },
    ]);
    expect(store.state).toMatchObject({
      mergeInProgress: true,
      files: [],
      stagingPath: null,
      operationError: null,
    });
  });

  it("refuses to stage a path that still has conflict markers", async () => {
    const stageResolvedConflictFiles = vi.fn(async () => undefined);
    const store = new ConflictStore({
      getStatus: vi.fn(async () => status(1)),
      stageResolvedConflictFiles,
    });
    await store.load("/repo");

    expect(await store.stageResolvedFile("conflicted.txt")).toBe(false);
    expect(stageResolvedConflictFiles).not.toHaveBeenCalled();
    expect(store.state.operationError).toBe(
      "Resolve all conflict markers before staging conflicted.txt.",
    );
  });

  it("publishes staging failures without losing conflict state", async () => {
    const store = new ConflictStore({
      getStatus: vi.fn(async () => status(0)),
      stageResolvedConflictFiles: vi.fn(async () => {
        throw new Error("stage failed");
      }),
    });
    await store.load("/repo");

    expect(await store.stageResolvedFile("conflicted.txt")).toBe(false);
    expect(store.state.files).toHaveLength(1);
    expect(store.state.stagingPath).toBeNull();
    expect(store.state.operationError).toBe("Error: stage failed");
  });

  it("ignores stale status after switching repositories", async () => {
    let resolveOld: ((status: IStatusResult) => void) | undefined;
    const oldStatus = new Promise<IStatusResult>((resolve) => {
      resolveOld = resolve;
    });
    const getStatus = vi
      .fn()
      .mockReturnValueOnce(oldStatus)
      .mockResolvedValueOnce({
        ...status(0, false),
        doConflictedFilesExist: false,
        files: [],
      });
    const store = new ConflictStore({ getStatus });

    const oldLoad = store.load("/old");
    await store.load("/current");
    resolveOld?.(status(3));
    await oldLoad;

    expect(store.state.repositoryPath).toBe("/current");
    expect(store.state.mergeInProgress).toBe(false);
    expect(store.state.files).toEqual([]);
  });
});
