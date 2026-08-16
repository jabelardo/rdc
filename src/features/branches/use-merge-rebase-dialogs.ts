import { useEffect, useState } from "react";
import type { MergeTreeResult } from "@/models/merge";
import type { MergeStrategy } from "@/models/merge-strategy";
import type { RebasePreview } from "@/models/rebase-preview";
import type {
  BranchState,
  BranchStore,
  MergeInitiationResult,
  RebaseInitiationResult,
} from "@/features/branches/stores/branch-store";
import { getMergedBranches } from "@/lib/ipc/branch-ipc";
import { determineMergeability } from "@/lib/ipc/misc-ipc";
import { getAheadBehind } from "@/lib/ipc/rev-list-ipc";
import { ComputedAction } from "@/models/computed-action";
import { revSymmetricDifference } from "@/utils/rev-range";

type MergeRebaseDialogsOptions = {
  readonly repositoryPath: string | null;
  readonly branchState: BranchState;
  readonly branchStore: BranchStore;
  /**
   * The preference the merge picker opens with.
   *
   * A callback rather than the preferences store, because a feature may not import another feature,
   * and a function rather than a value because the picker reads it each time it opens — the
   * preference can change in Preferences while the app runs.
   */
  readonly defaultMergeStrategy: () => MergeStrategy;
  /**
   * Whether the working tree has changes. Merging refuses on a dirty tree, and asking here rather
   * than importing the changes feature is what keeps the two apart — the app knows both.
   */
  readonly isWorkingTreeDirty: () => boolean;
  /**
   * Canned answers for Help → Show Dialog, or `null` outside a debug build.
   *
   * Mergeability and rebase distance are computed by Git from the repository, so a stub branch that
   * exists only in the renderer has no state at all and the dialogs cannot be reviewed from the
   * menu without these. Supplied by the app rather than imported: `testing/` composes features, so
   * a feature reaching into it inverts the direction.
   */
  readonly debugPreviews: {
    readonly mergePreview: (branchName: string) => {
      readonly status: MergeTreeResult;
      readonly commitCount: number;
    } | null;
    readonly rebasePreview: (branchName: string) => RebasePreview | null;
    /** `null` outside a debug build, so the real `--merged` call runs instead. */
    readonly mergedBranches: () => ReadonlyMap<string, string> | null;
  };
  readonly refreshAfterBranchChange: (mutate: () => Promise<boolean>) => Promise<boolean>;
};

/**
 * Merging and rebasing onto another branch.
 *
 * One hook for both because they are the same shape: a picker over candidate branches, an async
 * preview of what the operation would do, and a running state. Extracted from
 * `use-app-controller.ts`; renaming and deleting share none of that and live in their own hook.
 */
