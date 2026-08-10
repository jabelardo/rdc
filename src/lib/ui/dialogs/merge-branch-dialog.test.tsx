import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Branch, BranchType } from "../../../models/branch";
import { ComputedAction } from "../../../models/computed-action";
import { MergeBranchDialog, mergeCandidates } from "./merge-branch-dialog";

/** Distinct per name, so two branches only share a SHA when a test says they do. */
function sha(name: string): string {
  return name.length.toString(16).padStart(2, "0").repeat(20);
}

function branch(name: string, type: BranchType = BranchType.Local, sameCommitAs?: string): Branch {
  return new Branch(
    name,
    null,
    { sha: sha(sameCommitAs ?? name), author: { date: new Date(0) } },
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
    progress: null,
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
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("says when there is nothing to merge, and blocks the action", () => {
    renderDialog({ selected: candidates[1], status: clean, commitCount: 0 });

    expect(message()).toHaveTextContent("main is already up to date with feature/auth");
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("allows a conflicting merge but warns how many files", () => {
    // desktop-plus starts anyway and resolves afterwards — conflicts are an outcome, not a refusal.
    renderDialog({
      selected: candidates[1],
      status: { kind: ComputedAction.Conflicts, conflictedFiles: 3 },
      commitCount: 4,
    });

    expect(message()).toHaveTextContent("This will leave 3 files conflicted");
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("blocks unrelated histories", () => {
    renderDialog({ selected: candidates[1], status: { kind: ComputedAction.Invalid } });

    expect(screen.getByRole("alert")).toHaveTextContent("unrelated histories");
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("blocks while mergeability is still being computed", () => {
    renderDialog({ selected: candidates[1], status: { kind: ComputedAction.Loading } });

    expect(message()).toHaveTextContent(/Checking whether/);
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("names the chosen strategy on the button", () => {
    // The title already names the destination ("Merge into main"); the button names only the
    // strategy, which is the one thing the user chooses here.
    renderDialog({ selected: candidates[1], status: clean, commitCount: 4, strategy: "squash" });

    expect(screen.getByRole("button", { name: "Squash" })).toBeEnabled();
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

    expect(screen.getByRole("alertdialog", { name: "Merging in progress" })).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("moves the selection with the arrow keys from the focused row", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    screen.getByRole("option", { name: /develop/ }).focus();
    await user.keyboard("{ArrowDown}");

    expect(props.onSelect).toHaveBeenCalledWith(candidates[1]);
  });

  it("leaves the arrow keys alone in the filter field", async () => {
    // Arrow navigation belongs to the rows. In a text field the arrows move the caret, as they do
    // in any text field, and Tab is what moves between the field and the list.
    const user = userEvent.setup();
    const props = renderDialog();

    const filter = screen.getByRole("searchbox");
    filter.focus();
    await user.keyboard("{ArrowDown}{ArrowUp}");

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(filter);
  });

  it("keeps Tab stepping through the rows", async () => {
    // Rows stay individually focusable: the arrows are an addition, not a replacement for Tab.
    const user = userEvent.setup();
    renderDialog();

    screen.getByRole("searchbox").focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /develop/ }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /feature\/auth/ }));
  });

  it("continues past the end of a group rather than stopping at the heading", async () => {
    const user = userEvent.setup();
    // develop is the last of the default-branch group and feature/auth the first of the recent
    // group, so one step has to cross a heading.
    const onSelect = vi.fn();
    renderDialog({ selected: candidates[0], onSelect });

    screen.getByRole("option", { name: /develop/ }).focus();
    await user.keyboard("{ArrowDown}");

    expect(onSelect).toHaveBeenCalledWith(candidates[1]);
  });

  it("keeps focus inside the list while arrowing, and stops at the last row", async () => {
    // The complaint this guards: arrowing past the last row escaping to the action button. Focus
    // moves by ref rather than by walking the DOM, and clamps at the end.
    const user = userEvent.setup();
    renderDialog();

    screen.getByRole("option", { name: /develop/ }).focus();
    await user.keyboard("{ArrowDown}".repeat(candidates.length + 3));

    expect(document.activeElement).toHaveAttribute("role", "option");
    expect(document.activeElement).toBe(
      screen.getByRole("option", { name: new RegExp(candidates[candidates.length - 1].name) }),
    );
  });

  it("carries the full name and exact time the row cannot show", async () => {
    // The row truncates a long name and shows a relative time; the tooltip is where the two exact
    // facts live.
    const user = userEvent.setup();
    renderDialog();

    await user.hover(screen.getByRole("option", { name: /feature\/auth/ }));

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Full name: feature/auth");
    expect(tip).toHaveTextContent(/Last modified: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
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
    // An already-merged branch can only produce "Already up to date", so listing it is noise in a
    // control whose whole purpose is choosing something to act on.
    const all = [branch("main"), branch("develop"), branch("feature/auth")];

    const offered = mergeCandidates(all, "main", new Map([["refs/heads/develop", sha("develop")]]));

    expect(offered.map((entry) => entry.name)).toEqual(["feature/auth"]);
  });

  it("drops a remote branch sitting on an already-merged commit", () => {
    // --merged reports local refs only, so the ref name never matches. The SHA does, which is why
    // the map's values matter as much as its keys — and why this needs no extra git call.
    const all = [branch("origin/develop", BranchType.Remote, "develop")];

    const offered = mergeCandidates(all, "main", new Map([["refs/heads/develop", sha("develop")]]));

    expect(offered).toEqual([]);
  });

  it("drops a branch pointing at the current branch's own tip", () => {
    // Trivially up to date, and git excludes the current branch from its own --merged list.
    const all = [branch("main"), branch("mirror-of-main", BranchType.Local, "main")];

    expect(mergeCandidates(all, "main", new Map())).toEqual([]);
  });

  it("keeps both mergeable branches when given real git output", () => {
    // SHAs and the merged map are taken verbatim from the mergeStates QA fixture, whose three
    // branches are built to be already-merged, cleanly mergeable, and conflicting. The filter must
    // remove exactly one of them — this is the guard against it becoming over-eager and emptying a
    // list that should have had candidates in it.
    const real = (name: string, tip: string) =>
      new Branch(
        name,
        null,
        { sha: tip, author: { date: new Date(0) } },
        BranchType.Local,
        `refs/heads/${name}`,
        false,
      );
    const branches = [
      real("already-merged", "81b34322b6754b4123c4131eaf680c658e93cffa"),
      real("clean-merge", "24e9e22aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      real("conflicting-merge", "dd9f1ffaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      real("main", "6f87db5ae4ebc173757eecd6c3a33d7c5fb3882c"),
    ];
    // git-ops excludes the queried branch from its own merged list, so main is absent here.
    const merged = new Map([
      ["refs/heads/already-merged", "81b34322b6754b4123c4131eaf680c658e93cffa"],
    ]);

    expect(mergeCandidates(branches, "main", merged).map((entry) => entry.name)).toEqual([
      "clean-merge",
      "conflicting-merge",
    ]);
  });

  it("offers everything when the merged lookup produced nothing", () => {
    // A failed `git branch --merged` filters nothing rather than emptying the list.
    const all = [branch("develop"), branch("feature/auth")];

    expect(mergeCandidates(all, "main", new Map()).map((entry) => entry.name)).toEqual([
      "develop",
      "feature/auth",
    ]);
  });
});
