import { BranchType, type Branch, type ITrackingBranch } from "../../models/branch";
import type { IFetchProgress, IPullProgress, IPushProgress, Progress } from "../../models/progress";
import type { IRemote } from "../../models/remote";
import { getBranches, getBranchesDifferingFromUpstream } from "../branch-ipc";
import { getStatus, type IStatusResult } from "../git-ipc";
import { describeError } from "../format-error";
import { describeRemoteError } from "../remote-error";
import {
  addRemote as addRemoteCommand,
  fastForwardBranches,
  fetch as fetchRemote,
  getRemotes,
  pull as pullRemote,
  push as pushRemote,
  removeRemote as removeRemoteCommand,
  updateRemoteHEAD,
} from "../remote-ipc";

export type RemoteOperation = "fetch" | "pull" | "push";

export type RemoteState = {
  readonly repositoryPath: string | null;
  readonly remotes: ReadonlyArray<IRemote>;
  readonly currentRemote: IRemote | null;
  readonly currentBranch: Branch | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly operation: RemoteOperation | null;
  readonly progress: Progress | null;
  readonly operationError: string | null;
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
  error: null,
  operation: null,
  progress: null,
  operationError: null,
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
 * Git owns transport, credentials and ref updates. This store owns the user-level operation lock,
 * tracked/default-remote policy, aggregate progress and refresh sequence. Repository and operation
 * generations keep a slow fetch from publishing into a newly selected repository.
 */
export class RemoteStore {
  private currentState = EmptyState;
  private requestID = 0;
  private operationID = 0;
  private readonly dependencies: RemoteStoreDependencies;
  private readonly listeners = new Set<(state: RemoteState) => void>();

  public constructor(dependencies: Partial<RemoteStoreDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
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
    this.update({
      repositoryPath,
      remotes: [],
      currentRemote: null,
      currentBranch: null,
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
        remotes: [],
        currentRemote: null,
        currentBranch: null,
        loading: false,
        error: describeError(error),
        operation: null,
        progress: null,
        operationError: null,
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
      this.currentState.operation !== null ||
      trimmedName.length === 0 ||
      trimmedURL.length === 0
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operationError: null,
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
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      });
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          operationError: describeRemoteError(error),
        });
      }
      return false;
    }
  }

  /** Removes a remote and refreshes the remote facts. */
  public async removeRemote(name: string): Promise<boolean> {
    const repositoryPath = this.currentState.repositoryPath;
    if (
      repositoryPath === null ||
      this.currentState.loading ||
      this.currentState.operation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operationError: null,
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
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      });
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          operationError: describeRemoteError(error),
        });
      }
      return false;
    }
  }

  public async fetch(): Promise<boolean> {
    const { repositoryPath, currentRemote, remotes } = this.currentState;
    if (
      repositoryPath === null ||
      currentRemote === null ||
      this.currentState.loading ||
      this.currentState.operation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "fetch",
      progress: {
        kind: "fetch",
        remote: currentRemote.name,
        value: 0,
        title: `Fetching ${currentRemote.name}`,
      },
      operationError: null,
    });

    const defaultRemote = findDefaultRemote(remotes);
    const relevantRemotes = [currentRemote, defaultRemote].filter(
      (remote, index, all): remote is IRemote =>
        remote !== null && all.findIndex((candidate) => candidate?.name === remote.name) === index,
    );
    const fetchWeight = 0.9;
    const remoteWeight = fetchWeight / relevantRemotes.length;

    try {
      for (const [index, remote] of relevantRemotes.entries()) {
        await this.dependencies.fetch(
          repositoryPath,
          remote.name,
          (progress) => {
            if (this.isCurrentOperation(requestID, operationID)) {
              this.update({
                ...this.currentState,
                progress: {
                  ...progress,
                  title: `Fetching ${remote.name}`,
                  value: index * remoteWeight + progress.value * remoteWeight,
                },
              });
            }
          },
          false,
        );
        await this.updateRemoteHeadQuietly(repositoryPath, remote.name);
      }

      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
        progress: {
          kind: "generic",
          title: "Refreshing repository",
          description: "Fast-forwarding branches",
          value: fetchWeight,
        },
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
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      });
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          operation: null,
          progress: null,
          operationError: describeRemoteError(error),
        });
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
      this.currentState.operation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "push",
      progress: {
        kind: "push",
        remote: currentRemote.name,
        branch: currentBranch.name,
        value: 0,
        title: `Pushing to ${currentRemote.name}`,
      },
      operationError: null,
    });

    const pushWeight = 0.65;
    const fetchWeight = 0.25;
    try {
      await this.dependencies.push(
        repositoryPath,
        currentRemote.name,
        currentBranch.name,
        currentBranch.upstreamWithoutRemote,
        [],
        {},
        (progress) => {
          if (this.isCurrentOperation(requestID, operationID)) {
            this.update({
              ...this.currentState,
              progress: {
                ...progress,
                title: `Pushing to ${currentRemote.name}`,
                value: progress.value * pushWeight,
              },
            });
          }
        },
        false,
      );

      await this.dependencies.fetch(
        repositoryPath,
        currentRemote.name,
        (progress) => {
          if (this.isCurrentOperation(requestID, operationID)) {
            this.update({
              ...this.currentState,
              progress: {
                ...progress,
                title: `Fetching ${currentRemote.name}`,
                value: pushWeight + progress.value * fetchWeight,
              },
            });
          }
        },
        false,
      );
      await this.updateRemoteHeadQuietly(repositoryPath, currentRemote.name);

      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
        progress: {
          kind: "generic",
          title: "Refreshing repository",
          description: "Fast-forwarding branches",
          value: pushWeight + fetchWeight,
        },
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
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      });
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          operation: null,
          progress: null,
          operationError: describeRemoteError(error),
        });
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
      this.currentState.operation !== null
    ) {
      return false;
    }

    const operationID = ++this.operationID;
    const requestID = this.requestID;
    this.update({
      ...this.currentState,
      operation: "pull",
      progress: {
        kind: "pull",
        remote: currentRemote.name,
        value: 0,
        title: `Pulling ${currentRemote.name}`,
      },
      operationError: null,
    });

    const pullWeight = 0.65;
    const fetchWeight = 0.25;
    try {
      await this.dependencies.pull(
        repositoryPath,
        currentRemote.name,
        (progress) => {
          if (this.isCurrentOperation(requestID, operationID)) {
            this.update({
              ...this.currentState,
              progress: {
                ...progress,
                title: `Pulling ${currentRemote.name}`,
                value: progress.value * pullWeight,
              },
            });
          }
        },
        false,
        false,
      );

      await this.dependencies.fetch(
        repositoryPath,
        currentRemote.name,
        (progress) => {
          if (this.isCurrentOperation(requestID, operationID)) {
            this.update({
              ...this.currentState,
              progress: {
                ...progress,
                title: `Fetching ${currentRemote.name}`,
                value: pullWeight + progress.value * fetchWeight,
              },
            });
          }
        },
        false,
      );
      await this.updateRemoteHeadQuietly(repositoryPath, currentRemote.name);

      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update({
        ...this.currentState,
        progress: {
          kind: "generic",
          title: "Refreshing repository",
          description: "Fast-forwarding branches",
          value: pullWeight + fetchWeight,
        },
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
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      });
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          operation: null,
          progress: null,
          operationError: describeRemoteError(error),
        });
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
