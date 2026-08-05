import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualList } from "./virtual-list";

const items = Array.from({ length: 1_000 }, (_, index) => ({
  id: `item-${index}`,
  label: `Item ${index}`,
}));

describe("VirtualList", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 480,
      height: 480,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a representative thousand-row list below a bounded DOM surface", async () => {
    render(
      <VirtualList
        ariaLabel="Large list"
        className="large-list"
        estimateSize={() => 40}
        getItemKey={(item) => item.id}
        items={items}
      >
        {(item, index, row) => (
          <li ref={row.measureElement} data-index={row.virtualIndex} style={row.style}>
            <button type="button" data-keyboard-list-item data-keyboard-list-index={index}>
              {item.label}
            </button>
          </li>
        )}
      </VirtualList>,
    );

    const list = screen.getByRole("list", { name: "Large list" });
    expect(list).toHaveAttribute("data-virtualized", "true");
    await screen.findByText("Item 0");
    expect(screen.getAllByRole("listitem").length).toBeLessThan(40);
    expect(screen.getByText("Item 0")).toBeInTheDocument();
    expect(screen.queryByText("Item 999")).not.toBeInTheDocument();
  });

  it("renders a small list completely without windowing it", () => {
    render(
      <VirtualList
        ariaLabel="Small list"
        className="small-list"
        estimateSize={() => 40}
        getItemKey={(item) => item.id}
        items={items.slice(0, 3)}
      >
        {(item, index, row) => (
          <li ref={row.measureElement} data-index={row.virtualIndex} style={row.style}>
            <button type="button" data-keyboard-list-item data-keyboard-list-index={index}>
              {item.label}
            </button>
          </li>
        )}
      </VirtualList>,
    );

    const list = screen.getByRole("list", { name: "Small list" });
    expect(list).toHaveAttribute("data-virtualized", "false");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