export function useMergeRebaseDialogs({
  repositoryPath,
  branchState,
  branchStore,
  defaultMergeStrategy,
  isWorkingTreeDirty,
  debugPreviews,
  refreshAfterBranchChange,
}: MergeRebaseDialogsOptions) {
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeMessage, setMergeMessage] = useState<string | null>(null);
  const [mergeRunning, setMergeRunning] = useState(false);
  // Seeded from the preference each time the dialog opens, not once at mount: the preference can
  // change in Preferences while the app runs, and the dialog should honour the current value.
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>(defaultMergeStrategy);
  const [mergeStatus, setMergeStatus] = useState<MergeTreeResult | null>(null);
  // Distinct from a status: "we could not work out whether this can merge" is not the same claim as
  // any ComputedAction, and collapsing it into one was reporting failures as "already up to date".
  const [mergePreviewError, setMergePreviewError] = useState<string | null>(null);
  // `git branch --merged`'s ref-to-SHA map for the current branch. One call on open, not one per
  // branch — and keeping the SHAs is what lets a remote branch on an already-merged commit be
  // recognised, since --merged itself reports only local refs.
  const [mergedBranches, setMergedBranches] = useState<ReadonlyMap<string, string>>(new Map());
  const [mergeCommitCount, setMergeCommitCount] = useState(0);
  const [rebasePickerOpen, setRebasePickerOpen] = useState(false);
  const [rebaseTarget, setRebaseTarget] = useState("");
  const [rebasePreview, setRebasePreview] = useState<RebasePreview | null>(null);
  const [rebaseRunning, setRebaseRunning] = useState(false);
  const [rebaseMessage, setRebaseMessage] = useState<string | null>(null);
  // Distinct from a preview: "we could not work out how far apart these branches are" is not the
  // same claim as any ComputedAction, and collapsing it into one reported failures as "up to date".
  const [rebasePreviewError, setRebasePreviewError] = useState<string | null>(null);

  // Selecting a different repository closes both pickers. Keyed on the path rather than the
  // Repository object, so a background refresh that replaces the object does not close them.
  useEffect(() => {
    setMergePickerOpen(false);
    setMergeTarget("");
    setMergeMessage(null);
    setMergeRunning(false);
    setMergeStatus(null);
    setMergePreviewError(null);
    setMergeCommitCount(0);
    setRebasePickerOpen(false);
    setRebaseTarget("");
    setRebasePreview(null);
    setRebaseRunning(false);
    setRebaseMessage(null);
    setRebasePreviewError(null);
  }, [repositoryPath]);

  useEffect(() => {
    if (!mergePickerOpen || mergeTarget === "") {
      setMergeStatus(null);
      setMergeCommitCount(0);
      setMergePreviewError(null);
      return;
    }

    // Stub branches exist only in the renderer, so git has nothing to compute from. Canned answers
    // keep every outcome reachable from Help -> Show Dialog, which is what that menu is for.
    {
      const preview = debugPreviews.mergePreview(mergeTarget);
      if (preview !== null) {
        setMergePreviewError(null);
        setMergeStatus(preview.status);
        setMergeCommitCount(preview.commitCount);
        return;
      }
    }

    if (repositoryPath === null) {
      return;
    }

    const currentBranch = branchState.currentBranch;
    if (currentBranch === null) {
      return;
    }

    let disposed = false;
    setMergePreviewError(null);
    setMergeStatus({ kind: ComputedAction.Loading });

    void determineMergeability(repositoryPath, currentBranch, mergeTarget)
      .then(async (status) => {
        if (disposed) return;
        if (status.kind === ComputedAction.Invalid) {
          setMergeStatus(status);
          return;
        }
        const range = revSymmetricDifference("", mergeTarget);
        const aheadBehind = await getAheadBehind(repositoryPath, range);
        if (disposed) return;
        setMergeCommitCount(aheadBehind ? aheadBehind.behind : 0);
        setMergeStatus(status);
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        // Previously this reported ComputedAction.Clean, which with a zero commit count rendered as
        // "<current> is already up to date with <branch>" — a confident, wrong statement about the
        // user's repository whenever the lookup merely failed. Say what actually happened instead,
        // and refuse the merge rather than starting one on an unverified assumption.
        log.error("Failed to determine mergeability", error instanceof Error ? error : undefined);
        setMergeStatus(null);
        setMergeCommitCount(0);
        setMergePreviewError("Could not determine whether these branches can be combined.");
      });

    return () => {
      disposed = true;
    };
  }, [mergePickerOpen, mergeTarget, repositoryPath, branchState.currentBranch, debugPreviews]);

  function requestMerge(): void {
    setMergeStrategy(defaultMergeStrategy());
    setMergeTarget("");
    setMergeMessage(null);
    setMergeStatus(null);
    setMergeCommitCount(0);
    setMergePreviewError(null);
    setMergedBranches(new Map());
    setMergePickerOpen(true);

    // Branches already contained in the current branch cannot produce a merge, so they are dropped
    // from the candidates rather than offered and then refused. One call, and a failure just means
    // nothing is filtered — the per-branch preview still catches it on selection.
    const stubbedMergedBranches = debugPreviews.mergedBranches();
    if (stubbedMergedBranches !== null) {
      setMergedBranches(stubbedMergedBranches);
      return;
    }

    const current = branchStore.state.currentBranch;
    if (repositoryPath !== null && current !== null) {
      void getMergedBranches(repositoryPath, current)
        .then(setMergedBranches)
        .catch((error: unknown) => {
          log.error("Failed to list merged branches", error instanceof Error ? error : undefined);
        });
    }
  }

  function mergeMessageFor(result: MergeInitiationResult, target: string): string {
    switch (result) {
      case "up-to-date":
        return `${target} is already up to date with the current branch.`;
      case "invalid":
        return "These branches do not share a common ancestor and cannot be merged.";
      case "dirty":
        return "Clean the working tree before merging.";
      case "failed":
        return "The merge failed.";
      case "merged":
      case "conflict":
        return "";
    }
  }

  async function confirmMerge(): Promise<void> {
    if (mergeTarget === "" || mergeRunning) {
      return;
    }
    setMergeRunning(true);
    setMergeMessage(null);
    const target = mergeTarget;
    const workingTreeDirty = isWorkingTreeDirty();
    try {
      const result = await branchStore.initiateMerge(target, {
        workingTreeDirty,
        squash: mergeStrategy === "squash",
      });
      if (result === "merged" || result === "conflict") {
        await refreshAfterBranchChange(() => Promise.resolve(true));
        setMergePickerOpen(false);
        return;
      }
      setMergeMessage(mergeMessageFor(result, target));
    } catch {
      setMergeMessage("The merge failed.");
    } finally {
      setMergeRunning(false);
    }
  }

  function cancelMerge(): void {
    if (mergeRunning) {
      return;
    }
    setMergePickerOpen(false);
    setMergeMessage(null);
    setMergeTarget("");
    setMergeStatus(null);
    setMergeCommitCount(0);
  }

  // Reactive rebase preview: when rebaseTarget changes, work out how far the current branch is
  // from the base, mirroring desktop-plus's updateRebasePreview. `ahead` is the current branch's
  // own commits (the ones a rebase replays); `behind` is the base's commits the current branch is
  // missing, and a rebase can only start when it is positive.
  useEffect(() => {
    if (!rebasePickerOpen || rebaseTarget === "") {
      setRebasePreview(null);
      setRebasePreviewError(null);
      return;
    }

    // Stub branches have no ancestry, so git has nothing to compute from. Canned answers keep
    // every outcome reachable from Help -> Show Dialog, which is what that menu is for.
    {
      const preview = debugPreviews.rebasePreview(rebaseTarget);
      if (preview !== null) {
        setRebasePreviewError(null);
        setRebasePreview(preview);
        return;
      }
    }

    const current = branchState.currentBranch;
    if (repositoryPath === null || current === null) {
      return;
    }

    let disposed = false;
    setRebasePreviewError(null);
    setRebasePreview({ kind: ComputedAction.Loading });
    void getAheadBehind(repositoryPath, revSymmetricDifference(current, rebaseTarget))
      .then((result) => {
        if (disposed) {
          return;
        }
        // A ref in the range vanished; desktop-plus treats the same case as Invalid.
        if (result === null) {
          setRebasePreview({ kind: ComputedAction.Invalid });
          return;
        }
        setRebasePreview({
          kind: ComputedAction.Clean,
          commitsAhead: result.ahead,
          commitsBehind: result.behind,
        });
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        log.error("Failed to preview rebase", error instanceof Error ? error : undefined);
        setRebasePreview(null);
        setRebasePreviewError("Could not determine whether these branches can be combined.");
      });

    return () => {
      disposed = true;
    };
  }, [rebasePickerOpen, rebaseTarget, repositoryPath, branchState.currentBranch, debugPreviews]);

  function requestRebase(): void {
    setRebaseTarget("");
    setRebaseMessage(null);
    setRebasePreview(null);
    setRebasePreviewError(null);
    setRebasePickerOpen(true);
  }

  function rebaseMessageFor(result: RebaseInitiationResult): string {
    switch (result) {
      case "completed":
        return "";
      case "conflict":
        // A rebase conflict writes .git/rebase-merge/, which rdc's conflict recovery (tracked on
        // mergeInProgress) does not see, so closing the dialog into that void would strand the user.
        // Stay openly in the dialog and state the boundary rather than pretend recovery exists.
        return "The rebase stopped on conflicts. Resolve them, then continue or abort the rebase from a terminal.";
      case "up-to-date":
        return "The current branch is already up to date with the selected base.";
      case "dirty":
        return "Clean the working tree before rebasing.";
      case "failed":
        return "The rebase failed.";
    }
  }

  async function confirmRebase(): Promise<void> {
    if (rebaseTarget === "" || rebaseRunning) {
      return;
    }
    setRebaseRunning(true);
    setRebaseMessage(null);
    const target = rebaseTarget;
    const workingTreeDirty = isWorkingTreeDirty();
    try {
      const result = await branchStore.rebaseBranch(target, { workingTreeDirty });
      if (result === "completed") {
        await refreshAfterBranchChange(() => Promise.resolve(true));
        setRebasePickerOpen(false);
        return;
      }
      setRebaseMessage(rebaseMessageFor(result));
    } catch {
      setRebaseMessage("The rebase failed.");
    } finally {
      setRebaseRunning(false);
    }
  }

  function cancelRebase(): void {
    if (rebaseRunning) {
      return;
    }
    setRebasePickerOpen(false);
    setRebaseMessage(null);
    setRebaseTarget("");
    setRebasePreview(null);
  }
  return {
    /** `null` while closed, so the dialog's state and its openness cannot disagree. */
    mergeDialog: !mergePickerOpen
      ? null
      : {
          target: mergeTarget,
          onTargetChange: setMergeTarget,
          message: mergeMessage,
          running: mergeRunning,
          status: mergeStatus,
          commitCount: mergeCommitCount,
          strategy: mergeStrategy,
          onStrategyChange: setMergeStrategy,
          previewError: mergePreviewError,
          mergedBranches,
          onConfirm: confirmMerge,
          onCancel: cancelMerge,
        },
    rebaseDialog: !rebasePickerOpen
      ? null
      : {
          target: rebaseTarget,
          onTargetChange: setRebaseTarget,
          message: rebaseMessage,
          running: rebaseRunning,
          preview: rebasePreview,
          previewError: rebasePreviewError,
          onConfirm: confirmRebase,
          onCancel: cancelRebase,
        },
    /** Opened from the Branch menu and the branch context menu. */
    requestMerge,
    requestRebase,
  };
}
