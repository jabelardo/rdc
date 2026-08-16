import { BranchType, type Branch, type ITrackingBranch } from "@/models/branch";
import type { IFetchProgress, IPullProgress, IPushProgress } from "@/models/progress";
import type { IRemote } from "@/models/remote";
import type { OperationRecord } from "@/models/operation";
import { getBranches, getBranchesDifferingFromUpstream } from "@/features/branches/api/branch-ipc";
import { getStatus, type IStatusResult } from "@/lib/ipc/git-ipc";
import { describeError, reportErrorMessage } from "@/utils/format-error";
import { describeRemoteError } from "@/features/remotes/remote-error";
import {
  addRemote as addRemoteCommand,
  fastForwardBranches,
  fetch as fetchRemote,
  fetchWorkflow as fetchWorkflowRemote,
  getRemotes,
  pull as pullRemote,
  push as pushRemote,
  removeRemote as removeRemoteCommand,
  updateRemoteHEAD,
} from "@/features/remotes/api/remote-ipc";

export type RemoteOperation = "fetch" | "pull" | "push";

export type RemoteState = {
  readonly repositoryPath: string | null;
  readonly remotes: ReadonlyArray<IRemote>;
  readonly currentRemote: IRemote | null;
  readonly currentBranch: Branch | null;
  readonly loading: boolean;
  /**
   * Add/Remove Remote failure text, for the Manage Remotes dialog only.
   *
   * Not a second error channel by accident: where an in-dialog failure belongs is an open decision
   * in MESSAGE_SYSTEM_PLAN.md that blocks its Slice 1, and the interim rule is that dialogs keep
   * their failure inline. Transport and load failures do go to the message system; when that
   * decision is settled this field goes with it.
   */
  readonly managementError: string | null;
};

type RemoteFactsStatus = Pick<IStatusResult, "currentBranch">;

type RemoteStoreDependencies = {
  readonly getRemotes: (repositoryPath: string) => Promise<ReadonlyArray<IRemote>>;
  readonly getBranches: (repositoryPath: string) => Promise<ReadonlyArray<Branch>>;
  readonly getStatus: (
    repositoryPath: string,
    listUntrackedFilesIndividually: boolean,
  ) => Promise<RemoteFactsStatus | null>;
  readonly fetch: (
    repositoryPath: string,
    remoteName: string,
    progressCallback?: (progress: IFetchProgress) => void,
    isBackgroundTask?: boolean,
  ) => Promise<void>;
  readonly fetchWorkflow?: (
    repositoryPath: string,
    remoteNames: ReadonlyArray<string>,
    progressCallback?: (progress: IFetchProgress) => void,
    isBackgroundTask?: boolean,
  ) => Promise<OperationRecord | void>;
  readonly updateRemoteHEAD: typeof updateRemoteHEAD;
  readonly push: (
    repositoryPath: string,
    remoteName: string,
    localBranch: string,
    remoteBranch: string | null,
    tags: ReadonlyArray<string>,
    options: object,
    progressCallback?: (progress: IPushProgress) => void,
    isBackgroundTask?: boolean,
  ) => Promise<void>;
  readonly pull: (
    repositoryPath: string,
    remoteName: string,
    progressCallback?: (progress: IPullProgress) => void,
    noVerify?: boolean,
    isBackgroundTask?: boolean,
  ) => Promise<void>;
  readonly getBranchesDifferingFromUpstream: (
    repositoryPath: string,
  ) => Promise<ReadonlyArray<ITrackingBranch>>;
  readonly fastForwardBranches: (
    repositoryPath: string,
    branches: ReadonlyArray<readonly [string, string]>,
  ) => Promise<void>;
  readonly addRemote: typeof addRemoteCommand;
  readonly removeRemote: typeof removeRemoteCommand;
};

const defaultDependencies: RemoteStoreDependencies = {
  getRemotes,
  getBranches,
  getStatus,
  fetch: fetchRemote,
  fetchWorkflow: fetchWorkflowRemote,
  updateRemoteHEAD,
  push: pushRemote,
  pull: pullRemote,
  getBranchesDifferingFromUpstream,
  fastForwardBranches,
  addRemote: addRemoteCommand,
  removeRemote: removeRemoteCommand,
};

const EmptyState: RemoteState = {
  repositoryPath: null,
  remotes: [],
  currentRemote: null,
  currentBranch: null,
  loading: false,
  managementError: null,
};

type RemoteFacts = {
  readonly remotes: ReadonlyArray<IRemote>;
  readonly currentRemote: IRemote | null;
  readonly currentBranch: Branch | null;
};

function findDefaultRemote(remotes: ReadonlyArray<IRemote>): IRemote | null {
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null;
}

function findCurrentBranch(
  branches: ReadonlyArray<Branch>,
  currentBranchName: string | null,
): Branch | null {
  return (
    branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === currentBranchName,
    ) ?? null
  );
}

