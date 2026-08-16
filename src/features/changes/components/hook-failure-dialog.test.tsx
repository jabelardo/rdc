import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HookFailureState } from "@/features/changes/stores/working-tree-store";
import { HookFailureDialog } from "./hook-failure-dialog";

const failure = {
  hook: "pre-commit",
  terminalOutput: "eslint: 3 problems (3 errors, 0 warnings)",
} as HookFailureState;

function renderDialog() {
  const onResolve = vi.fn();
  render(<HookFailureDialog failure={failure} onResolve={onResolve} />);
  return { onResolve };
}

describe("HookFailureDialog", () => {
  it("names the hook that failed and shows what it printed", () => {
    renderDialog();

    expect(screen.getByRole("alertdialog")).toHaveTextContent("The pre-commit hook failed");
    expect(screen.getByText(/eslint: 3 problems/)).toBeInTheDocument();
  });

  it("aborts the commit", async () => {
    const user = userEvent.setup();
    const { onResolve } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Abort" }));

    expect(onResolve).toHaveBeenCalledWith("abort");
  });

  it("commits anyway", async () => {
    const user = userEvent.setup();
    const { onResolve } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Ignore and Continue" }));

    expect(onResolve).toHaveBeenCalledWith("ignore");
  });

  /**
   * Convention 1: Radix focuses `AlertDialogCancel` on open, so whichever action is the cancel is
   * the one a keyboard user takes by reflex. After a hook has refused a commit, that must be Abort
   * — letting the refusal stand — and never "Ignore and Continue".
   */
  it("makes aborting the action a keyboard user reaches first", () => {
    renderDialog();

    expect(document.activeElement).toHaveTextContent("Abort");
  });
});
