import { join } from "@tauri-apps/api/path";
import { GitResetMode } from "../models/git-reset-mode";
import { IndexStatus } from "../models/index-status";
import { AppFileStatusKind, type WorkingDirectoryFileChange } from "../models/status";
import { getIndexChanges } from "./diff-ipc";
import { resetPaths } from "./git-ipc";
import { checkoutIndex } from "./misc-ipc";
import { moveItemToTrash, permanentlyDeleteRepositoryPath } from "./platform/files";
import { listSubmodules, resetSubmodulePaths } from "./stash-ipc";

type DiscardChangesDependencies = {
  readonly resolvePath: (repositoryPath: string, relativePath: string) => Promise<string>;
  readonly moveItemToTrash: typeof moveItemToTrash;
  readonly permanentlyDeleteRepositoryPath: typeof permanentlyDeleteRepositoryPath;
  readonly getIndexChanges: typeof getIndexChanges;
  readonly listSubmodules: typeof listSubmodules;
  readonly resetSubmodulePaths: typeof resetSubmodulePaths;
  readonly resetPaths: typeof resetPaths;
  readonly checkoutIndex: typeof checkoutIndex;
};

const defaultDependencies: DiscardChangesDependencies = {
  resolvePath: join,
  moveItemToTrash,
  permanentlyDeleteRepositoryPath,
  getIndexChanges,
  listSubmodules,
  resetSubmodulePaths,
  resetPaths,
  checkoutIndex,
};

export type DiscardChangesOptions = {
  readonly permanentlyDelete?: boolean;
};

export class TrashDiscardError extends Error {
  public constructor(
    public readonly file: WorkingDirectoryFileChange,
    cause: unknown,
  ) {
    super(`Failed to move ${file.path} to the operating system trash.`, {
      cause,
    });
    this.name = "TrashDiscardError";
  }
}

/**
 * Discards whole-file changes while keeping recoverable contents in the OS
 * trash.
 *
 * This preserves upstream's three-part operation: inspect index changes,
 * restore the selected index entries to HEAD, then check those paths back out.
 * Submodule directories are never moved to trash because that would discard
 * the entire nested repository rather than only its working-tree changes.
 */
export async function discardChanges(
  repositoryPath: string,
  files: ReadonlyArray<WorkingDirectoryFileChange>,
  options: DiscardChangesOptions = {},
  dependencies: DiscardChangesDependencies = defaultDependencies,
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const submodules = await dependencies.listSubmodules(repositoryPath);
  const submodulePaths = new Set(submodules.map((submodule) => submodule.path));
  const pathsToCheckout: string[] = [];
  const pathsToReset: string[] = [];

  for (const file of files) {
    if (file.status.kind !== AppFileStatusKind.Deleted && !submodulePaths.has(file.path)) {
      if (options.permanentlyDelete) {
        if (file.status.kind === AppFileStatusKind.Untracked) {
          await dependencies.permanentlyDeleteRepositoryPath(repositoryPath, file.path);
        }
      } else {
        const absolutePath = await dependencies.resolvePath(repositoryPath, file.path);
        try {
          await dependencies.moveItemToTrash(absolutePath);
        } catch (error) {
          throw new TrashDiscardError(file, error);
        }
      }
    }

    if (
      file.status.kind === AppFileStatusKind.Copied ||
      file.status.kind === AppFileStatusKind.Renamed
    ) {
      pathsToReset.push(file.path, file.status.oldPath);
      pathsToCheckout.push(file.status.oldPath);
    } else {
      pathsToReset.push(file.path);
      pathsToCheckout.push(file.path);
    }
  }

  const indexChanges = new Map(await dependencies.getIndexChanges(repositoryPath));
  const necessaryPathsToReset = pathsToReset.filter((path) => indexChanges.has(path));
  const selectedSubmodulePaths = pathsToCheckout.filter((path) => submodulePaths.has(path));
  const necessaryPathsToCheckout = pathsToCheckout.filter(
    (path) => !submodulePaths.has(path) || indexChanges.get(path) !== IndexStatus.Added,
  );

  await dependencies.resetSubmodulePaths(repositoryPath, selectedSubmodulePaths);
  await dependencies.resetPaths(repositoryPath, GitResetMode.Mixed, "HEAD", necessaryPathsToReset);
  await dependencies.checkoutIndex(repositoryPath, necessaryPathsToCheckout);
}
