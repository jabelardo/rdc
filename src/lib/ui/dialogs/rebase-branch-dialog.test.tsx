import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch, BranchType } from "../../../models/branch";
import { ComputedAction } from "../../../models/computed-action";
import { RebaseBranchDialog, rebaseCandidates } from "./rebase-branch-dialog";

function sha(name: string): string {
  return name.length.toString(16).padStart(2, "0").repeat(20);
}

function branch(name: string, type: BranchType = BranchType.Local): Branch {
  return new Branch(
    name,
    null,
    { sha: sha(name), author: { date: new Date(0) } },
    type,
    type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/origin/${name}`,
    false,
  );
}

const candidates = [branch("develop"), branch("feature/auth"), branch("release/v2")];

function renderDialog(overrides: Partial<Parameters<typeof RebaseBranchDialog>[0]> = {}) {
  const props = {
    currentBranch: "main",
    candidates,
    defaultBranch: "develop",
    recentBranches: ["feature/auth"],
    selected: null,
    preview: null,
    running: false,
    progress: null,
    failure: null,
    onSelect: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<RebaseBranchDialog {...props} />);
  return props;
}

const clean = (commitsAhead: number, commitsBehind: number) =>
  ({ kind: ComputedAction.Clean, commitsAhead, commitsBehind }) as const;

const message = () => document.querySelector("#rebase-branch-message");

describe("RebaseBranchDialog", () => {
  it("shows the chosen base branch as selected", () => {
    renderDialog({ selected: candidates[1] });

    expect(screen.getByRole("option", { name: /feature\/auth/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps arrow navigation working after selecting a row with the mouse", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    const selectedRow = screen.getByRole("option", { name: /feature\/auth/ });

    await user.click(selectedRow);
    expect(document.activeElement).toBe(selectedRow);

    await user.keyboard("{ArrowDown}");
    expect(props.onSelect).toHaveBeenLastCalledWith(candidates[2]);
  });

  it("restores row focus when the selected branch prop rerenders the picker", async () => {
    const user = userEvent.setup();
    const props = {
      currentBranch: "main",
      candidates,
      defaultBranch: "develop",
      recentBranches: ["feature/auth"],
      selected: null,
      preview: null,
      running: false,
      progress: null,
      failure: null,
      onSelect: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<RebaseBranchDialog {...props} />);
    const selectedRow = screen.getByRole("option", { name: /feature\/auth/ });

    await user.click(selectedRow);
    expect(document.activeElement).toBe(selectedRow);

    // Model the controller committing the selected branch and updating the preview after the
    // callback. This is the rerender that can otherwise steal the row's focus in WebKit.
    view.rerender(<RebaseBranchDialog {...props} selected={candidates[1]} preview={clean(2, 1)} />);
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /feature\/auth/ }));

    await user.keyboard("{ArrowDown}");
    expect(props.onSelect).toHaveBeenLastCalledWith(candidates[2]);
  });

  it("replaces the picker with the shared progress dialog while rebasing", async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      selected: candidates[1],
      preview: clean(3, 2),
      running: true,
      progress: {
        kind: "multiCommitOperation",
        value: 0.5,
        title: "Rebasing onto feature/auth",
        description: "Applying commit 2 of 3",
        position: 2,
        totalCommitCount: 3,
        currentCommitSummary: "Move authentication behind the flag",
      },
    });

    expect(screen.getByRole("alertdialog", { name: "Rebasing in progress" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByRole("status")).toHaveTextContent("Commit 2 of 3");
    expect(screen.getByRole("status")).toHaveTextContent("Move authentication behind the flag");
    expect(screen.queryByRole("button", { name: "Rebase" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog", { name: "Rebasing in progress" })).toBeInTheDocument();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("explains the rebase rather than only disabling the button", () => {
    // The classic case: current is both ahead (commits to replay) and behind (a base to catch up
    // to), so the rebase replays the current branch's commits on top of the base.
    renderDialog({ selected: candidates[1], preview: clean(3, 2) });

    expect(message()).toHaveTextContent(
      "This will update main by applying its 3 commits on top of feature/auth",
    );
    expect(screen.getByRole("button", { name: "Rebase" })).toBeEnabled();
  });

  it("describes a fast-forward when there are no commits to replay", () => {
    // behind only: the current branch is a strict ancestor of the base.
    renderDialog({ selected: candidates[1], preview: clean(0, 4) });

    expect(message()).toHaveTextContent(
      "This will fast-forward main by 4 commits to match feature/auth",
    );
    expect(screen.getByRole("button", { name: "Rebase" })).toBeEnabled();
  });

  it("uses the singular wording for a single commit", () => {
    renderDialog({ selected: candidates[1], preview: clean(1, 3) });

    expect(message()).toHaveTextContent("applying its 1 commit on top of feature/auth");
  });

  it("says when there is nothing to rebase, and blocks the action", () => {
    // ahead only (not behind): the current branch already contains the base, so a rebase is a no-op.
    renderDialog({ selected: candidates[1], preview: clean(2, 0) });

    expect(message()).toHaveTextContent("main is already up to date with feature/auth");
    expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
  });

  it("blocks unrelated histories", () => {
    renderDialog({ selected: candidates[1], preview: { kind: ComputedAction.Invalid } });

    expect(screen.getByRole("alert")).toHaveTextContent("unrelated histories");
    expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
  });

  it("blocks while the rebase preview is still being computed", () => {
    renderDialog({ selected: candidates[1], preview: { kind: ComputedAction.Loading } });

    expect(message()).toHaveTextContent(/Checking whether/);
    expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
  });

  it("keeps the operation's direction in the title, not the button", () => {
    // The title already says "Rebase main"; the button is a single plain action with no strategy
    // caret, so "Rebase" alone is unambiguous — direction lives in the title and the field label.
    renderDialog({ selected: candidates[2], preview: clean(2, 1) });

    expect(screen.getByRole("heading", { name: /Rebase/ })).toHaveTextContent("Rebase main");
    expect(screen.getByRole("button", { name: "Rebase" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Choose how to combine/ })).not.toBeInTheDocument();
  });

  it("reports a failed rebase in the message slot", () => {
    renderDialog({ selected: candidates[1], preview: clean(2, 1), failure: "refusing" });

    expect(screen.getByRole("alert")).toHaveTextContent("refusing");
  });

  it("blocks every dismissal while the rebase is running", async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      selected: candidates[1],
      preview: clean(2, 1),
      running: true,
    });

    expect(screen.getByRole("alertdialog", { name: "Rebasing in progress" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("says what the reserved message space is for before a branch is chosen", () => {
    renderDialog();

    expect(message()).toHaveTextContent("Choose a branch to see what rebasing onto it will do.");
    expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
  });

  it("offers only a way out when there is no other branch", () => {
    renderDialog({ candidates: [] });

    expect(screen.getByText("There are no other branches to rebase onto.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("rebaseCandidates", () => {
  it("offers every non-current branch, including ones a merge would drop", () => {
    // A merge filters out already-merged branches as noise; a rebase must keep them, because a base
    // the current branch has already passed is the truthful "already up to date" answer, not noise.
    const all = [branch("main"), branch("develop"), branch("feature/auth")];

    expect(rebaseCandidates(all, "main").map((entry) => entry.name)).toEqual([
      "develop",
      "feature/auth",
    ]);
  });

  it("offers remote branches as bases", () => {
    const all = [branch("origin/develop", BranchType.Remote), branch("main")];

    expect(rebaseCandidates(all, "main").map((entry) => entry.name)).toEqual(["origin/develop"]);
  });

  it("offers everything when the current branch is not in the list", () => {
    const all = [branch("develop"), branch("feature/auth")];

    expect(rebaseCandidates(all, "main").map((entry) => entry.name)).toEqual([
      "develop",
      "feature/auth",
    ]);
  });
});
