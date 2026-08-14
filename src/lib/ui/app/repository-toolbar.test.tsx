import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RemoteState } from "../../stores/remote-store";
import type { OperationRecord } from "../../../models/operation";
import { operationProgressViewModel } from "../../operation-presentation";
import { RepositoryToolbar } from "./repository-toolbar";

const remoteState: RemoteState = {
  repositoryPath: "/repo",
  remotes: [],
  currentRemote: { name: "origin", url: "/remote.git" },
  currentBranch: { name: "main", upstream: "origin/main" } as RemoteState["currentBranch"],
  loading: false,
  error: null,
  operation: "fetch",
  progress: {
    kind: "fetch",
    remote: "origin",
    value: 0.5,
    description: "Receiving objects",
  },
  operationError: null,
};

describe("RepositoryToolbar progress presentation", () => {
  it("does not render store callback progress without a native view model", () => {
    render(
      <RepositoryToolbar
        remoteState={remoteState}
        canFetch={false}
        canPush={false}
        canPull={false}
        hasEditor={false}
        hasShell={false}
        repositoryView="changes"
        onCreateRepository={vi.fn()}
        onAddExistingRepository={vi.fn()}
        onCloneRepository={vi.fn()}
        onShowFiles={vi.fn()}
        onOpenEditor={vi.fn()}
        onOpenShell={vi.fn()}
        onFetch={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
        onSelectView={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Receiving objects/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();
  });

  it("prefers a native remote error over the store error fallback", () => {
    const operation: OperationRecord = {
      id: "fetch-1",
      scope: { kind: "repository", lockKey: "repo", repositoryPath: "/repo" },
      ownerWindow: "window-a",
      operation: "fetch",
      state: "failed",
      cancellation: { kind: "unavailable" },
      progress: { value: 0.5, description: "Receiving objects" },
      lastActivityAt: 1,
      outcome: "unknown",
      error: { kind: "failed", message: "Native fetch failed", recoverable: true },
    };
    render(
      <RepositoryToolbar
        remoteState={{ ...remoteState, operationError: "Store fetch failed" }}
        operationViewModel={operationProgressViewModel(operation, "window-a")}
        canFetch={false}
        canPush={false}
        canPull={false}
        hasEditor={false}
        hasShell={false}
        repositoryView="changes"
        onCreateRepository={vi.fn()}
        onAddExistingRepository={vi.fn()}
        onCloneRepository={vi.fn()}
        onShowFiles={vi.fn()}
        onOpenEditor={vi.fn()}
        onOpenShell={vi.fn()}
        onFetch={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
        onSelectView={vi.fn()}
      />,
    );

    expect(screen.getByText("Native fetch failed")).toBeInTheDocument();
    expect(screen.queryByText("Store fetch failed")).not.toBeInTheDocument();
  });

  it("does not render a store operation error while a native remote record owns the operation", () => {
    const operation: OperationRecord = {
      id: "fetch-1",
      scope: { kind: "repository", lockKey: "repo", repositoryPath: "/repo" },
      ownerWindow: "window-a",
      operation: "fetch",
      state: "running",
      cancellation: { kind: "available", label: "Cancel fetch" },
      progress: { value: 0.5, description: "Receiving objects" },
      lastActivityAt: 1,
      outcome: null,
      error: null,
    };
    render(
      <RepositoryToolbar
        remoteState={{ ...remoteState, operationError: "Stale callback error" }}
        operationViewModel={operationProgressViewModel(operation, "window-a")}
        canFetch={false}
        canPush={false}
        canPull={false}
        hasEditor={false}
        hasShell={false}
        repositoryView="changes"
        onCreateRepository={vi.fn()}
        onAddExistingRepository={vi.fn()}
        onCloneRepository={vi.fn()}
        onShowFiles={vi.fn()}
        onOpenEditor={vi.fn()}
        onOpenShell={vi.fn()}
        onFetch={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
        onSelectView={vi.fn()}
      />,
    );

    expect(screen.queryByText("Stale callback error")).not.toBeInTheDocument();
  });
});
