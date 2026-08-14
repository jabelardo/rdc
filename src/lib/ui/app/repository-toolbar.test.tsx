import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RemoteState } from "../../stores/remote-store";
import { RepositoryToolbar } from "./repository-toolbar";

const remoteState: RemoteState = {
  repositoryPath: "/repo",
  remotes: [],
  currentRemote: { name: "origin", url: "/remote.git" },
  currentBranch: { name: "main", upstream: "origin/main" } as RemoteState["currentBranch"],
  loading: false,
  managementError: null,
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

  // The toolbar renders no error text at all any more. Transport failures belong to the modal
  // progress dialog (they are the terminal state of an operation the user is watching); everything
  // else goes to the toast. The slot that used to hold this could not fit a sentence anyway — the
  // Phase 8b screenshot shows it truncated to "failed to run git f…".
  it("renders no remote error, whatever the stores are carrying", () => {
    render(
      <RepositoryToolbar
        remoteState={{ ...remoteState, managementError: "Could not add the remote" }}
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

    expect(screen.queryByText("Could not add the remote")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still identifies an operation running in a peer window", () => {
    render(
      <RepositoryToolbar
        remoteState={remoteState}
        operationPeerMessage="fetch in progress — Started in another window"
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

    expect(screen.getByText("fetch in progress — Started in another window")).toBeInTheDocument();
  });
});
