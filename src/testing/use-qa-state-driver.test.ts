import { describe, expect, it, vi } from "vitest";
import { applyQaState } from "./use-qa-state-driver";

describe("QA state driver history operations", () => {
  it("selects the repository before starting a production history operation", async () => {
    const calls: string[] = [];
    const handlers = {
      applyTheme: vi.fn(async () => undefined),
      setRepositoryView: vi.fn(),
      setSidebarCollapsed: vi.fn(),
      selectRepositoryByPath: vi.fn(async () => {
        calls.push("repository");
        return true;
      }),
      startHistoryOperation: vi.fn(async () => {
        calls.push("operation");
      }),
    };

    await applyQaState(
      {
        theme: null,
        view: "history",
        sidebarCollapsed: null,
        repository: "/tmp/qa-repository",
        historyOperation: {
          kind: "cherryPick",
          commit: "a".repeat(40),
          summary: "QA cherry-pick",
          parentCount: null,
        },
      },
      handlers,
    );

    expect(calls).toEqual(["repository", "operation"]);
    expect(handlers.startHistoryOperation).toHaveBeenCalledWith({
      kind: "cherryPick",
      commit: "a".repeat(40),
      summary: "QA cherry-pick",
      parentCount: null,
    });
  });

  it("does not start a history operation when the driver payload omits one", async () => {
    const startHistoryOperation = vi.fn(async () => undefined);

    await applyQaState(
      {
        theme: null,
        view: "changes",
        sidebarCollapsed: null,
        repository: null,
      },
      {
        applyTheme: vi.fn(async () => undefined),
        setRepositoryView: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        selectRepositoryByPath: vi.fn(async () => true),
        startHistoryOperation,
      },
    );

    expect(startHistoryOperation).not.toHaveBeenCalled();
  });
});
