import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch, BranchType } from "@/models/branch";
import { RenameBranchDialog } from "./rename-branch-dialog";

function branch(name: string, upstream: string | null = null): Branch {
  return new Branch(
    name,
    upstream,
    { sha: "a".repeat(40), author: { date: new Date(0) } },
    BranchType.Local,
    `refs/heads/${name}`,
    false,
  );
}

function renderDialog(overrides: Partial<Parameters<typeof RenameBranchDialog>[0]> = {}) {
  const props = {
    branch: branch("feature/old"),
    name: "feature/old",
    existingNames: ["main", "develop", "feature/old"],
    busy: false,
    failure: null,
    onNameChange: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<RenameBranchDialog {...props} />);
  return props;
}

const renameButton = () => screen.getByRole("button", { name: /^Rename/ });

describe("RenameBranchDialog", () => {
  it("cannot be confirmed until the name actually changes", () => {
    renderDialog();

    expect(renameButton()).toBeDisabled();
  });

  it("explains why a name is refused, and keeps the button disabled", () => {
    renderDialog({ name: "my new branch" });

    expect(screen.getByRole("alert")).toHaveTextContent("A branch name cannot contain spaces.");
    expect(renameButton()).toBeDisabled();
  });

  it("catches a name already taken before git is asked", () => {
    renderDialog({ name: "develop" });

    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
    expect(renameButton()).toBeDisabled();
  });

  it("enables the rename once the name is valid", () => {
    renderDialog({ name: "feature/new" });

    expect(renameButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the message slot in the DOM even with nothing to say", () => {
    // Why the slot exists: a message appearing as the user types would otherwise shift the confirm
    // button out from under their cursor at the worst possible moment. jsdom computes no layout, so
    // this asserts the structural half — the element is always present. The reserved *height* is a
    // min-h utility and belongs to the visual pass.
    renderDialog({ name: "feature/new", existingNames: [] });

    const slot = document.querySelector("#rename-branch-message");
    expect(slot).toBeInTheDocument();
    expect(slot).toBeEmptyDOMElement();
    expect(slot).toHaveClass("min-h-[2.6em]");
  });

  it("shows a failed rename in the same slot, outranking a tracking note", () => {
    renderDialog({
      branch: branch("feature/old", "origin/feature/old"),
      name: "feature/new",
      failure: "Permission denied",
    });

    const slot = document.querySelector("#rename-branch-message");
    expect(slot).toHaveTextContent("Permission denied");
    expect(slot).not.toHaveTextContent(/tracks/i);
  });

  it("notes that renaming leaves the remote branch alone", () => {
    renderDialog({ branch: branch("feature/old", "origin/feature/old"), name: "feature/new" });

    const slot = document.querySelector("#rename-branch-message");
    expect(slot).toHaveTextContent("origin/feature/old");
    // Context, not an interruption — it is present the moment the dialog opens.
    expect(slot).not.toHaveAttribute("role", "alert");
  });

  it("blocks every dismissal while the rename is running", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ name: "feature/new", busy: true });

    expect(screen.getByRole("button", { name: "Renaming…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("selects the existing name on open so typing replaces it", () => {
    renderDialog();

    const input = screen.getByLabelText(/New name for/);
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe("feature/old".length);
  });
});
