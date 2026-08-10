import { BranchType, type Branch } from "../../models/branch";
import { ComputedAction } from "../../models/computed-action";
import type { ICheckoutProgress, IMultiCommitOperationProgress } from "../../models/progress";
import type { IRemote } from "../../models/remote";
import { getBranches } from "../branch-ipc";
import {
  checkoutBranch,
  getStatus,
  mergeBranch,
  MergeResult,
  rebaseBranch as rebaseBranchCommand,
  RebaseResult,
  type IStatusResult,
} from "../git-ipc";
import {
  createBranch,
  deleteLocalBranch,
  deleteRef,
  renameBranch as renameBranchCommand,
} from "../branch-ipc";
import { determineMergeability, getRecentBranches } from "../misc-ipc";
import { getRemoteHEAD, getRemotes } from "../remote-ipc";
import { testForInvalidChars } from "../sanitize-ref-name";

export type BranchOperation =
  | "creating"
  | "checking-out"
  | "renaming"
  | "deleting"
  | "merging"
  | "rebasing";

/** The outcome of an in-app merge initiation. */
export type MergeInitiationResult =
  | "up-to-date"
  | "merged"
  | "conflict"
  | "invalid"
  | "dirty"
  | "failed";

/** The outcome of an in-app rebase initiation. */
export type RebaseInitiationResult = "completed" | "conflict" | "up-to-date" | "dirty" | "failed";

export type BranchState = {
  readonly repositoryPath: string | null;
  readonly branches: ReadonlyArray<Branch>;
  readonly currentBranch: string | null;
  readonly defaultBranch: string | null;
  readonly recentBranches: ReadonlyArray<string>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly operation: BranchOperation | null;
  readonly progress: ICheckoutProgress | IMultiCommitOperationProgress | null;
  readonly operationError: string | null;
};

type BranchFactsStatus = Pick<IStatusResult, "currentBranch">;

type BranchStoreDependencies = {
  readonly getBranches: (repositoryPath: string) => Promise<ReadonlyArray<Branch>>;
  readonly getStatus: (
    repositoryPath: string,
    listUntrackedFilesIndividually: boolean,
  ) => Promise<BranchFactsStatus | null>;
  readonly getRecentBranches: typeof getRecentBranches;
  readonly getRemotes: typeof getRemotes;
  readonly getRemoteHEAD: typeof getRemoteHEAD;
  readonly createBranch: typeof createBranch;
  readonly checkoutBranch: typeof checkoutBranch;
  readonly renameBranch: typeof renameBranchCommand;
  readonly deleteLocalBranch: typeof deleteLocalBranch;
  readonly deleteRef: typeof deleteRef;
  readonly determineMergeability: typeof determineMergeability;
  readonly mergeBranch: typeof mergeBranch;
  readonly rebaseBranch: typeof rebaseBranchCommand;
};

const defaultDependencies: BranchStoreDependencies = {
  getBranches,
  getStatus,
  getRecentBranches,
  getRemotes,
  getRemoteHEAD,
  createBranch,
  checkoutBranch,
  renameBranch: renameBranchCommand,
  deleteLocalBranch,
  deleteRef,
  determineMergeability,
  mergeBranch,
  rebaseBranch: rebaseBranchCommand,
};

const EmptyState: BranchState = {
  repositoryPath: null,
  branches: [],
  currentBranch: null,
  defaultBranch: null,
  recentBranches: [],
  loading: false,
  error: null,
  operation: null,
  progress: null,
  operationError: null,
};

function findDefaultLocalBranch(
  branches: ReadonlyArray<Branch>,
  remoteName: string | null,
  remoteHead: string | null,
): string | null {
  if (remoteName === null || remoteHead === null) {
    return null;
  }

  const upstream = `${remoteName}/${remoteHead}`;
  const tracking = branches.filter(
    (branch) => branch.type === BranchType.Local && branch.upstream === upstream,
  );
  return (
    tracking.find((branch) => branch.name === remoteHead)?.name ??
    tracking[0]?.name ??
    branches.find((branch) => branch.type === BranchType.Local && branch.name === remoteHead)
      ?.name ??
    null
  );
}

/**
 * Owns the minimum Phase 7c branch workflow.
 *
 * Git owns branch validity and checkout mechanics. This store owns the
 * user-level create-then-checkout sequence and refreshes both refs and HEAD
 * afterwards so the UI never infers the current branch from branch ordering.
 */
