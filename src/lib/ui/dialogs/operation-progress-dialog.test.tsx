import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "../../../models/operation";
import { operationProgressViewModel } from "../../operation-presentation";
import { OperationProgressBody, OperationProgressDialog } from "./operation-progress-dialog";

const operationRecord = (state: OperationRecord["state"] = "running"): OperationRecord => ({
  id: "operation-1",
  scope: { kind: "repository", lockKey: "repo", repositoryPath: "/repo" },
  ownerWindow: "window-a",
  operation: "fetch",
  state,
  cancellation: { kind: "available", label: "Cancel fetch" },
  progress: { value: 0.25, description: "Receiving objects" },
  lastActivityAt: 1,
  outcome: state === "completed" ? "completed" : null,
  error: null,
});

function renderDialog(overrides: Partial<Parameters<typeof OperationProgressDialog>[0]> = {}) {
  return render(
    <OperationProgressDialog
      operation="Rebase"
      progress={{ value: 0.5, title: "Rebasing onto main", description: "Applying 3 of 6" }}
      {...overrides}
    />,
  );
}

describe("OperationProgressDialog", () => {
  it("announces the operation and a progressbar", () => {
    renderDialog();

    expect(screen.getByRole("alertdialog", { name: "Rebase in progress" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  });

  it("reports the current commit for a multi-commit operation", () => {
    renderDialog({
      currentCommit: { position: 2, totalCommitCount: 5, summary: "Add feature flag" },
    });

    expect(screen.getByRole("status")).toHaveTextContent("Commit 2 of 5 — Add feature flag");
  });

  it("falls back to the latest git line for non multi-commit operations (clone, commit)", () => {
    // Radix portals the dialog into the body, so query via screen rather than the render container.
    renderDialog({ currentCommit: undefined });
    expect(screen.getByRole("status")).toHaveTextContent("Applying 3 of 6");
  });

  it("mounts the per-operation extension slot", () => {
    renderDialog({
      // A commit's hook terminal output is the prototypical case.
      children: <pre data-testid="terminal">$ hooks/commit-msg ran</pre>,
    });

    expect(screen.getByTestId("terminal")).toHaveTextContent("$ hooks/commit-msg ran");
  });

  it("cannot be dismissed — Escape leaves the dialog in place", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("alertdialog", { name: "Rebase in progress" })).toBeInTheDocument();
    expect(screen.queryByText("Abort")).not.toBeInTheDocument();
  });

  it("clamps an out-of-range progress value", () => {
    renderDialog({ progress: { value: 1.7 } });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("renders the capability-aware cancel control for the owner", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <OperationProgressDialog
        viewModel={operationProgressViewModel(operationRecord(), "window-a")}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel fetch" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows recovery status and no cancel control while recovering", () => {
    render(
      <OperationProgressDialog
        viewModel={operationProgressViewModel(operationRecord("recovering"), "window-a")}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Recovering repository…");
    expect(screen.queryByRole("button", { name: "Cancel fetch" })).not.toBeInTheDocument();
  });

  it("renders the shared progress body without mounting a modal", () => {
    render(
      <OperationProgressBody
        viewModel={operationProgressViewModel(operationRecord(), "window-a")}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Receiving objects");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("identifies an observer window without offering the owner's control", () => {
    render(
      <OperationProgressBody
        viewModel={operationProgressViewModel(operationRecord(), "window-b")}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Started in another window");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers explicit cancellation adoption for an unowned operation", async () => {
    const user = userEvent.setup();
    const onAdoptCancellation = vi.fn();
    render(
      <OperationProgressDialog
        viewModel={operationProgressViewModel(
          { ...operationRecord(), ownerWindow: null },
          "window-b",
        )}
        onAdoptCancellation={onAdoptCancellation}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Take control and cancel" }));

    expect(onAdoptCancellation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cancel fetch" })).not.toBeInTheDocument();
  });

  it("renders Retry only when the operation policy explicitly enables it", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const model = {
      ...operationProgressViewModel(
        {
          ...operationRecord("failed"),
          cancellation: { kind: "unavailable" },
          outcome: "unknown",
          error: { kind: "failed", message: "temporary failure", recoverable: true },
        },
        "window-a",
      ),
      retryAvailable: true,
    };
    render(<OperationProgressDialog viewModel={model} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not repeat a terminal error already used as the lifecycle status", () => {
    const failed: OperationRecord = {
      ...operationRecord("failed"),
      cancellation: { kind: "unavailable" },
      error: { kind: "failed", message: "Remote rejected the operation", recoverable: true },
      outcome: "unknown",
    };
    render(
      <OperationProgressDialog
        viewModel={operationProgressViewModel(failed, "window-a")}
        onClose={() => {}}
      />,
    );

    expect(screen.getAllByText("Remote rejected the operation")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("moves focus to Close when cancellation reaches a terminal state", () => {
    const onClose = vi.fn();
    const cancelling: OperationRecord = {
      ...operationRecord("cancelling"),
      cancellation: { kind: "requested" },
    };
    const view = render(
      <OperationProgressDialog
        viewModel={operationProgressViewModel(cancelling, "window-a")}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    const cancelled: OperationRecord = {
      ...cancelling,
      state: "cancelled",
      outcome: "recovered",
      error: { kind: "cancelled", message: "Clone was cancelled", recoverable: true },
    };
    view.rerender(
      <OperationProgressDialog
        viewModel={operationProgressViewModel(cancelled, "window-a")}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});
