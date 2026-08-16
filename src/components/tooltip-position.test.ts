import { describe, expect, it } from "vitest";
import { horizontalAlignOffset } from "./tooltip";

/**
 * The offset is relative to the anchor's left edge, so a bubble that lands at viewport x is
 * asserted as `x - anchorLeft`. These helpers keep the tests written in the terms that matter:
 * where the bubble's left edge ends up.
 */
const leftEdge = (anchorLeft: number, offset: number) => anchorLeft + offset;

const viewport = 1000;
const margin = 8;

describe("horizontalAlignOffset", () => {
  it("centres the bubble on its trigger when there is room", () => {
    const offset = horizontalAlignOffset(500, 20, 200, viewport);

    // Centred on 510 means a left edge at 410.
    expect(leftEdge(500, offset)).toBe(410);
  });

  /**
   * The reported bug. The resizer sits ~100px from the left with a ~380px bubble, so centring puts
   * the left edge at -90 and the first words render off-screen. Radix was discarding the clamp
   * because `alignOffset` is ignored unless the placement carries an alignment.
   */
  it("keeps the bubble on screen when its trigger is near the left edge", () => {
    const offset = horizontalAlignOffset(100, 6, 380, viewport);

    expect(leftEdge(100, offset)).toBe(margin);
  });

  it("keeps the bubble on screen when its trigger is near the right edge", () => {
    const offset = horizontalAlignOffset(960, 20, 380, viewport);

    expect(leftEdge(960, offset) + 380).toBe(viewport - margin);
  });

  /**
   * A bubble wider than the viewport has to overflow somewhere. It overflows right, so the sentence
   * still starts where a reader looks — clamping the other way round loses the first words, which
   * is the difference between an awkward tooltip and a useless one.
   */
  it("prefers overflowing right when the bubble cannot fit at all", () => {
    const offset = horizontalAlignOffset(400, 20, 1200, viewport);

    expect(leftEdge(400, offset)).toBe(margin);
  });

  it("is a no-op offset when the centred position already respects both margins", () => {
    const offset = horizontalAlignOffset(400, 100, 100, viewport);

    // The anchor's centre is 450 and the bubble is 100 wide, so its left edge lands on 400 — the
    // anchor's own left edge, making the offset zero for a bubble as wide as its trigger.
    expect(leftEdge(400, offset)).toBe(400);
    expect(offset).toBe(0);
  });
});
