import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DebugOperationProgressLauncher } from "./debug-operation-progress-launcher";

function renderLauncher() {
  const onShow = vi.fn();
  const onDismiss = vi.fn();
  render(<DebugOperationProgressLauncher onShow={onShow} onDismiss={onDismiss} />);
  return { onShow, onDismiss };
}

describe("DebugOperationProgressLauncher", () => {
  it("shows the selected state, operation and role", async () => {
    const user = userEvent.setup();
    const { onShow } = renderLauncher();

    await user.selectOptions(screen.getByLabelText("State"), "recoveryRequired");
    await user.selectOptions(screen.getByLabelText("Operation"), "push");
    await user.selectOptions(screen.getByLabelText("Role"), "observer");
    await user.click(screen.getByRole("button", { name: "Show" }));

    expect(onShow).toHaveBeenCalledWith("recoveryRequired", "push", "observer");
  });

  it("defaults to a running fetch owned by this window", async () => {
    const user = userEvent.setup();
    const { onShow } = renderLauncher();

    await user.click(screen.getByRole("button", { name: "Show" }));

    expect(onShow).toHaveBeenCalledWith("running", "fetch", "owner");
  });

  it("closes without showing anything", async () => {
    const user = userEvent.setup();
    const { onShow, onDismiss } = renderLauncher();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onShow).not.toHaveBeenCalled();
  });
});
