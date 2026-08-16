import { RepositoriesDatabase } from "@/lib/databases/repositories-database";
import { AppStore } from "./app-store";
import { RepositoriesStore } from "./repositories-store";

let defaultStore: AppStore | undefined;

/** One store owner per webview, backed by the shared application origin. */
export function getDefaultAppStore(): AppStore {
  defaultStore ??= new AppStore(new RepositoriesStore(new RepositoriesDatabase()));
  return defaultStore;
}
