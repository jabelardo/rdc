/**
 * A numeric value with bounds, used for resizable pane widths.
 *
 * Extracted verbatim from `desktop-plus/app/src/lib/app-state.ts` — see this directory's README.
 */

/**
 * An interface for describing a desired value and a valid range
 *
 * Note that the value can be greater than `max` or less than `min`, it's
 * an indication of the desired value. The real value needs to be validated
 * or coerced using a function like `clamp`.
 *
 * Yeah this is a terrible name.
 */
export interface IConstrainedValue {
  readonly value: number
  readonly max: number
  readonly min: number
}
