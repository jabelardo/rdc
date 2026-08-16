import { GitResetMode } from "@/models/git-reset-mode";
import { IndexStatus } from "@/models/index-status";
import { AppFileStatusKind, type WorkingDirectoryFileChange } from "@/models/status";
import { getIndexChanges } from "@/lib/diff/diff-ipc";
import { resetPaths } from "@/lib/ipc/git-ipc";
import { checkoutIndex } from "@/lib/ipc/misc-ipc";
import { moveRepositoryPathsToTrash, permanentlyDeleteRepositoryPaths } from "@/platform/files";
import { listSubmodules, resetSubmodulePaths } from "@/lib/ipc/stash-ipc";

type DiscardChangesDependencies = {
  readonly moveRepositoryPathsToTrash: typeof moveRepositoryPathsToTrash;
  readonly permanentlyDeleteRepositoryPaths: typeof permanentlyDeleteRepositoryPaths;
  readonly getIndexChanges: typeof getIndexChanges;
  readonly listSubmodules: typeof listSubmodules;
  readonly resetSubmodulePaths: typeof resetSubmodulePaths;
  readonly resetPaths: typeof resetPaths;
  readonly checkoutIndex: typeof checkoutIndex;
};

const defaultDependencies: DiscardChangesDependencies = {
  moveRepositoryPathsToTrash,
  permanentlyDeleteRepositoryPaths,
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
    /** How many paths failed in total; `file` is the first of them. */
    public readonly failureCount = 1,
  ) {
    super(
      failureCount > 1
        ? `Failed to remove ${failureCount} files, starting with ${file.path}.`
        : `Failed to move ${file.path} to the operating system trash.`,
      { cause },
    );
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

  // Classified in one pass, with no awaiting: the removals are batched into a single call below
  // rather than costing two IPC round-trips per file.
  const pathsToRemove: string[] = [];
  const filesByPath = new Map<string, WorkingDirectoryFileChange>();
  for (const file of files) {
    if (file.status.kind === AppFileStatusKind.Deleted || submodulePaths.has(file.path)) {
      continue;
    }
    if (options.permanentlyDelete && file.status.kind !== AppFileStatusKind.Untracked) {
      // A permanent discard of a tracked file is the checkout below, not a delete.
      continue;
    }
    pathsToRemove.push(file.path);
    filesByPath.set(file.path, file);
  }

  const removalFailures = options.permanentlyDelete
    ? await dependencies.permanentlyDeleteRepositoryPaths(repositoryPath, pathsToRemove)
    : await dependencies.moveRepositoryPathsToTrash(repositoryPath, pathsToRemove);
  const failedPaths = new Set(removalFailures.map((failure) => failure.path));

  // The git half runs for the files whose removal succeeded, even when others failed. Throwing here
  // instead used to leave every already-removed file gone from the working tree with the index and
  // HEAD untouched — a tree in a state the user never asked for and git could not explain.
  const pathsToCheckout: string[] = [];
  const pathsToReset: string[] = [];
  for (const file of files) {
    if (failedPaths.has(file.path)) {
      continue;
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

  // Nothing survived the removal step, so there is no git work to do and no index to read.
  if (pathsToReset.length > 0 || pathsToCheckout.length > 0) {
    const indexChanges = new Map(await dependencies.getIndexChanges(repositoryPath));
    const necessaryPathsToReset = pathsToReset.filter((path) => indexChanges.has(path));
    const selectedSubmodulePaths = pathsToCheckout.filter((path) => submodulePaths.has(path));
    const necessaryPathsToCheckout = pathsToCheckout.filter(
      (path) => !submodulePaths.has(path) || indexChanges.get(path) !== IndexStatus.Added,
    );

    await dependencies.resetSubmodulePaths(repositoryPath, selectedSubmodulePaths);
    await dependencies.resetPaths(
      repositoryPath,
      GitResetMode.Mixed,
      "HEAD",
      necessaryPathsToReset,
    );
    await dependencies.checkoutIndex(repositoryPath, necessaryPathsToCheckout);
  }

  // Raised last, so the tree is already consistent for everything that worked. The first failure
  // names the error because that is what the caller shows; the count carries the rest.
  const firstFailure = removalFailures[0];
  if (firstFailure !== undefined) {
    const file = filesByPath.get(firstFailure.path);
    if (file !== undefined) {
      throw new TrashDiscardError(file, firstFailure.message, removalFailures.length);
    }
    throw new Error(firstFailure.message);
  }
}
