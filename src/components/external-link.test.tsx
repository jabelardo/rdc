import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalLink } from "./external-link";

const openExternal = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/platform/files", () => ({ openExternal }));

describe("ExternalLink", () => {
  beforeEach(() => {
    openExternal.mockClear();
  });

  it("hands the URL to the OS instead of navigating the webview", async () => {
    const user = userEvent.setup();
    render(<ExternalLink href="https://example.com/docs">Docs</ExternalLink>);

    const link = screen.getByRole("link", { name: "Docs" });
    // The href stays on the element so the role is `link` and the URL is inspectable.
    expect(link).toHaveAttribute("href", "https://example.com/docs");

    await user.click(link);

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("cancels the default navigation", () => {
    render(<ExternalLink href="https://example.com">Home</ExternalLink>);

    // Left uncancelled, jsdom logs "Not implemented: navigation" and a real webview would strand
    // the user in a page with no chrome to get back from.
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "Home" }).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
  });
});
