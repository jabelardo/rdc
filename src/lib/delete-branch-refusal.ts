/**
 * Why a branch cannot be deleted, or `null` when it can be.
 *
 * Extracted from the controller so the debug entry that previews the refusal notice shows the
 * wording the app really produces. The notice is otherwise unreachable from Help → Show Dialog —
 * the delete entry deletes a branch that *can* be deleted — and a second copy of user-facing copy
 * written just for the preview is a copy that drifts from the one users see.
 */
export function deleteBranchRefusal(
  branchName: string,
  currentBranch: string | null,
  defaultBranch: string | null,
): string | null {
  if (branchName === currentBranch) {
    return `You cannot delete the current branch '${branchName}'.`;
  }
  if (branchName === defaultBranch) {
    return `You cannot delete the default branch '${branchName}'.`;
  }
  return null;
}
