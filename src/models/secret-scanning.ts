/**
 * Secret-scanning / push-protection domain types.
 *
 * MIGRATION NOTE (layering fix): in desktop-plus these lived inside the React
 * component `ui/secret-scanning/bypass-push-protection-dialog.tsx`, which meant
 * `lib/api.ts` — the GitHub API client — imported a UI component just to name
 * this type. That single edge transitively pulled the entire UI tree (120
 * files) into anything importing the API client, including unit tests.
 *
 * These are GitHub API wire values, not view concerns, so they belong in
 * `models/`. The dialog should import them from here when the UI is ported in
 * Phase 7. `ISecretScanResult` (currently in
 * `ui/secret-scanning/push-protection-error-dialog.tsx`) belongs here too and
 * should be moved at that point.
 */

/** The reason a user gives for bypassing push protection. */
export enum BypassReason {
  FalsePositive = 'false_positive',
  UsedInTests = 'used_in_tests',
  WillFixLater = 'will_fix_later',
}

export type BypassReasonType =
  | BypassReason.FalsePositive
  | BypassReason.UsedInTests
  | BypassReason.WillFixLater
