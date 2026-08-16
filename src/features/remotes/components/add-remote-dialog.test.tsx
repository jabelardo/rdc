import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { IRemote } from "@/models/remote";
import { AddRemoteDialog } from "./add-remote-dialog";

const remotes: ReadonlyArray<IRemote> = [{ name: "origin", url: "git@github.com:o/r.git" }];

function renderDialog(overrides: Partial<Parameters<typeof AddRemoteDialog>[0]> = {}) {
  const props = {
    name: "upstream",
    url: "https://github.com/user/repo.git",
    remotes,
    busy: false,
    error: null,
    onNameChange: vi.fn(),
    onURLChange: vi.fn(),
    onConfirm: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<AddRemoteDialog {...props} />);
  return props;
}

const addButton = () => screen.getByRole("button", { name: /Add remote|Adding/ });

describe("AddRemoteDialog", () => {
  it("submits the remote", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.click(addButton());

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  /**
   * Each of these is refused here rather than by Git, because Git's own answer is worse: an empty
   * name produces a usage dump, and a duplicate produces "remote already exists" after the round
   * trip. The dialog knows enough to say so before anything runs.
   */
  it.each([
    ["an empty name", { name: "   " }],
    ["a name containing whitespace", { name: "my remote" }],
    ["an empty URL", { url: "  " }],
    ["a name that already exists", { name: "origin" }],
  ])("refuses %s", (_case, overrides) => {
    renderDialog(overrides);

    expect(addButton()).toBeDisabled();
  });

  it("trims before comparing against existing remotes", () => {
    renderDialog({ name: "  origin  " });

    expect(addButton()).toBeDisabled();
  });

  // Convention 8: dismissal is refused while the confirmed operation is in flight.
  it("disables everything while the add is running", () => {
    renderDialog({ busy: true });

    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
  });

  // Convention 17: the failure belongs to the surface the user acted on.
  it("reports a failure inline and still offers a way out", () => {
    renderDialog({ error: 'A remote named "upstream" already exists.' });

    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
