import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HorizontalResizer } from "./horizontal-resizer";

describe("HorizontalResizer", () => {
  afterEach(() => vi.useRealTimers());

  it("resizes by pointer and exposes bounded keyboard controls", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 356,
      height: 356,
      left: 0,
      right: 715,
      top: 0,
      width: 715,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const containerRef = createRef<HTMLElement>();
    containerRef.current = container;
    const onResize = vi.fn();

    render(
      <HorizontalResizer
        ariaLabel="Resize navigation sidebar"
        containerRef={containerRef}
        minimum={125}
        oppositeMinimum={490}
        value={190}
        onResize={onResize}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize navigation sidebar",
    });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(200);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith(125);

    fireEvent.keyDown(separator, { key: "End" });
    expect(onResize).toHaveBeenLastCalledWith(225);

    fireEvent.pointerDown(separator, { clientX: 190, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 210, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(210);
  });

  it("requires continued pressure past the minimum before invoking its boundary action", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 356,
      height: 356,
      left: 0,
      right: 715,
      top: 0,
      width: 715,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const containerRef = createRef<HTMLElement>();
    containerRef.current = container;
    const onMinimumHold = vi.fn();

    render(
      <HorizontalResizer
        ariaLabel="Resize navigation sidebar"
        containerRef={containerRef}
        minimum={125}
        oppositeMinimum={490}
        value={125}
        onResize={vi.fn()}
        onMinimumHold={onMinimumHold}
        minimumHoldDelay={350}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize navigation sidebar",
    });
    fireEvent.pointerDown(separator, { clientX: 125, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 115, pointerId: 1 });
    expect(separator).toHaveClass("is-resisting");
    vi.advanceTimersByTime(349);
    expect(onMinimumHold).not.toHaveBeenCalled();

    // Reversing back into the valid range cancels the pending collapse.
    fireEvent.pointerMove(separator, { clientX: 135, pointerId: 1 });
    expect(separator).not.toHaveClass("is-resisting");
    vi.advanceTimersByTime(1);
    expect(onMinimumHold).not.toHaveBeenCalled();

    fireEvent.pointerMove(separator, { clientX: 115, pointerId: 1 });
    vi.advanceTimersByTime(350);
    expect(onMinimumHold).toHaveBeenCalledOnce();
  });

  it("mirrors boundary resistance when pushing right from a collapsed width", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const containerRef = createRef<HTMLElement>();
    containerRef.current = container;
    const onMaximumHold = vi.fn();

    render(
      <HorizontalResizer
        ariaLabel="Expand navigation sidebar"
        containerRef={containerRef}
        minimum={52}
        maximum={52}
        oppositeMinimum={490}
        value={52}
        onResize={vi.fn()}
        onMaximumHold={onMaximumHold}
        maximumHoldDelay={350}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Expand navigation sidebar",
    });
    fireEvent.pointerDown(separator, { clientX: 52, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 62, pointerId: 1 });
    expect(separator).toHaveClass("is-resisting");
    vi.advanceTimersByTime(350);
    expect(onMaximumHold).toHaveBeenCalledOnce();
  });
});
