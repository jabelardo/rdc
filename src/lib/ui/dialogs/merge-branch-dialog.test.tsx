import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch, BranchType } from "../../../models/branch";
import { ComputedAction } from "../../../models/computed-action";
import { MergeBranchDialog } from "./merge-branch-dialog";

function branch(name: string, type: BranchType = BranchType.Local): Branch {
  return new Branch(
    name,
    null,
    { sha: "a".repeat(40), author: { date: new Date(0) } },
    type,
    type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/origin/${name}`,
    false,
  );
}

const candidates = [branch("develop"), branch("feature/auth"), branch("release/v2")];

function renderDialog(overrides: Partial<Parameters<typeof MergeBranchDialog>[0]> = {}) {
  const props = {
    currentBranch: "main",
    candidates,
    defaultBranch: "develop",
    recentBranches: ["feature/auth"],
    selected: null,
    strategy: "merge" as const,
    status: null,
    commitCount: 0,
    running: false,
    failure: null,
    onSelect: vi.fn(),
    onStrategyChange: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<MergeBranchDialog {...props} />);
  return props;
}

const clean = { kind: ComputedAction.Clean } as const;
const message = () => document.querySelector("#merge-branch-message");

describe("MergeBranchDialog", () => {
  it("shows the selected branch as selected", async () => {
    // The WIP computed selection and never rendered it, so clicking a branch did nothing visible.
    const user = userEvent.setup();
    const props = renderDialog();

    const option = screen.getByRole("option", { name: /feature\/auth/ });
    expect(option).toHaveAttribute("aria-selected", "false");

    await user.click(option);
    expect(props.onSelect).toHaveBeenCalledWith(candidates[1]);
  });

  it("marks the chosen branch once it is selected", () => {
    renderDialog({ selected: candidates[1] });

    expect(screen.getByRole("option", { name: /feature\/auth/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("explains what the merge will do rather than only disabling the button", () => {
    // The preview was written and then commented out, so the button greyed out with no reason.
    renderDialog({ selected: candidates[1], status: clean, commitCount: 4 });

    expect(message()).toHaveTextContent("Brings 4 commits from feature/auth into main");
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeEnabled();
  });

  it("says when there is nothing to merge, and blocks the action", () => {
    renderDialog({ selected: candidates[1], status: clean, commitCount: 0 });

    expect(message()).toHaveTextContent("main is already up to date with feature/auth");
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeDisabled();
  });

  it("allows a conflicting merge but warns how many files", () => {
    // desktop-plus starts anyway and resolves afterwards — conflicts are an outcome, not a refusal.
    renderDialog({
      selected: candidates[1],
      status: { kind: ComputedAction.Conflicts, conflictedFiles: 3 },
      commitCount: 4,
    });

    expect(message()).toHaveTextContent("This will leave 3 files conflicted");
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeEnabled();
  });

  it("blocks unrelated histories", () => {
    renderDialog({ selected: candidates[1], status: { kind: ComputedAction.Invalid } });

    expect(screen.getByRole("alert")).toHaveTextContent("unrelated histories");
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeDisabled();
  });

  it("blocks while mergeability is still being computed", () => {
    renderDialog({ selected: candidates[1], status: { kind: ComputedAction.Loading } });

    expect(message()).toHaveTextContent(/Checking whether/);
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeDisabled();
  });

  it("names the strategy and the destination on the button", () => {
    // Direction is the thing users get wrong, so the button says the whole sentence.
    renderDialog({ selected: candidates[1], status: clean, commitCount: 4, strategy: "squash" });

    expect(screen.getByRole("button", { name: "Squash into main" })).toBeEnabled();
    expect(message()).toHaveTextContent("Combines 4 commits from feature/auth into one commit");
  });

  it("offers both strategies and reports a change", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ selected: candidates[1], status: clean, commitCount: 4 });

    await user.click(screen.getByRole("button", { name: /Choose how to combine/ }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitemradio", { name: /Create a merge commit/ })).toBeInTheDocument();

    await user.click(menu.getByRole("menuitemradio", { name: /Squash and merge/ }));
    expect(props.onStrategyChange).toHaveBeenCalledWith("squash");
  });

  it("reports a failed merge in the message slot", () => {
    renderDialog({ selected: candidates[1], status: clean, commitCount: 4, failure: "refusing" });

    expect(screen.getByRole("alert")).toHaveTextContent("refusing");
  });

  it("blocks every dismissal while the merge is running", async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      selected: candidates[1],
      status: clean,
      commitCount: 4,
      running: true,
    });

    expect(screen.getByRole("button", { name: "Merging…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("offers only a way out when there is no other branch", () => {
    renderDialog({ candidates: [] });

    expect(screen.getByText("There are no other branches to merge.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
