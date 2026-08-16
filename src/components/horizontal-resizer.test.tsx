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

describe("HorizontalResizer focus", () => {
  function renderResizer(onResize = vi.fn()) {
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
    render(
      <HorizontalResizer
        ariaLabel="Resize navigation sidebar"
        containerRef={containerRef}
        minimum={125}
        oppositeMinimum={200}
        value={250}
        onResize={onResize}
      />,
    );
    return { separator: screen.getByRole("separator"), onResize };
  }

  /**
   * The bug this exists for: the keyboard handler was always correct, and arrow keys still did
   * nothing in the app, because `onPointerDown` calls `preventDefault()` — which suppresses the
   * default focus that a press would otherwise give the element. Every existing keyboard test used
   * `fireEvent.keyDown(separator)`, which dispatches straight at the node and cannot tell a focused
   * element from an unfocused one, so all of them passed while the control was unusable.
   */
  it("takes focus when pressed, so the arrow keys it advertises actually reach it", () => {
    const { separator } = renderResizer();

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 250 });

    expect(document.activeElement).toBe(separator);
  });

  it("resizes from the keyboard after a press, without an intervening Tab", () => {
    const { separator, onResize } = renderResizer();

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(separator, { pointerId: 1 });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });

    expect(onResize).toHaveBeenCalledWith(260);
  });
});

describe("HorizontalResizer tooltip", () => {
  function renderResizer() {
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
    render(
      <HorizontalResizer
        ariaLabel="Resize navigation sidebar"
        containerRef={containerRef}
        minimum={125}
        oppositeMinimum={200}
        value={250}
        onResize={vi.fn()}
      />,
    );
    return screen.getByRole("separator");
  }

  const bubble = () => screen.queryByText(/Drag or use the arrow keys/);

  /**
   * The bubble used to appear the instant the pointer touched the bar and then follow it down the
   * drag, which is the worst possible place for it on a control you are aiming at. It belongs to
   * hover; a press means the user has stopped asking what the control is.
   */
  it("stays shut while the bar is being pressed and dragged", () => {
    const separator = renderResizer();

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 250 });
    expect(bubble()).not.toBeInTheDocument();

    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 320 });
    expect(bubble()).not.toBeInTheDocument();
  });

  /**
   * Specifically the focus path. Radix opens a tooltip on focus and skips it only when its own
   * pointer-down flag is already set — and it runs the caller's handler first, so the resizer's
   * explicit `focus()` beats the flag. Without suppression, the fix for the arrow keys would have
   * introduced a bubble on every click.
   */
  it("does not open merely because pressing it moved focus there", () => {
    const separator = renderResizer();

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 250 });

    expect(document.activeElement).toBe(separator);
    expect(bubble()).not.toBeInTheDocument();
  });

  it("stays shut immediately after the drag ends, so the next hover starts its delay afresh", () => {
    const separator = renderResizer();

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(separator, { pointerId: 1 });

    expect(bubble()).not.toBeInTheDocument();
  });
});
