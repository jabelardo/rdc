import type { IMenu, MenuItem } from "../../models/app-menu";
import type { MenuEvent } from "../../models/menu-event";
import type { Repository } from "../../models/repository";
import type { AppStoreState } from "../stores/app-store";
import type { RemoteState } from "../stores/remote-store";
import type { PreferencesState } from "../stores/preferences-store";
import { remoteEnablement } from "../remote-enablement";
import { buildStartupMenu } from "./startup";
import type { MenuPlatform } from "./default-menu";

type RepositoryMenuStore = {
  readonly state: AppStoreState;
  readonly removeRepository: (repository: Repository) => Promise<void>;
};

type RepositoryMenuEnvironment = {
  readonly createRepository: () => void | Promise<void>;
  readonly addLocalRepository: () => void | Promise<void>;
  readonly chooseRepository: () => void;
  readonly showChanges: () => void;
  readonly showHistory: () => void;
  readonly openRepositoryInNewWindow: (path: string) => void | Promise<void>;
  readonly showFolderContents: (path: string) => void | Promise<void>;
  readonly fetch: () => void | Promise<void>;
  readonly push: () => void | Promise<void>;
  readonly pull: () => void | Promise<void>;
  readonly showClone: () => void;
  readonly showAbout?: () => void;
  readonly showPreferences?: () => void;
  readonly removeRepository?: (repository: Repository) => void | Promise<void>;
  readonly openInShell?: (path: string) => void | Promise<void>;
  readonly openInExternalEditor?: (path: string) => void | Promise<void>;
  readonly showBranches: () => void;
  readonly goToCommitMessage: () => void;
  readonly increaseActiveResizableWidth: () => void;
  readonly decreaseActiveResizableWidth: () => void;
  readonly createBranch: () => void;
  readonly discardAllChanges: () => void | Promise<void>;
  readonly permanentlyDiscardAllChanges: () => void | Promise<void>;
  readonly renameBranch: () => void;
  readonly deleteBranch: () => void;
  readonly mergeBranch: () => void;
  readonly manageRemotes: () => void;
};

function withEnablement(item: MenuItem, enabledByID: ReadonlyMap<string, boolean>): MenuItem {
  const enabled = enabledByID.get(item.id);
  if (item.type === "submenuItem") {
    return {
      ...item,
      enabled: enabled ?? item.enabled,
      menu: {
        ...item.menu,
        items: item.menu.items.map((child) => withEnablement(child, enabledByID)),
      },
    };
  }
  if (item.type === "separator" || enabled === undefined) {
    return item;
  }
  return { ...item, enabled };
}

export function buildRepositoryMenu(
  state: AppStoreState,
  platform: MenuPlatform,
  remoteState?: RemoteState,
  preferencesState?: PreferencesState,
): IMenu {
  const hasRepositories = state.repositories.length > 0;
  const hasSelection = state.selectedRepository !== null;
  const { canFetch, canPush, canPull } = remoteEnablement({
    hasSelection,
    selectedRepositoryPath: state.selectedRepository?.path ?? null,
    remoteState,
  });
  const enabledByID = new Map<string, boolean>([
    ["new-repository", true],
    ["add-local-repository", true],
    ["clone-repository", true],
    ["about", true],
    ["preferences", preferencesState !== undefined],
    ["new-window", hasSelection],
    ["show-repository-list", hasRepositories],
    ["repository", hasSelection],
    ["remove-repository", hasSelection],
    ["open-working-directory", hasSelection],
    [
      "open-in-shell",
      hasSelection &&
        !preferencesState?.loading &&
        preferencesState?.selectedShell !== null &&
        preferencesState?.selectedShell !== undefined,
    ],
    [
      "open-external-editor",
      hasSelection &&
        !preferencesState?.loading &&
        preferencesState?.selectedExternalEditor !== null &&
        preferencesState?.selectedExternalEditor !== undefined,
    ],
    ["show-changes", hasSelection],
    ["show-history", hasSelection],
    ["fetch", canFetch],
    ["push", canPush],
    ["manage-remotes", hasSelection],
    ["pull", canPull],
  ]);
  enabledByID.set("show-branches-list", hasSelection);
  enabledByID.set("go-to-commit-message", hasSelection);
  enabledByID.set("increase-active-resizable-width", true);
  enabledByID.set("decrease-active-resizable-width", true);
  enabledByID.set("create-branch", hasSelection);
  enabledByID.set("discard-all-changes", hasSelection);
  enabledByID.set("permanently-discard-all-changes", hasSelection);
  enabledByID.set("rename-branch", hasSelection);
  enabledByID.set("delete-branch", hasSelection);
  enabledByID.set("merge-branch", hasSelection);
  const menu = buildStartupMenu(
    platform,
    preferencesState === undefined
      ? {}
      : {
          selectedShell: preferencesState.selectedShell,
          selectedExternalEditor: preferencesState.selectedExternalEditor,
          askForConfirmationOnRepositoryRemoval: preferencesState.confirmRepositoryRemoval,
        },
  );

  return {
    ...menu,
    items: menu.items.map((item) => withEnablement(item, enabledByID)),
  };
}

