import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

type FolderOpenAction = "open" | "reveal";

export async function showItemInFolder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (error) {
    log.error(`Unable to show item in folder '${path}'`, error);
  }
}

export async function showFolderContents(path: string): Promise<void> {
  try {
    const action = await invoke<FolderOpenAction | null>("classify_folder_open", { path });
    if (action === "open") {
      await openPath(path);
    } else if (action === "reveal") {
      await revealItemInDir(path);
    }
  } catch (error) {
    log.error(`Unable to show folder contents for '${path}'`, error);
  }
}

/** Open a directory already validated by the caller as safe and non-executable. */
export function unsafeOpenDirectory(path: string): Promise<void> {
  return openPath(path);
}

export async function openExternal(target: string): Promise<boolean> {
  try {
    if (/^(https?|mailto):/i.test(target)) {
      await openUrl(target);
    } else {
      await openPath(fileUrlToPath(target));
    }
    return true;
  } catch (error) {
    log.error(`Call to openExternal failed: '${String(error)}'`);
    return false;
  }
}

function fileUrlToPath(target: string): string {
  if (!target.toLowerCase().startsWith("file://")) {
    return target;
  }

  const pathname = decodeURIComponent(new URL(target).pathname);
  return __WIN32__ && /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
}

/** One path's failure within a batch operation. */
export type PathFailure = {
  readonly path: string;
  readonly message: string;
};

/**
 * Moves many repository-relative paths to the OS trash in one call.
 *
 * Resolves to the paths that failed rather than rejecting on the first one, so a caller partway
 * through a multi-part operation can still finish it for the paths that succeeded. A path that is
 * already gone is not a failure.
 *
 * Batched deliberately: doing this per file cost two IPC round-trips each — one to join the path,
 * one to trash it — serialised, so a large discard spent thousands of round-trips before any git
 * command ran.
 */
export function moveRepositoryPathsToTrash(
  repositoryPath: string,
  relativePaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<PathFailure>> {
  return invoke("move_repository_paths_to_trash", {
    repositoryPath,
    relativePaths,
  });
}

/** Permanently deletes many repository-relative paths in one call, reporting per-path failures. */
export function permanentlyDeleteRepositoryPaths(
  repositoryPath: string,
  relativePaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<PathFailure>> {
  return invoke("permanently_delete_repository_paths", {
    repositoryPath,
    relativePaths,
  });
}
