import { showFolderContents } from "@/platform/files";
import { getPath } from "@/platform/paths";

/** Reveal the directory containing both renderer and native application logs. */
export async function showApplicationLogs(): Promise<void> {
  const directory = await getPath("logs");
  await showFolderContents(directory);
}
