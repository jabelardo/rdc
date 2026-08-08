import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch, BranchType } from "../../../models/branch";
import { ComputedAction } from "../../../models/computed-action";
import { MergeBranchDialog, mergeCandidates } from "./merge-branch-dialog";

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

  it("distinguishes a remote branch from a local one of the same name", () => {
    // Both rendered as "develop" while the remote's prefix was stripped, which made the picker
    // ambiguous in exactly the case where it matters.
    renderDialog({
      candidates: [branch("develop"), branch("origin/develop", BranchType.Remote)],
      recentBranches: [],
      defaultBranch: null,
    });

    expect(screen.getByRole("option", { name: /^develop/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^origin\/develop/ })).toBeInTheDocument();
  });

  it("says what the reserved message space is for before a branch is chosen", () => {
    // The slot holds its height so the footer cannot move; blank, it read as an unexplained gap.
    renderDialog();

    expect(message()).toHaveTextContent("Choose a branch to see what merging it will do.");
  });

  it("greys the strategy caret with the action it belongs to", () => {
    // One control in two halves — a lit caret beside a greyed confirm read as two buttons.
    renderDialog();

    expect(screen.getByRole("button", { name: "Merge into main" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Choose how to combine/ })).toBeDisabled();
  });

  it("says when mergeability could not be determined, instead of claiming up to date", () => {
    // The controller used to report any failure as ComputedAction.Clean with a zero commit count,
    // which rendered as "<current> is already up to date with <branch>" — a confident, wrong
    // statement about the repository whenever the lookup merely failed.
    renderDialog({
      selected: candidates[1],
      status: null,
      failure: "Could not determine whether these branches can be combined.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not determine");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/up to date/);
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeDisabled();
  });

  it("offers only a way out when there is no other branch", () => {
    renderDialog({ candidates: [] });

    expect(screen.getByText("There are no other branches to merge.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("mergeCandidates", () => {
  it("drops the current branch and anything already contained in it", () => {
    // An already-merged branch can only produce "Already up to date", so offering it just to refuse
    // it wastes a click.
    const all = [branch("main"), branch("develop"), branch("feature/auth")];

    const offered = mergeCandidates(all, "main", new Set(["refs/heads/develop"]));

    expect(offered.map((entry) => entry.name)).toEqual(["feature/auth"]);
  });

  it("keeps a remote branch that git branch --merged cannot report on", () => {
    // --merged lists local refs only, so a merged remote still appears; the per-branch preview
    // catches it on selection rather than the list hiding it.
    const all = [branch("origin/develop", BranchType.Remote)];

    const offered = mergeCandidates(all, "main", new Set(["refs/heads/develop"]));

    expect(offered.map((entry) => entry.name)).toEqual(["origin/develop"]);
  });

  it("offers everything when the merged lookup produced nothing", () => {
    // A failed `git branch --merged` filters nothing rather than emptying the list.
    const all = [branch("develop"), branch("feature/auth")];

    expect(mergeCandidates(all, "main", new Set()).map((entry) => entry.name)).toEqual([
      "develop",
      "feature/auth",
    ]);
  });
});