export class BranchStore {
  private currentState = EmptyState;
  private requestID = 0;
  private operationID = 0;
  private readonly dependencies: BranchStoreDependencies;
  private readonly listeners = new Set<(state: BranchState) => void>();

  public constructor(dependencies: Partial<BranchStoreDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public get state(): BranchState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: BranchState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(repositoryPath: string): Promise<void> {
    const requestID = ++this.requestID;
    this.operationID++;
    this.update({
      repositoryPath,
      branches: [],
      currentBranch: null,
      defaultBranch: null,
      recentBranches: [],
      loading: true,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    });

    try {
      const facts = await this.loadFacts(repositoryPath);
      if (requestID !== this.requestID) {
        return;
      }
      this.update({
        repositoryPath,
        ...facts,
        loading: false,
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      });
    } catch (error) {
      if (requestID !== this.requestID) {
        return;
      }
      this.update({
        repositoryPath,
        branches: [],
        currentBranch: null,
        defaultBranch: null,
        recentBranches: [],
        loading: false,
        error: String(error),
        operation: null,
        progress: null,
        operationError: null,
      });
    }
  }

  public async createAndCheckout(name: string): Promise<boolean> {
    const branchName = name.trim();
    if (branchName.length === 0) {
      this.update({
        ...this.currentState,
        operationError: "Enter a branch name.",
      });
      return false;
    }
    const repositoryPath = this.currentState.repositoryPath;
    if (repositoryPath === null) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "creating",
      progress: null,
      operationError: null,
    });
    try {
      await this.dependencies.createBranch(repositoryPath, branchName, undefined, false);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
        operation: "checking-out",
      });
      await this.dependencies.checkoutBranch(repositoryPath, branchName, (progress) =>
        this.publishProgress(requestID, operationID, progress),
      );
      return await this.finishOperation(repositoryPath, requestID, operationID);
    } catch (error) {
      return this.failOperation(requestID, operationID, error);
    }
  }

  public async checkout(name: string): Promise<boolean> {
    const branch = this.currentState.branches.find((branch) => branch.name === name);
    if (
      branch === undefined ||
      branch.type !== BranchType.Local ||
      branch.name === this.currentState.currentBranch ||
      this.currentState.repositoryPath === null
    ) {
      return false;
    }

    const repositoryPath = this.currentState.repositoryPath;
    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "checking-out",
      progress: null,
      operationError: null,
    });
    try {
      await this.dependencies.checkoutBranch(repositoryPath, branch.name, (progress) =>
        this.publishProgress(requestID, operationID, progress),
      );
      return await this.finishOperation(repositoryPath, requestID, operationID);
    } catch (error) {
      return this.failOperation(requestID, operationID, error);
    }
  }

  /**
   * Renames a local branch, preserving its upstream (git's `branch -m` keeps the
   * upstream pointing at the remote branch under its old name).
   *
   * The new name is validated with git's check-ref-format rules and rejected on
   * collision with an existing branch, so the failure surfaces as a product
   * message rather than a raw git error.
   */
  public async renameBranch(currentName: string, newName: string): Promise<boolean> {
    const repositoryPath = this.currentState.repositoryPath;
    const branch = this.currentState.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === currentName,
    );
    if (repositoryPath === null || branch === undefined) {
      return false;
    }
    const target = newName.trim();
    if (target.length === 0) {
      this.update({
        ...this.currentState,
        operationError: "Enter a branch name.",
      });
      return false;
    }
    if (testForInvalidChars(target)) {
      this.update({
        ...this.currentState,
        operationError: `'${target}' is not a valid branch name.`,
      });
      return false;
    }
    // A case-only rename is legitimate, so the collision check excludes the branch
    // being renamed itself.
    const collision = this.currentState.branches.some(
      (branch) => branch.name.toLowerCase() === target.toLowerCase() && branch.name !== currentName,
    );
    if (collision) {
      this.update({
        ...this.currentState,
        operationError: `A branch named '${target}' already exists.`,
      });
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "renaming",
      progress: null,
      operationError: null,
    });
    try {
      await this.dependencies.renameBranch(repositoryPath, currentName, target, undefined);
      return await this.finishOperation(repositoryPath, requestID, operationID);
    } catch (error) {
      return this.failOperation(requestID, operationID, error);
    }
  }

  /**
   * Deletes a local branch (`git branch -D`) that is not the current, default or
   * unborn/detached one, optionally pruning its remote-tracking ref.
   *
   * Deleting the remote branch is out of MVP scope and stays separate; pruning
   * removes only the local `refs/remotes/<remote>/<branch>` record, never the
   * remote itself.
   */
  public async deleteBranch(
    branchName: string,
    options: { readonly pruneTrackingRef?: boolean } = {},
  ): Promise<boolean> {
    const repositoryPath = this.currentState.repositoryPath;
    const branch = this.currentState.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === branchName,
    );
    if (repositoryPath === null || branch === undefined) {
      return false;
    }
    const { currentBranch, defaultBranch } = this.currentState;
    if (branch.name === currentBranch) {
      this.update({
        ...this.currentState,
        operationError: `You cannot delete the current branch '${branch.name}'.`,
      });
      return false;
    }
    if (currentBranch === null) {
      this.update({
        ...this.currentState,
        operationError: "You cannot delete a branch while on an unborn or detached HEAD.",
      });
      return false;
    }
    if (branch.name === defaultBranch) {
      this.update({
        ...this.currentState,
        operationError: `You cannot delete the default branch '${branch.name}'.`,
      });
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "deleting",
      progress: null,
      operationError: null,
    });
    try {
      await this.dependencies.deleteLocalBranch(repositoryPath, branch.name);
      if (options.pruneTrackingRef && branch.upstream !== null) {
        await this.dependencies.deleteRef(repositoryPath, `refs/remotes/${branch.upstream}`);
      }
      return await this.finishOperation(repositoryPath, requestID, operationID);
    } catch (error) {
      return this.failOperation(requestID, operationID, error);
    }
  }

  /**
   * Merges a local branch into the current one.
   *
   * The mergeability of the two branches is asked first with `merge-tree` (no side
   * effects), which also reports unrelated histories as `invalid`. A dirty working
   * tree is refused up front: git will not merge over uncommitted changes, and the
   * caller's menu is already disabled in that state, so this is the store-level
   * guard that keeps the precondition honest.
   *
   * A merge that produces conflicts (`MergeResult.Failed`) returns `conflict`, and
   * the caller hands off to the conflict-recovery surface — `ConflictStore` reads
   * `mergeHeadFound` on its next load, which is exactly what drives that UI.
   */
  public async initiateMerge(
    targetBranchName: string,
    options: { readonly workingTreeDirty: boolean; readonly squash?: boolean },
  ): Promise<MergeInitiationResult> {
    const repositoryPath = this.currentState.repositoryPath;
    const current = this.currentState.currentBranch;
    const target = this.currentState.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === targetBranchName,
    );
    if (
      repositoryPath === null ||
      target === undefined ||
      current === null ||
      current === targetBranchName
    ) {
      return "failed";
    }
    if (options.workingTreeDirty) {
      return "dirty";
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "merging",
      progress: null,
      operationError: null,
    });
    try {
      const mergeability = await this.dependencies.determineMergeability(
        repositoryPath,
        current,
        targetBranchName,
      );
      if (!this.isCurrentOperation(requestID, operationID)) {
        return "failed";
      }
      if (mergeability.kind === ComputedAction.Invalid) {
        this.finishWithoutRefresh(requestID, operationID);
        return "invalid";
      }

      // `squash` is not a second operation: git-ops' merge() runs `git merge --squash` and then
      // `git commit --no-edit` under the commit hooks, so the result shape is identical.
      const result = await this.dependencies.mergeBranch(repositoryPath, targetBranchName, {
        squash: options.squash === true,
      });
      await this.finishOperation(repositoryPath, requestID, operationID);
      switch (result) {
        case MergeResult.Success:
          return "merged";
        case MergeResult.AlreadyUpToDate:
          return "up-to-date";
        case MergeResult.Failed:
          return "conflict";
      }
    } catch (error) {
      this.failOperation(requestID, operationID, error);
      return "failed";
    }
  }

  /**
   * Rebases the current branch onto `baseBranchName` (`git rebase <base> <current>`).
   *
   * Mirrors `initiateMerge`'s shape, including the dirty-tree guard (git refuses to rebase with
   * uncommitted changes) and the `finishOperation` reload. Rebase conflicts are reported, not
   * auto-resolved: rdc's conflict recovery tracks only `mergeInProgress`, so a rebase conflict
   * (which writes `.git/rebase-merge/`) is surfaced to the caller rather than silently handed off
   * to the merge-conflict surface that cannot see it.
   */
  public async rebaseBranch(
    baseBranchName: string,
    options: { readonly workingTreeDirty: boolean },
  ): Promise<RebaseInitiationResult> {
    const repositoryPath = this.currentState.repositoryPath;
    const current = this.currentState.currentBranch;
    const base = this.currentState.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === baseBranchName,
    );
    if (repositoryPath === null || base === undefined || current === null) {
      return "failed";
    }
    if (options.workingTreeDirty) {
      return "dirty";
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "rebasing",
      progress: null,
      operationError: null,
    });
    try {
      const result = await this.dependencies.rebaseBranch(
        repositoryPath,
        baseBranchName,
        current,
        (progress) => this.publishRebaseProgress(requestID, operationID, progress),
      );
      await this.finishOperation(repositoryPath, requestID, operationID);
      switch (result) {
        case RebaseResult.CompletedWithoutError:
          return "completed";
        case RebaseResult.ConflictsEncountered:
          return "conflict";
        case RebaseResult.AlreadyUpToDate:
          return "up-to-date";
        default:
          return "failed";
      }
    } catch (error) {
      this.failOperation(requestID, operationID, error);
      return "failed";
    }
  }

  private finishWithoutRefresh(requestID: number, operationID: number): void {
    if (this.isCurrentOperation(requestID, operationID)) {
      this.update({
        ...this.currentState,
        operation: null,
        progress: null,
        operationError: null,
      });
    }
  }

  public clear(): void {
    this.requestID++;
    this.operationID++;
    this.update(EmptyState);
  }

  private async loadFacts(repositoryPath: string) {
    const [branches, status, recentBranches, remotes] = await Promise.all([
      this.dependencies.getBranches(repositoryPath),
      this.dependencies.getStatus(repositoryPath, true),
      this.dependencies
        .getRecentBranches(repositoryPath, 6)
        .catch(() => [] as ReadonlyArray<string>),
      this.dependencies.getRemotes(repositoryPath).catch(() => [] as ReadonlyArray<IRemote>),
    ]);
    const currentBranch = status?.currentBranch ?? null;
    const current = branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === currentBranch,
    );
    const defaultRemote =
      remotes.find((remote) => remote.name === current?.upstreamRemoteName) ??
      remotes.find((remote) => remote.name === "origin") ??
      remotes[0] ??
      null;
    const remoteHead =
      defaultRemote === null
        ? null
        : await this.dependencies
            .getRemoteHEAD(repositoryPath, defaultRemote.name)
            .catch(() => null);
    const defaultBranch = findDefaultLocalBranch(branches, defaultRemote?.name ?? null, remoteHead);

    return {
      branches,
      currentBranch,
      defaultBranch,
      recentBranches,
    };
  }

  private async finishOperation(
    repositoryPath: string,
    requestID: number,
    operationID: number,
  ): Promise<boolean> {
    const facts = await this.loadFacts(repositoryPath);
    if (!this.isCurrentOperation(requestID, operationID)) {
      return false;
    }
    this.update({
      repositoryPath,
      ...facts,
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    });
    return true;
  }

  private failOperation(requestID: number, operationID: number, error: unknown): false {
    if (this.isCurrentOperation(requestID, operationID)) {
      this.update({
        ...this.currentState,
        operation: null,
        progress: null,
        operationError: String(error),
      });
    }
    return false;
  }

  private publishProgress(
    requestID: number,
    operationID: number,
    progress: ICheckoutProgress,
  ): void {
    if (this.isCurrentOperation(requestID, operationID)) {
      this.update({ ...this.currentState, progress });
    }
  }

  private publishRebaseProgress(
    requestID: number,
    operationID: number,
    progress: IMultiCommitOperationProgress,
  ): void {
    if (this.isCurrentOperation(requestID, operationID)) {
      this.update({ ...this.currentState, progress });
    }
  }

  private isCurrentOperation(requestID: number, operationID: number): boolean {
    return requestID === this.requestID && operationID === this.operationID;
  }

  private update(state: BranchState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
