/**
 * The numbers that decide where a tooltip bubble sits.
 *
 * Their own module because both the component and the placement arithmetic need them, and the
 * arithmetic is separate precisely so it can be tested without a DOM — jsdom reports every rect as
 * zero, so the geometry can only be verified apart from the component that uses it.
 */

/** Distance between what is being cleared and the bubble. */
export const gap = 7;
/** Never position a bubble under the native title bar. */
export const titlebarGap = 36;
/** Keep a bubble off the viewport edges. */
export const margin = 8;
/** Above this trigger height, the bubble follows the pointer rather than the trigger's edge. */
export const pointerTrackingHeight = 100;
