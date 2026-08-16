import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutDialog } from "./about-dialog";

describe("AboutDialog", () => {
  it("shows the version with its architecture", () => {
    render(<AboutDialog architecture="arm64" onDismiss={vi.fn()} />);

    expect(screen.getByText(`Version ${__APP_VERSION__} (arm64)`)).toBeInTheDocument();
  });

  /**
   * The architecture resolves asynchronously, so the dialog can open before it arrives. Showing the
   * version without it beats showing "Version 0.1.0 (null)" or nothing at all.
   */
  it("shows the version alone until the architecture resolves", () => {
    render(<AboutDialog architecture={null} onDismiss={vi.fn()} />);

    expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
  });

  it("closes", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<AboutDialog architecture="arm64" onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
