import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const props = {
    title: "Abort merge",
    description: "Abort the in-progress merge?",
    confirmLabel: "Abort merge",
    busyLabel: "Aborting…",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ConfirmDialog {...props} />);
  return props;
}

describe("ConfirmDialog", () => {
  it("names both actions and describes what is being confirmed", () => {
    renderDialog();

    expect(screen.getByRole("alertdialog", { name: "Abort merge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abort merge" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  // Convention 17: the failure belongs to the surface the user acted on, not to a toast — behind a
  // Radix modal a toast is visible but inert.
  it("reports a failure inline, as an alert", () => {
    renderDialog({ error: "fatal: There is no merge to abort (MERGE_HEAD missing)." });

    expect(screen.getByRole("alert")).toHaveTextContent("MERGE_HEAD missing");
  });

  /**
   * The other half of Convention 17, and the reason the debug menu previews this state: a dialog
   * that shows a failure while refusing every way out is a trap. The caller's obligation is to
   * clear `busy` before setting the error, and this is what that obligation buys.
   */
  it("still offers a way out once a failed operation is no longer in flight", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ busy: false, error: "Could not abort the merge." });

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    // Retrying has to remain possible too — a failure is not necessarily final.
    expect(screen.getByRole("button", { name: "Abort merge" })).toBeEnabled();

    await user.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // Convention 8: losing the dialog mid-operation would leave the user unable to tell whether it
  // completed, so every dismissal path is refused while it runs.
  it("refuses every dismissal while the operation is in flight", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ busy: true });

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Aborting…" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  // The dialog stays mounted so it can report a failure in place; Radix's Action would otherwise
  // close it, which is why the component prevents the default.
  it("stays open when the affirmative action is taken", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Abort merge" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
