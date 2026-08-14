import {
  isConflictedFileStatus,
  isConflictWithMarkers,
  type ConflictedFileStatus,
} from "../../models/status";
import {
  getStatus,
  stageResolvedConflictFiles,
  type IStatusFileChange,
  type IStatusResult,
} from "../git-ipc";
import { describeError } from "../format-error";

export type ConflictFile = {
  readonly path: string;
  readonly status: ConflictedFileStatus;
  readonly resolvedInWorkingTree: boolean;
};

export type ConflictState = {
  readonly repositoryPath: string | null;
  /** A Git recovery marker found during repository load, even when no live operation exists. */
  readonly recoveryOperation: "cherryPick" | "revert" | null;
  readonly mergeInProgress: boolean;
  readonly files: ReadonlyArray<ConflictFile>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly stagingPath: string | null;
  readonly operationError: string | null;
};

type ConflictStoreDependencies = {
  readonly getStatus: typeof getStatus;
  readonly stageResolvedConflictFiles: typeof stageResolvedConflictFiles;
};

const defaultDependencies: ConflictStoreDependencies = {
  getStatus,
  stageResolvedConflictFiles,
};

const EmptyState: ConflictState = {
  repositoryPath: null,
  recoveryOperation: null,
  mergeInProgress: false,
  files: [],
  loading: false,
  error: null,
  stagingPath: null,
  operationError: null,
};

function conflictFiles(files: ReadonlyArray<IStatusFileChange>): ReadonlyArray<ConflictFile> {
  return files.flatMap((file) => {
    if (!isConflictedFileStatus(file.status)) {
      return [];
    }
    return [
      {
        path: file.path,
        status: file.status,
        resolvedInWorkingTree:
          isConflictWithMarkers(file.status) && file.status.conflictMarkerCount === 0,
      },
    ];
  });
}

/**
 * Owns Phase 7c's minimum merge-conflict recovery.
 *
 * External editors change the working tree without notifying the webview, so
 * refresh is explicit. Git's marker count decides whether staging is safe;
 * the frontend never guesses from file contents or enables a still-conflicted
 * path.
 */
export class ConflictStore {
  private currentState = EmptyState;
  private requestID = 0;
  private operationID = 0;
  private readonly dependencies: ConflictStoreDependencies;
  private readonly listeners = new Set<(state: ConflictState) => void>();

  public constructor(dependencies: Partial<ConflictStoreDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public get state(): ConflictState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: ConflictState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(repositoryPath: string): Promise<void> {
    const requestID = ++this.requestID;
    this.operationID++;
    this.update({
      repositoryPath,
      recoveryOperation: null,
      mergeInProgress: false,
      files: [],
      loading: true,
      error: null,
      stagingPath: null,
      operationError: null,
    });
    try {
      const status = await this.dependencies.getStatus(repositoryPath, true);
      if (requestID !== this.requestID) {
        return;
      }
      this.update(this.stateFromStatus(repositoryPath, status));
    } catch (error) {
      if (requestID !== this.requestID) {
        return;
      }
      this.update({
        repositoryPath,
        recoveryOperation: null,
        mergeInProgress: false,
        files: [],
        loading: false,
        error: describeError(error),
        stagingPath: null,
        operationError: null,
      });
    }
  }

  public async stageResolvedFile(path: string): Promise<boolean> {
    const repositoryPath = this.currentState.repositoryPath;
    const file = this.currentState.files.find((file) => file.path === path);
    if (repositoryPath === null || file === undefined) {
      return false;
    }
    if (!file.resolvedInWorkingTree) {
      this.update({
        ...this.currentState,
        operationError: `Resolve all conflict markers before staging ${path}.`,
      });
      return false;
    }

    const requestID = this.requestID;
    const operationID = ++this.operationID;
    this.update({
      ...this.currentState,
      stagingPath: path,
      operationError: null,
    });
    try {
      const status = file.status;
      await this.dependencies.stageResolvedConflictFiles(repositoryPath, [
        {
          path,
          entries: [status.entry.us, status.entry.them],
          conflictMarkerCount: isConflictWithMarkers(status)
            ? status.conflictMarkerCount
            : undefined,
        },
      ]);
      const nextStatus = await this.dependencies.getStatus(repositoryPath, true);
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false;
      }
      this.update(this.stateFromStatus(repositoryPath, nextStatus));
      return true;
    } catch (error) {
      if (this.isCurrentOperation(requestID, operationID)) {
        this.update({
          ...this.currentState,
          stagingPath: null,
          operationError: describeError(error),
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

  private stateFromStatus(repositoryPath: string, status: IStatusResult | null): ConflictState {
    return {
      repositoryPath,
      recoveryOperation:
        status?.isCherryPickingHeadFound === true
          ? "cherryPick"
          : status?.isRevertingHeadFound === true
            ? "revert"
            : null,
      mergeInProgress: status?.mergeHeadFound ?? false,
      files: conflictFiles(status?.files ?? []),
      loading: false,
      error: null,
      stagingPath: null,
      operationError: null,
    };
  }

  private isCurrentOperation(requestID: number, operationID: number): boolean {
    return requestID === this.requestID && operationID === this.operationID;
  }

  private update(state: ConflictState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
