/**
 * Conflict state for multi-commit operations (rebase, cherry-pick, squash, …).
 *
 * Extracted verbatim from `desktop-plus/app/src/lib/app-state.ts` — see this directory's README.
 */

import { ManualConflictResolution } from "@/models/manual-conflict-resolution";

export type MultiCommitOperationConflictState = {
  readonly kind: "multiCommitOperation";

  /**
   * Manual resolutions chosen by the user for conflicted files to be applied
   * before continuing the operation
   */
  readonly manualResolutions: Map<string, ManualConflictResolution>;

  /**
   * Depending on the operation, this may be either source branch or the
   * target branch.
   *
   * Also, we may not know what it is. This usually happens if Desktop is closed
   * during an operation and the reopened and we lose some context that is
   * stored in state.
   */
  readonly ourBranch?: string;

  /**
   * Depending on the operation, this may be either source branch or the
   * target branch
   *
   * Also, we may not know what it is. This usually happens if Desktop is closed
   * during an operation and the reopened and we lose some context that is
   * stored in state.
   */
  readonly theirBranch?: string;
};
