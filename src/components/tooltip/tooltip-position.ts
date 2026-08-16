import { margin, pointerTrackingHeight, titlebarGap } from "./tooltip-metrics";

/**
 * Whether the bubble follows the pointer instead of sitting at one of the trigger's edges.
 *
 * A tall trigger's edges can be most of a window away, which makes an edge-anchored bubble useless.
 * Exported so the rule can be asserted directly: gating this on width as well shipped a bug where a
 * full-height resizer's tooltip appeared in the toolbar.
 */
export function followsPointer(anchorHeight: number): boolean {
  return anchorHeight > pointerTrackingHeight;
}

/** Where a pointer-tracked bubble's top edge goes, clamped to the title bar and viewport bottom. */
export function pointerTrackedTop(
  pointerY: number | null,
  anchorTop: number,
  anchorHeight: number,
  bubbleHeight: number,
  viewportHeight: number,
): number {
  const targetY = pointerY ?? anchorTop + anchorHeight / 2;
  return Math.min(
    viewportHeight - bubbleHeight - margin,
    Math.max(titlebarGap, targetY - bubbleHeight / 2),
  );
}

export function horizontalAlignOffset(
  anchorLeft: number,
  anchorWidth: number,
  bubbleWidth: number,
  viewportWidth: number,
): number {
  const centred = anchorLeft + anchorWidth / 2 - bubbleWidth / 2;
  // `max` outermost so an over-wide bubble overflows to the *right*. Clamping the other way round
  // pushes its left edge off-screen, which loses the beginning of the sentence — the one failure
  // that makes a tooltip useless rather than merely awkward.
  const left = Math.max(margin, Math.min(viewportWidth - bubbleWidth - margin, centred));
  return left - anchorLeft;
}
