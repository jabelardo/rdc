import { basename } from "@/utils/path-utils";
import { parseRepositoryIdentifier } from "./remote-parsing";

/** Infer the directory name appended to a parent selected in the clone dialog. */
export function getCloneDirectoryName(url: string): string | null {
  const value = url.trim();
  if (value.length === 0) {
    return null;
  }

  const parsed = parseRepositoryIdentifier(value);
  const name = parsed?.name ?? basename(value, ".git");
  return name.length > 0 ? name : null;
}
