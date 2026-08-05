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

export function moveItemToTrash(path: string): Promise<void> {
  return invoke("move_item_to_trash", { path });
}

export function permanentlyDeleteRepositoryPath(
  repositoryPath: string,
  relativePath: string,
): Promise<void> {
  return invoke("permanently_delete_repository_path", {
    repositoryPath,
    relativePath,
  });
}