function findCurrentRemote(
  remotes: ReadonlyArray<IRemote>,
  currentBranch: Branch | null,
): IRemote | null {
  const trackedRemoteName = currentBranch?.upstreamRemoteName;
  return remotes.find((remote) => remote.name === trackedRemoteName) ?? findDefaultRemote(remotes);
}

/**
 * Owns the frontend half of remote synchronization.
 *
 * Git owns transport, credentials and ref updates. This store owns tracked/default-remote policy,
 * store-owned refresh sequencing and remote-management policy. Native operation records own the
 * repository lock, lifecycle, progress and transport error presentation; compatibility callbacks
 * are retained only as transport inputs and never become UI state.
 */
export class RemoteStore {
  private currentState = EmptyState;
  private requestID = 0;
  private operationID = 0;
  private activeOperation: RemoteOperation | null = null;
  private managementOperationActive = false;
  private readonly dependencies: RemoteStoreDependencies;
  private readonly listeners = new Set<(state: RemoteState) => void>();

  public constructor(dependencies: Partial<RemoteStoreDependencies> = {}) {
    const merged = { ...defaultDependencies, ...dependencies };
    // Tests and compatibility callers that replace the single-remote transport must retain the
    // old loop unless they explicitly provide the workflow transport as well.
    if (dependencies.fetch !== undefined && dependencies.fetchWorkflow === undefined) {
      merged.fetchWorkflow = undefined;
    }
    this.dependencies = merged;
  }

