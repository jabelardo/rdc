import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "@/models/operation";
import { operationProgressViewModel } from "@/lib/operation-presentation";
import { CloneRepositoryDialog } from "./clone-repository-dialog";

const cloneOperation: OperationRecord = {
  id: "clone-operation-1",
  scope: { kind: "cloneDestination", lockKey: "/tmp/repo", destinationPath: "/tmp/repo" },
  ownerWindow: "window-a",
  operation: "clone",
  state: "running",
  cancellation: { kind: "available", label: "Cancel clone" },
  progress: { value: 0.6, description: "Receiving objects: 60%" },
  lastActivityAt: 1,
  outcome: null,
  error: null,
};

function renderDialog(overrides: Partial<Parameters<typeof CloneRepositoryDialog>[0]> = {}) {
  const props = {
    url: "",
    path: "",
    running: false,
    progress: null,
    error: null,
    onUrlChange: vi.fn(),
    onPathChange: vi.fn(),
    onChooseDestination: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<CloneRepositoryDialog {...props} />);
  return props;
}

/** A controlled harness that actually updates url/path as the user types, like the controller does. */
function renderStateful(initial: { url?: string; path?: string } = {}) {
  function Harness() {
    const [url, setUrl] = useState(initial.url ?? "");
    const [path, setPath] = useState(initial.path ?? "");
    return (
      <CloneRepositoryDialog
        url={url}
        path={path}
        running={false}
        progress={null}
        error={null}
        onUrlChange={setUrl}
        onPathChange={setPath}
        onChooseDestination={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
  }
  render(<Harness />);
}

describe("CloneRepositoryDialog", () => {
  it("stays disabled and says what is missing until both fields are filled", async () => {
    const user = userEvent.setup();
    renderStateful();

    const clone = screen.getByRole("button", { name: "Clone" });
    expect(clone).toBeDisabled();
    expect(screen.getByText(/Enter a repository URL and a destination path/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Repository URL"), "https://example.invalid/repo.git");
    expect(clone).toBeDisabled();

    await user.type(screen.getByLabelText("Destination path"), "/tmp/repo");
    expect(clone).toBeEnabled();
  });

  it("focuses the URL field on open", () => {
    renderDialog();

    expect(screen.getByLabelText("Repository URL")).toHaveFocus();
  });

  it("asks for the destination path and calls through", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("button", { name: /Browse/ }));
    expect(props.onChooseDestination).toHaveBeenCalledOnce();
  });

  it("submits with both fields filled", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ url: "https://example.invalid/repo.git", path: "/tmp/repo" });

    await user.click(screen.getByRole("button", { name: "Clone" }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  it("reports a failed clone in the message slot", () => {
    renderDialog({ url: "x", path: "/tmp/repo", error: "refusing" });

    expect(screen.getByRole("alert")).toHaveTextContent("refusing");
  });

  it("replaces the form with the shared progress dialog while cloning", async () => {
    // Clone is a category-1 operation: the moment it starts, the form gives way to the dedicated,
    // undismissable progress dialog — there is no "Cloning…" form button any more.
    const user = userEvent.setup();
    const props = renderDialog({
      url: "https://example.invalid/repo.git",
      path: "/tmp/repo",
      running: true,
      progress: {
        kind: "clone",
        title: "Cloning into /tmp/repo",
        value: 0.6,
        description: "Receiving objects: 60%",
      },
    });

    expect(screen.getByRole("alertdialog", { name: "Cloning in progress" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
    expect(screen.getByRole("status")).toHaveTextContent("Receiving objects: 60%");
    expect(screen.queryByRole("button", { name: /Cloning…/ })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog", { name: "Cloning in progress" })).toBeInTheDocument();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("cancels when not running", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("routes native clone cancellation through the operation control", async () => {
    const user = userEvent.setup();
    const onCancelOperation = vi.fn();
    renderDialog({
      running: true,
      operationViewModel: operationProgressViewModel(cloneOperation, "window-a"),
      onCancelOperation,
    });

    await user.click(screen.getByRole("button", { name: "Cancel clone" }));

    expect(onCancelOperation).toHaveBeenCalledOnce();
  });
});