export function createRepositoryMenuEventExecutor(
  store: RepositoryMenuStore,
  environment: RepositoryMenuEnvironment,
): (event: MenuEvent) => Promise<boolean> {
  return async (event) => {
    switch (event) {
      case "create-repository":
        await environment.createRepository();
        return true;
      case "add-local-repository":
        await environment.addLocalRepository();
        return true;
      case "choose-repository":
        environment.chooseRepository();
        return true;
      case "clone-repository":
        environment.showClone();
        return true;
      case "show-about":
        if (environment.showAbout === undefined) {
          return false;
        }
        environment.showAbout();
        return true;
      case "show-preferences":
        if (environment.showPreferences === undefined) {
          return false;
        }
        environment.showPreferences();
        return true;
      case "open-new-window": {
        const repository = store.state.selectedRepository;
        if (repository === null) {
          return false;
        }
        await environment.openRepositoryInNewWindow(repository.path);
        return true;
      }
      case "remove-repository": {
        const repository = store.state.selectedRepository;
        if (repository === null) {
          return false;
        }
        if (environment.removeRepository === undefined) {
          await store.removeRepository(repository);
        } else {
          await environment.removeRepository(repository);
        }
        return true;
      }
      case "open-working-directory": {
        const repository = store.state.selectedRepository;
        if (repository === null) {
          return false;
        }
        await environment.showFolderContents(repository.path);
        return true;
      }
      case "open-in-shell":
      case "open-external-editor": {
        const repository = store.state.selectedRepository;
        const action =
          event === "open-in-shell" ? environment.openInShell : environment.openInExternalEditor;
        if (repository === null || action === undefined) {
          return false;
        }
        await action(repository.path);
        return true;
      }
      case "show-changes":
      case "show-history": {
        if (store.state.selectedRepository === null) {
          return false;
        }
        if (event === "show-changes") {
          environment.showChanges();
        } else {
          environment.showHistory();
        }
        return true;
      }
      case "fetch":
        if (store.state.selectedRepository === null) {
          return false;
        }
        await environment.fetch();
        return true;
      case "push":
        if (store.state.selectedRepository === null) {
          return false;
        }
        await environment.push();
        return true;
      case "pull":
        if (store.state.selectedRepository === null) {
          return false;
        }
        await environment.pull();
        return true;
      case "show-branches":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.showBranches();
        return true;
      case "go-to-commit-message":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.goToCommitMessage();
        return true;
      case "increase-active-resizable-width":
        environment.increaseActiveResizableWidth();
        return true;
      case "decrease-active-resizable-width":
        environment.decreaseActiveResizableWidth();
        return true;
      case "create-branch":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.createBranch();
        return true;
      case "discard-all-changes":
        if (store.state.selectedRepository === null) {
          return false;
        }
        await environment.discardAllChanges();
        return true;
      case "permanently-discard-all-changes":
        if (store.state.selectedRepository === null) {
          return false;
        }
        await environment.permanentlyDiscardAllChanges();
        return true;
      case "rename-branch":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.renameBranch();
        return true;
      case "delete-branch":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.deleteBranch();
        return true;
      case "merge-branch":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.mergeBranch();
        return true;
      case "manage-remotes":
        if (store.state.selectedRepository === null) {
          return false;
        }
        environment.manageRemotes();
        return true;
      default:
        return false;
    }
  };
}