  public get state(): RemoteState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: RemoteState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(repositoryPath: string): Promise<void> {
    const requestID = ++this.requestID;
    this.operationID++;
    this.activeOperation = null;
    this.managementOperationActive = false;
    this.update({
      repositoryPath,
      remotes: [],
      currentRemote: null,
      currentBranch: null,
      loading: true,
      managementError: null,
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
        managementError: null,
      });
    } catch (error) {
      if (requestID !== this.requestID) {
        return;
      }
      reportErrorMessage(describeError(error));
      this.update({
        repositoryPath,
        remotes: [],
        currentRemote: null,
        currentBranch: null,
        loading: false,
        managementError: null,
      });
    }
  }

  /**
   * Adds a remote and refreshes the remote facts, so a freshly created repository
   * (which has none) gains one in-app instead of hitting the enablement wall.
   */
  public async addRemote(name: string, url: string): Promise<boolean> {
    const repositoryPath = this.currentState.repositoryPath;
    const trimmedName = name.trim();
    const trimmedURL = url.trim();
    if (
      repositoryPath === null ||
      this.currentState.loading ||
      this.activeOperation !== null ||
      this.managementOperationActive ||
      trimmedName.length === 0 ||
      trimmedURL.length === 0
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.managementOperationActive = true;
    this.update({
      ...this.currentState,
    });
    try {
      await this.dependencies.addRemote(repositoryPath, trimmedName, trimmedURL);
      const facts = await this.loadFacts(repositoryPath);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        repositoryPath,
        ...facts,
        loading: false,
        managementError: null,
      });
      this.managementOperationActive = false;
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          managementError: describeRemoteError(error),
        });
      }
      this.managementOperationActive = false;
      return false;
    }
  }

  /** Removes a remote and refreshes the remote facts. */
  public async removeRemote(name: string): Promise<boolean> {
    const repositoryPath = this.currentState.repositoryPath;
    if (
      repositoryPath === null ||
      this.currentState.loading ||
      this.activeOperation !== null ||
      this.managementOperationActive
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.managementOperationActive = true;
    this.update({
      ...this.currentState,
    });
    try {
      await this.dependencies.removeRemote(repositoryPath, name);
      const facts = await this.loadFacts(repositoryPath);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        repositoryPath,
        ...facts,
        loading: false,
        managementError: null,
      });
      this.managementOperationActive = false;
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          managementError: describeRemoteError(error),
        });
      }
      this.managementOperationActive = false;
      return false;
    }
  }

  public async fetch(): Promise<boolean> {
    const { repositoryPath, currentRemote, remotes } = this.currentState;
    if (
      repositoryPath === null ||
      currentRemote === null ||
      this.currentState.loading ||
      this.activeOperation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.activeOperation = "fetch";
    this.update({
      ...this.currentState,
    });

    const defaultRemote = findDefaultRemote(remotes);
    const relevantRemotes = [currentRemote, defaultRemote].filter(
      (remote, index, all): remote is IRemote =>
        remote !== null && all.findIndex((candidate) => candidate?.name === remote.name) === index,
    );
    try {
      const updateProgress = () => undefined;

      if (this.dependencies.fetchWorkflow !== undefined) {
        const nativeRecord = await this.dependencies.fetchWorkflow(
          repositoryPath,
          relevantRemotes.map((remote) => remote.name),
          updateProgress,
          false,
        );
        const refreshRemotes =
          nativeRecord?.refresh?.remoteNames ?? relevantRemotes.map((remote) => remote.name);
        for (const remoteName of refreshRemotes) {
          await this.updateRemoteHeadQuietly(repositoryPath, remoteName);
        }
      } else {
        for (const remote of relevantRemotes) {
          await this.dependencies.fetch(repositoryPath, remote.name, updateProgress, false);
          await this.updateRemoteHeadQuietly(repositoryPath, remote.name);
        }
      }

      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
      });

      await this.fastForwardEligibleBranches(repositoryPath);

      const facts = await this.loadFacts(repositoryPath);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        repositoryPath,
        ...facts,
        loading: false,
        managementError: null,
      });
      this.activeOperation = null;
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        reportErrorMessage(describeRemoteError(error));
        this.activeOperation = null;
      }
      return false;
    }
  }

  public async push(): Promise<boolean> {
    const { repositoryPath, currentRemote, currentBranch } = this.currentState;
    if (
      repositoryPath === null ||
      currentRemote === null ||
      currentBranch === null ||
      this.currentState.loading ||
      this.activeOperation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.activeOperation = "push";
    this.update({
      ...this.currentState,
    });

    try {
      await this.dependencies.push(
        repositoryPath,
        currentRemote.name,
        currentBranch.name,
        currentBranch.upstreamWithoutRemote,
        [],
        {},
        () => undefined,
        false,
      );

      if (this.dependencies.push === pushRemote) {
        this.update({
          ...this.currentState,
        });
      } else {
        await this.dependencies.fetch(repositoryPath, currentRemote.name, () => undefined, false);
      }
      await this.updateRemoteHeadQuietly(repositoryPath, currentRemote.name);

      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
      });
      await this.fastForwardEligibleBranches(repositoryPath);

      const facts = await this.loadFacts(repositoryPath);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        repositoryPath,
        ...facts,
        loading: false,
        managementError: null,
      });
      this.activeOperation = null;
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        reportErrorMessage(describeRemoteError(error));
        this.activeOperation = null;
      }
      return false;
    }
  }

  public async pull(): Promise<boolean> {
    const { repositoryPath, currentRemote, currentBranch } = this.currentState;
    if (
      repositoryPath === null ||
      currentRemote === null ||
      currentBranch === null ||
      currentBranch.upstream === null ||
      this.currentState.loading ||
      this.activeOperation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.activeOperation = "pull";
    this.update({
      ...this.currentState,
    });

    try {
      await this.dependencies.pull(
        repositoryPath,
        currentRemote.name,
        () => undefined,
        false,
        false,
      );

      await this.updateRemoteHeadQuietly(repositoryPath, currentRemote.name);

      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
      });
      await this.fastForwardEligibleBranches(repositoryPath);

      const facts = await this.loadFacts(repositoryPath);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        repositoryPath,
        ...facts,
        loading: false,
        managementError: null,
      });
      this.activeOperation = null;
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        reportErrorMessage(describeRemoteError(error));
        this.activeOperation = null;
      }
      return false;
    }
  }

  public clear(): void {
    this.requestID++;
    this.operationID++;
    this.update(EmptyState);
  }

  private async loadFacts(repositoryPath: string): Promise<RemoteFacts> {
    const [remotes, branches, status] = await Promise.all([
      this.dependencies.getRemotes(repositoryPath),
      this.dependencies.getBranches(repositoryPath),
      this.dependencies.getStatus(repositoryPath, true),
    ]);
    const currentBranch = findCurrentBranch(branches, status?.currentBranch ?? null);
    return {
      remotes,
      currentRemote: findCurrentRemote(remotes, currentBranch),
      currentBranch,
    };
  }

  private async fastForwardEligibleBranches(repositoryPath: string): Promise<void> {
    try {
      const branches = await this.dependencies.getBranchesDifferingFromUpstream(repositoryPath);
      await this.dependencies.fastForwardBranches(
        repositoryPath,
        branches.map((branch) => [branch.upstreamRef, branch.ref] as const),
      );
    } catch (error) {
      log.error("Branch fast-forwarding failed after remote operation", error);
    }
  }

  private async updateRemoteHeadQuietly(repositoryPath: string, remoteName: string): Promise<void> {
    try {
      // A successful fetch gives us a trustworthy opportunity to record the remote's advertised
      // default branch. This mirrors upstream: failure is diagnostic only and must not turn the
      // completed transport operation into a false failure.
      await this.dependencies.updateRemoteHEAD(repositoryPath, remoteName, false);
    } catch (error) {
      log.error(`Failed updating ${remoteName} HEAD`, error);
    }
  }

  private isCurrentOperation(requestID: number, operationID: number): boolean {
    return requestID === this.requestID && operationID === this.operationID;
  }

  private update(state: RemoteState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
