import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissAllTooltips, Tooltip } from "./tooltip";

// jsdom reports every rect as zero, so the geometry under test has to be supplied. Illustrative
// numbers, not measurements: a bar whose centred control leaves bottom slack larger than the 7px
// gap, which is the case this boundary logic exists for.
//
// Worth knowing, because it was originally misread: the 1.95px the visual E2E once reported was
// *not* bar padding. It was `tooltip-appear` held at `translateY(-0.15rem)` while a stray
// `opacity: 1 !important` kept the bubble visible through the animation delay. That is fixed in
// App.css. This boundary behaviour is a separate, deliberate choice — clearance from the bar reads
// better than a bubble abutting its bottom rule — and these tests pin it on its own terms.
const barRect = {
  top: 40,
  bottom: 68.25,
  left: 0,
  right: 400,
  width: 400,
  height: 28.25,
};
const triggerRect = {
  top: 46,
  bottom: 59.3,
  left: 10,
  right: 34,
  width: 24,
  height: 13.3,
};
const bubbleRect = {
  top: 0,
  bottom: 20,
  left: 0,
  right: 120,
  width: 120,
  height: 20,
};

// Radix measures the viewport to decide whether the bubble collides with it; the hand-rolled
// implementation only read `window.innerWidth/innerHeight`, so the stub never had to describe one.
// Without this, every ancestor reports the trigger's rect and the "viewport" is 24x13 px, so
// collision handling clamps every position.
const viewportRect = {
  top: 0,
  bottom: 768,
  left: 0,
  right: 1024,
  width: 1024,
  height: 768,
};

function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const source = this.classList.contains("app-tooltip")
      ? bubbleRect
      : this.hasAttribute("data-tooltip-boundary")
        ? barRect
        : this === document.documentElement || this === document.body
          ? viewportRect
          : triggerRect;
    return { ...source, x: source.left, y: source.top, toJSON: () => source };
  });
}

/**
 * The bubble's distance from the top of the viewport.
 *
 * Radix positions with a `transform` on its popper wrapper rather than `top` on the bubble, so the
 * value is read from there. It also rounds to whole pixels, which is why these expectations are a
 * quarter-pixel below what the hand-rolled implementation wrote — re-derived from the same stubbed
 * rects during `UI_FOUNDATION_PLAN.md` sub-slice 3.0, not relaxed.
 */
function bubbleTop() {
  const wrapper = screen
    .getByRole("tooltip")
    .closest("[data-radix-popper-content-wrapper]") as HTMLElement | null;
  const match = /translate(?:3d)?\([^,]+,\s*([^,)]+)/.exec(wrapper?.style.transform ?? "");
  return match?.[1]?.trim() ?? "(not positioned)";
}

/** The bubble's distance from the left of the viewport, read the same way as `bubbleTop`. */
function bubbleLeft() {
  const wrapper = screen
    .getByRole("tooltip")
    .closest("[data-radix-popper-content-wrapper]") as HTMLElement | null;
  const match = /translate(?:3d)?\(([^,]+)/.exec(wrapper?.style.transform ?? "");
  return match?.[1]?.trim() ?? "(not positioned)";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tooltip", () => {
  it("clears the whole command bar when its trigger sits inside one", async () => {
    stubRects();
    render(
      <div data-tooltip-boundary="">
        <Tooltip label="Fetch">
          <button type="button">Fetch</button>
        </Tooltip>
      </div>,
    );

    await userEvent.hover(screen.getByRole("button", { name: "Fetch" }));

    // The bar's bottom plus the 7px gap, rather than the button's bottom plus the same gap, which
    // would put the bubble inside the bar's lower padding. 75 rather than 75.25 because Radix
    // rounds; the derivation is unchanged.
    expect(bubbleTop()).toBe("75px");
  });

  it("clears only the trigger when there is no boundary", async () => {
    stubRects();
    render(
      <Tooltip label="Fetch">
        <button type="button">Fetch</button>
      </Tooltip>,
    );

    await userEvent.hover(screen.getByRole("button", { name: "Fetch" }));

    expect(bubbleTop()).toBe("66px");
  });

  it("describes its trigger while open", async () => {
    stubRects();
    render(
      <Tooltip label="Fetch">
        <button type="button">Fetch</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Fetch" });

    expect(trigger.getAttribute("aria-describedby")).toBeNull();

    await userEvent.hover(trigger);

    expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  });

  // Regression coverage for the macOS report: hovering a row's "more actions" button, then
  // clicking it to open a native context menu, left the tooltip visible behind the menu. Neither
  // `onBlur` fires — WebKit does not focus a <button> on an ordinary mouse click — nor does
  // `onMouseLeave`, since the native menu then owns the pointer. `dismissAllTooltips` is the only
  // path that closes it in that sequence, so this asserts closing it *without* touching either
  // event.
  it("closes on dismissAllTooltips without a blur or mouseleave event", async () => {
    stubRects();
    render(
      <Tooltip label="More actions for popular">
        <button type="button">More actions</button>
      </Tooltip>,
    );

    await userEvent.hover(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    // `dismissAllTooltips` is called from plain application code (a controller function, not a
    // simulated DOM event), so the resulting `setOpen(false)` needs `act` to flush here — the
    // event wrappers above do that automatically.
    act(() => {
      dismissAllTooltips();
    });

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("stops calling a tooltip once it unmounts", async () => {
    stubRects();
    const { unmount } = render(
      <Tooltip label="More actions">
        <button type="button">More actions</button>
      </Tooltip>,
    );

    await userEvent.hover(screen.getByRole("button", { name: "More actions" }));
    unmount();

    // Must not throw by calling a hide function whose component is gone.
    expect(() => dismissAllTooltips()).not.toThrow();
  });

  /**
   * The bubble was positioned as though it had no width — on every showing, not just reopened ones.
   *
   * `onOpenChange` repositions the moment the tooltip opens, before Radix has mounted the content,
   * so `contentRef` is null and the measurement is 0x0. That set `placement` to a non-null value,
   * and the content ref then declined to re-measure because it only did so while `placement` was
   * null. The second pass the two-pass design depends on never ran: instrumenting `measure` showed
   * exactly one call, with `width: 0`.
   *
   * A zero-width bubble centres on nothing, so its left edge lands on the trigger's centre and it
   * extends right. Invisible until a trigger sits near the right edge — the Manage remotes delete
   * buttons — where the bubble then runs off the window. The vertical assertions above never caught
   * it because the "below" placement does not depend on the bubble's height.
   */
  it("centres the bubble on its trigger, which needs the bubble's real width", async () => {
    stubRects();
    render(
      <Tooltip label="Remove the upstream remote">
        <button type="button">Remove</button>
      </Tooltip>,
    );

    await userEvent.hover(screen.getByRole("button", { name: "Remove" }));

    // The stubbed trigger spans 10..34, so its centre is 22, and the stubbed bubble is 120 wide:
    // centred it would start at -38, which clamps to the 8px viewport margin. Measured as
    // zero-width it starts on the trigger's centre instead, which is the 22px this used to report.
    expect(bubbleLeft()).toBe("8px");
  });
});
