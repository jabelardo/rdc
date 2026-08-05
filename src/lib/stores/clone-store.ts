import type { ICloneProgress } from "../../models/progress";
import { clone as cloneRepository } from "../remote-ipc";
import { describeRemoteError } from "../remote-error";

export type CloneState = {
  readonly operation: "clone" | null;
  readonly progress: ICloneProgress | null;
  readonly error: string | null;
};

type CloneStoreDependencies = {
  readonly clone: typeof cloneRepository;
};

const EmptyState: CloneState = {
  operation: null,
  progress: null,
  error: null,
};

/**
 * Owns one generic clone operation.
 *
 * URL/path form state remains in the view. This store owns validation, serialization, native
 * progress and stale-callback rejection; repository persistence starts only after it returns the
 * successfully cloned destination.
 */
export class CloneStore {
  private currentState = EmptyState;
  private operationID = 0;
  private readonly dependencies: CloneStoreDependencies;
  private readonly listeners = new Set<(state: CloneState) => void>();

  public constructor(dependencies: Partial<CloneStoreDependencies> = {}) {
    this.dependencies = {
      clone: cloneRepository,
      ...dependencies,
    };
  }

  public get state(): CloneState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: CloneState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clone(requestedURL: string, requestedPath: string): Promise<string | null> {
    if (this.currentState.operation !== null) {
      return null;
    }

    const url = requestedURL.trim();
    const path = requestedPath.trim();
    if (url.length === 0) {
      this.update({ ...this.currentState, error: "Enter a repository URL." });
      return null;
    }
    if (path.length === 0) {
      this.update({
        ...this.currentState,
        error: "Choose a destination path.",
      });
      return null;
    }

    const operationID = ++this.operationID;
    this.update({
      operation: "clone",
      progress: {
        kind: "clone",
        title: `Cloning into ${path}`,
        value: 0,
      },
      error: null,
    });

    try {
      await this.dependencies.clone(
        url,
        path,
        null,
        {},
        (progress) => {
          if (operationID === this.operationID) {
            this.update({
              ...this.currentState,
              progress,
            });
          }
        },
        false,
      );
      if (operationID !== this.operationID) {
        return null;
      }
      this.update(EmptyState);
      return path;
    } catch (error) {
      if (operationID === this.operationID) {
        this.update({
          operation: null,
          progress: null,
          error: describeRemoteError(error),
        });
      }
      return null;
    }
  }

  public reset(): void {
    this.operationID++;
    this.update(EmptyState);
  }

  private update(state: CloneState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
