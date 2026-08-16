import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { IRemote } from "@/models/remote";
import { ManageRemotesDialog } from "./manage-remotes-dialog";

const remotes: ReadonlyArray<IRemote> = [
  { name: "origin", url: "git@github.com:jabelardo/rdc.git" },
  { name: "upstream", url: "git@github.com:someone/rdc.git" },
];

function renderDialog(overrides: Partial<Parameters<typeof ManageRemotesDialog>[0]> = {}) {
  const props = {
    remotes,
    filter: "",
    busy: false,
    onFilterChange: vi.fn(),
    onNewRemote: vi.fn(),
    onRemoveRemote: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<ManageRemotesDialog {...props} />);
  return props;
}

describe("ManageRemotesDialog", () => {
  it("lists every remote with its URL", () => {
    renderDialog();

    const list = screen.getByRole("list", { name: "Remotes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("origin")).toBeInTheDocument();
    expect(within(list).getByText("git@github.com:jabelardo/rdc.git")).toBeInTheDocument();
  });

  // The actions are icons now, so their accessible names are the only thing naming them — and the
  // remove name has to identify *which* remote, since every row's icon looks identical.
  it("names its icon-only actions", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Add a remote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'Remove the "origin" remote' })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'Remove the "upstream" remote' }),
    ).toBeInTheDocument();
  });

  // Both halves of a row truncate, so the row alone cannot be trusted to have shown either one.
  it("carries the full name and URL for a row that had to truncate", () => {
    renderDialog();

    const region = screen.getByText("origin").closest("[data-tooltip]");

    expect(region?.getAttribute("data-tooltip")).toBe("origin\ngit@github.com:jabelardo/rdc.git");
    // Once a URL is ellipsised the tooltip is the only way to read it, so it has to be reachable
    // without a pointer — the row's remove button names the remote but not its URL.
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("removes the remote whose row was acted on", async () => {
    const user = userEvent.setup();
    const { onRemoveRemote } = renderDialog();

    await user.click(screen.getByRole("button", { name: 'Remove the "upstream" remote' }));

    expect(onRemoveRemote).toHaveBeenCalledWith("upstream");
  });

  it("matches a remote by its URL, not only its name", () => {
    renderDialog({ filter: "someone" });

    const list = screen.getByRole("list", { name: "Remotes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("upstream")).toBeInTheDocument();
  });

  it("distinguishes an empty repository from an empty filter result", () => {
    const { unmount } = render(
      <ManageRemotesDialog
        remotes={[]}
        filter=""
        busy={false}
        onFilterChange={vi.fn()}
        onNewRemote={vi.fn()}
        onRemoveRemote={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("This repository has no remotes.")).toBeInTheDocument();
    unmount();

    renderDialog({ filter: "nothing-matches-this" });
    expect(screen.getByText("No remotes match your filter.")).toBeInTheDocument();
  });

  // Convention 8: dismissal is refused while the confirmed operation is in flight.
  it("disables every action while a remote operation is running", () => {
    renderDialog({ busy: true });

    expect(screen.getByRole("button", { name: "Add a remote" })).toBeDisabled();
    expect(screen.getByRole("button", { name: 'Remove the "origin" remote' })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "Filter remotes" })).toBeDisabled();
  });

  it("closes through the explicit Close action", async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
