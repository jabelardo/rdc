import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../../models/app-menu";
import type { Repository } from "../../models/repository";
import { buildRepositoryMenu, createRepositoryMenuEventExecutor } from "./repository-menu";
import type { RemoteState } from "../stores/remote-store";
import type { PreferencesState } from "../stores/preferences-store";
import { createStartupMenuActionExecutor } from "./startup";

const repository = {
  id: 7,
  name: "rdc",
  path: "/projects/rdc",
} as Repository;

/** Flatten a menu tree to every level, including the nested Help → Show Dialog submenu. */
function flattenMenu(items: ReadonlyArray<MenuItem>): ReadonlyArray<MenuItem> {
  return items.flatMap((item) =>
    item.type === "submenuItem" ? [item, ...flattenMenu(item.menu.items)] : [item],
  );
}

const remoteState = {
  repositoryPath: repository.path,
  remotes: [{ name: "origin", url: "/remotes/origin.git" }],
  currentRemote: { name: "origin", url: "/remotes/origin.git" },
  currentBranch: {
    name: "main",
    upstream: "origin/main",
  } as RemoteState["currentBranch"],
  loading: false,
  managementError: null,
} satisfies RemoteState;

const preferencesState = {
  theme: "system",
  resolvedTheme: "light",
  zoomFactor: 1.0,
  confirmRepositoryRemoval: true,
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  defaultMergeStrategy: "merge" as const,
  selectedExternalEditor: "Zed",
  selectedShell: "Ghostty",
  editors: [{ editor: "Zed", path: "/applications/zed" }],
  shells: [{ shell: "Ghostty", path: "/applications/ghostty" }],
  loading: false,
  error: null,
} as PreferencesState;

function allItems(items: ReadonlyArray<MenuItem>): ReadonlyArray<MenuItem> {
  return items.flatMap((item) =>
    item.type === "submenuItem" ? [item, ...allItems(item.menu.items)] : [item],
  );
}

describe("repository application menu", () => {
  it("keeps repository actions disabled until a repository is selected", () => {
    const menu = buildRepositoryMenu({ repositories: [], selectedRepository: null }, "macos");
    const appMenu = flattenMenu(menu.items);
    const byId = (id: string) => appMenu.find((item) => item.id === id);

    expect(byId("add-local-repository")).toMatchObject({ enabled: true });
    expect(byId("clone-repository")).toMatchObject({ enabled: true });
    expect(byId("new-window")).toMatchObject({ enabled: false });
    expect(byId("show-repository-list")).toMatchObject({ enabled: false });
    expect(byId("repository")).toMatchObject({ enabled: false });
    expect(byId("remove-repository")).toMatchObject({ enabled: false });
    expect(byId("open-working-directory")).toMatchObject({
      enabled: false,
    });
    expect(byId("pull")).toMatchObject({ enabled: false });
    // Debug branch dialogs require a selected repository, so they stay honest with no selection.
    expect(byId("debug-merge-branch")).toMatchObject({ enabled: false });
    expect(byId("debug-rebase-branch")).toMatchObject({ enabled: false });
  });

  it("enables only the Phase 7a repository actions backed by the shell", () => {
    const menu = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      "linux",
    );
    const appMenu = flattenMenu(menu.items);
    const byId = (id: string) => appMenu.find((item) => item.id === id);

    expect(byId("show-repository-list")).toMatchObject({ enabled: true });
    expect(byId("new-window")).toMatchObject({ enabled: true });
    expect(byId("repository")).toMatchObject({ enabled: true });
    expect(byId("remove-repository")).toMatchObject({ enabled: true });
    expect(byId("open-working-directory")).toMatchObject({
      enabled: true,
    });
    expect(byId("pull")).toMatchObject({ enabled: false });
    expect(byId("show-changes")).toMatchObject({ enabled: true });
    expect(byId("show-history")).toMatchObject({ enabled: true });
    // With a selected repository the debug branch dialogs are available, as they must be to open.
    expect(byId("debug-merge-branch")).toMatchObject({ enabled: true });
    expect(byId("debug-rebase-branch")).toMatchObject({ enabled: true });
  });

  it("enables synchronization only with usable remote state and no operation", () => {
    const enabled = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      "linux",
      remoteState,
    );
    const busy = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      "linux",
      remoteState,
      undefined,
      true,
    );
    const byId = (menu: typeof enabled, id: string) =>
      menu.items
        .flatMap((item) => (item.type === "submenuItem" ? [item, ...item.menu.items] : [item]))
        .find((item) => item.id === id);

    expect(byId(enabled, "fetch")).toMatchObject({ enabled: true });
    expect(byId(busy, "fetch")).toMatchObject({ enabled: false });
    expect(byId(enabled, "pull")).toMatchObject({ enabled: true });
    expect(byId(enabled, "push")).toMatchObject({ enabled: true });
  });

  it("honors the native repository lock while store state is still idle", () => {
    const menu = buildRepositoryMenu(
      { repositories: [repository], selectedRepository: repository },
      "linux",
      remoteState,
      undefined,
      true,
    );
    const byId = (id: string) => flattenMenu(menu.items).find((item) => item.id === id);

    expect(byId("fetch")).toMatchObject({ enabled: false });
    expect(byId("push")).toMatchObject({ enabled: false });
    expect(byId("pull")).toMatchObject({ enabled: false });
  });

  it("enables preferences globally and installed integration actions for a selection", () => {
    const menu = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      "linux",
      remoteState,
      preferencesState,
    );
    const items = menu.items.flatMap((item) =>
      item.type === "submenuItem" ? [item, ...item.menu.items] : [item],
    );
    const byId = (id: string) => items.find((item) => item.id === id);

    expect(byId("preferences")).toMatchObject({ enabled: true });
    expect(byId("about")).toMatchObject({ enabled: true });
    expect(byId("remove-repository")).toMatchObject({
      enabled: true,
      label: "&Remove…",
    });
    expect(byId("open-in-shell")).toMatchObject({
      enabled: true,
      label: "O&pen in Ghostty",
    });
    expect(byId("open-external-editor")).toMatchObject({
      enabled: true,
      label: "&Open in Zed",
    });
  });

  it.each(["macos", "windows", "linux"] as const)(
    "has an executor for every enabled %s menu action",
    async (platform) => {
      const state = {
        repositories: [repository],
        selectedRepository: repository,
      };
      const menu = buildRepositoryMenu(state, platform, remoteState, preferencesState);
      const executeMenuEvent = createRepositoryMenuEventExecutor(
        {
          state,
          removeRepository: vi.fn(async () => undefined),
        },
        {
          createRepository: vi.fn(),
          addLocalRepository: vi.fn(),
          chooseRepository: vi.fn(),
          showChanges: vi.fn(),
          showHistory: vi.fn(),
          openRepositoryInNewWindow: vi.fn(),
          showFolderContents: vi.fn(),
          fetch: vi.fn(),
          push: vi.fn(),
          pull: vi.fn(),
          showClone: vi.fn(),
          showAbout: vi.fn(),
          showPreferences: vi.fn(),
          removeRepository: vi.fn(),
          openInShell: vi.fn(),
          openInExternalEditor: vi.fn(),
          showBranches: vi.fn(),
          goToCommitMessage: vi.fn(),
          increaseActiveResizableWidth: vi.fn(),
          decreaseActiveResizableWidth: vi.fn(),
          createBranch: vi.fn(),
          discardAllChanges: vi.fn(),
          permanentlyDiscardAllChanges: vi.fn(),
          renameBranch: vi.fn(),
          mergeBranch: vi.fn(),
          deleteBranch: vi.fn(),
          manageRemotes: vi.fn(),
          showDiscardFileDialog: vi.fn(),
          showAddRemoteDialog: vi.fn(),
          showRemoveRepositoryDialog: vi.fn(),
          debugShowAboutDialog: vi.fn(),
          debugShowPreferencesDialog: vi.fn(),
          debugShowCloneDialog: vi.fn(),
          debugShowCloneProgressDialog: vi.fn(),
          debugShowDiscardAllDialog: vi.fn(),
          debugShowRenameBranchDialog: vi.fn(),
          debugShowDeleteBranchDialog: vi.fn(),
          debugShowMergeDialog: vi.fn(),
          debugShowRebaseDialog: vi.fn(),
          debugShowManageRemotesDialog: vi.fn(),
          debugShowHookFailureDialog: vi.fn(),
        },
      );
      const executeStartupAction = createStartupMenuActionExecutor({
        quit: vi.fn(),
        openExternal: vi.fn(),
        reload: vi.fn(),
        selectAll: vi.fn(),
        showLogs: vi.fn(),
        setZoom: vi.fn(),
        toggleDevTools: vi.fn(),
      });
      const enabledActions = allItems(menu.items).flatMap((item) =>
        item.type !== "separator" &&
        item.type !== "submenuItem" &&
        item.visible &&
        item.enabled &&
        item.action !== undefined
          ? [{ id: item.id, action: item.action }]
          : [],
      );
      expect(enabledActions.length).toBeGreaterThan(0);

      for (const { id, action } of enabledActions) {
        const handled =
          action.type === "menu-event" && (await executeMenuEvent(action.event))
            ? true
            : await executeStartupAction(action);
        expect(handled, `${id} has no action executor`).toBe(true);
      }
    },
  );
});

describe("repository application menu actions", () => {
  it("routes supported actions through the current store state", async () => {
    const store = {
      get state() {
        return {
          repositories: [repository],
          selectedRepository: repository,
        };
      },
      removeRepository: vi.fn(async () => undefined),
    };
    const environment = {
      createRepository: vi.fn(async () => undefined),
      addLocalRepository: vi.fn(async () => undefined),
      chooseRepository: vi.fn(),
      showChanges: vi.fn(),
      showHistory: vi.fn(),
      openRepositoryInNewWindow: vi.fn(async () => undefined),
      showFolderContents: vi.fn(async () => undefined),
      fetch: vi.fn(async () => undefined),
      push: vi.fn(async () => undefined),
      pull: vi.fn(async () => undefined),
      showClone: vi.fn(),
      showAbout: vi.fn(),
      showPreferences: vi.fn(),
      openInShell: vi.fn(async () => undefined),
      openInExternalEditor: vi.fn(async () => undefined),
      showBranches: vi.fn(),
      goToCommitMessage: vi.fn(),
      increaseActiveResizableWidth: vi.fn(),
      decreaseActiveResizableWidth: vi.fn(),
      createBranch: vi.fn(),
      discardAllChanges: vi.fn(),
      permanentlyDiscardAllChanges: vi.fn(),
      renameBranch: vi.fn(),
      deleteBranch: vi.fn(),
      mergeBranch: vi.fn(),
      manageRemotes: vi.fn(),
    };
    const execute = createRepositoryMenuEventExecutor(store, environment);

    await expect(execute("create-repository")).resolves.toBe(true);
    await expect(execute("add-local-repository")).resolves.toBe(true);
    await expect(execute("choose-repository")).resolves.toBe(true);
    await expect(execute("open-new-window")).resolves.toBe(true);
    await expect(execute("remove-repository")).resolves.toBe(true);
    await expect(execute("open-working-directory")).resolves.toBe(true);
    await expect(execute("show-changes")).resolves.toBe(true);
    await expect(execute("show-history")).resolves.toBe(true);
    await expect(execute("fetch")).resolves.toBe(true);
    await expect(execute("push")).resolves.toBe(true);
    await expect(execute("pull")).resolves.toBe(true);
    await expect(execute("clone-repository")).resolves.toBe(true);
    await expect(execute("show-about")).resolves.toBe(true);
    await expect(execute("show-preferences")).resolves.toBe(true);
    await expect(execute("open-in-shell")).resolves.toBe(true);
    await expect(execute("open-external-editor")).resolves.toBe(true);
    await expect(execute("show-branches")).resolves.toBe(true);
    await expect(execute("go-to-commit-message")).resolves.toBe(true);
    await expect(execute("increase-active-resizable-width")).resolves.toBe(true);
    await expect(execute("decrease-active-resizable-width")).resolves.toBe(true);
    await expect(execute("create-branch")).resolves.toBe(true);
    await expect(execute("discard-all-changes")).resolves.toBe(true);
    await expect(execute("permanently-discard-all-changes")).resolves.toBe(true);
    await expect(execute("rename-branch")).resolves.toBe(true);
    await expect(execute("delete-branch")).resolves.toBe(true);
    await expect(execute("merge-branch")).resolves.toBe(true);
    await expect(execute("manage-remotes")).resolves.toBe(true);

    expect(environment.createRepository).toHaveBeenCalledOnce();
    expect(environment.addLocalRepository).toHaveBeenCalledOnce();
    expect(environment.chooseRepository).toHaveBeenCalledOnce();
    expect(environment.showChanges).toHaveBeenCalledOnce();
    expect(environment.showHistory).toHaveBeenCalledOnce();
    expect(environment.fetch).toHaveBeenCalledOnce();
    expect(environment.push).toHaveBeenCalledOnce();
    expect(environment.pull).toHaveBeenCalledOnce();
    expect(environment.showClone).toHaveBeenCalledOnce();
    expect(environment.showAbout).toHaveBeenCalledOnce();
    expect(environment.showPreferences).toHaveBeenCalledOnce();
    expect(environment.openInShell).toHaveBeenCalledWith(repository.path);
    expect(environment.openInExternalEditor).toHaveBeenCalledWith(repository.path);
    expect(environment.openRepositoryInNewWindow).toHaveBeenCalledWith(repository.path);
    expect(store.removeRepository).toHaveBeenCalledWith(repository);
    expect(environment.showFolderContents).toHaveBeenCalledWith(repository.path);
    expect(environment.showBranches).toHaveBeenCalledOnce();
    expect(environment.goToCommitMessage).toHaveBeenCalledOnce();
    expect(environment.increaseActiveResizableWidth).toHaveBeenCalledOnce();
    expect(environment.decreaseActiveResizableWidth).toHaveBeenCalledOnce();
    expect(environment.createBranch).toHaveBeenCalledOnce();
    expect(environment.discardAllChanges).toHaveBeenCalledOnce();
    expect(environment.permanentlyDiscardAllChanges).toHaveBeenCalledOnce();
    expect(environment.renameBranch).toHaveBeenCalledOnce();
    expect(environment.deleteBranch).toHaveBeenCalledOnce();
    expect(environment.mergeBranch).toHaveBeenCalledOnce();
    expect(environment.manageRemotes).toHaveBeenCalledOnce();
  });

  it("refuses repository actions when the selection disappeared", async () => {
    const store = {
      state: { repositories: [], selectedRepository: null },
      removeRepository: vi.fn(async () => undefined),
    };
    const environment = {
      createRepository: vi.fn(async () => undefined),
      addLocalRepository: vi.fn(async () => undefined),
      chooseRepository: vi.fn(),
      showChanges: vi.fn(),
      showHistory: vi.fn(),
      openRepositoryInNewWindow: vi.fn(async () => undefined),
      showFolderContents: vi.fn(async () => undefined),
      fetch: vi.fn(async () => undefined),
      push: vi.fn(async () => undefined),
      pull: vi.fn(async () => undefined),
      showClone: vi.fn(),
      showAbout: vi.fn(),
      showPreferences: vi.fn(),
      openInShell: vi.fn(async () => undefined),
      openInExternalEditor: vi.fn(async () => undefined),
      showBranches: vi.fn(),
      goToCommitMessage: vi.fn(),
      increaseActiveResizableWidth: vi.fn(),
      decreaseActiveResizableWidth: vi.fn(),
      createBranch: vi.fn(),
      discardAllChanges: vi.fn(),
      permanentlyDiscardAllChanges: vi.fn(),
      renameBranch: vi.fn(),
      deleteBranch: vi.fn(),
      mergeBranch: vi.fn(),
      manageRemotes: vi.fn(),
    };
    const execute = createRepositoryMenuEventExecutor(store, environment);

    await expect(execute("remove-repository")).resolves.toBe(false);
    await expect(execute("open-new-window")).resolves.toBe(false);
    await expect(execute("open-working-directory")).resolves.toBe(false);
    await expect(execute("show-changes")).resolves.toBe(false);
    await expect(execute("show-history")).resolves.toBe(false);
    await expect(execute("pull")).resolves.toBe(false);
    await expect(execute("clone-repository")).resolves.toBe(true);
    await expect(execute("show-about")).resolves.toBe(true);
    await expect(execute("show-preferences")).resolves.toBe(true);
    await expect(execute("open-in-shell")).resolves.toBe(false);
    await expect(execute("open-external-editor")).resolves.toBe(false);
    await expect(execute("fetch")).resolves.toBe(false);
    await expect(execute("push")).resolves.toBe(false);
    await expect(execute("pull")).resolves.toBe(false);
    await expect(execute("show-branches")).resolves.toBe(false);
    await expect(execute("go-to-commit-message")).resolves.toBe(false);
    await expect(execute("create-branch")).resolves.toBe(false);
    await expect(execute("discard-all-changes")).resolves.toBe(false);
    await expect(execute("permanently-discard-all-changes")).resolves.toBe(false);
    await expect(execute("rename-branch")).resolves.toBe(false);
    await expect(execute("delete-branch")).resolves.toBe(false);
    await expect(execute("merge-branch")).resolves.toBe(false);
    await expect(execute("manage-remotes")).resolves.toBe(false);
    await expect(execute("increase-active-resizable-width")).resolves.toBe(true);
    await expect(execute("decrease-active-resizable-width")).resolves.toBe(true);

    expect(store.removeRepository).not.toHaveBeenCalled();
    expect(environment.openRepositoryInNewWindow).not.toHaveBeenCalled();
    expect(environment.showFolderContents).not.toHaveBeenCalled();
    expect(environment.fetch).not.toHaveBeenCalled();
    expect(environment.push).not.toHaveBeenCalled();
    expect(environment.pull).not.toHaveBeenCalled();
    expect(environment.showClone).toHaveBeenCalledOnce();
    expect(environment.showAbout).toHaveBeenCalledOnce();
    expect(environment.showPreferences).toHaveBeenCalledOnce();
    expect(environment.showBranches).not.toHaveBeenCalled();
    expect(environment.goToCommitMessage).not.toHaveBeenCalled();
    expect(environment.createBranch).not.toHaveBeenCalled();
    expect(environment.increaseActiveResizableWidth).toHaveBeenCalledOnce();
    expect(environment.decreaseActiveResizableWidth).toHaveBeenCalledOnce();
  });

  // Replaces an earlier assertion that pinned these disabled on macOS for "untested platform
  // safety". That gate left the macOS Branch menu with no usable item at all — `create-branch` is
  // implemented and was offered on Linux while greyed out on macOS. Membership rule (b) of
  // `qa/phase-8b/menu-mvp-alignment-checklist.md` makes an implemented capability MVP on every
  // platform, so the surfaces must agree. Native WKWebView dispatch is still unautomatable and is
  // covered by an explicit item in the macOS checklist.
  it.each(["macos", "windows", "linux"] as const)(
    "exposes every implemented capability on %s, so platforms do not diverge",
    (platform) => {
      const menu = buildRepositoryMenu(
        {
          repositories: [repository],
          selectedRepository: repository,
        },
        platform,
        remoteState,
        preferencesState,
      );
      const items = menu.items.flatMap((item) =>
        item.type === "submenuItem" ? [item, ...item.menu.items] : [item],
      );
      const byId = (id: string) => items.find((item) => item.id === id);

      for (const id of [
        "show-branches-list",
        "go-to-commit-message",
        "increase-active-resizable-width",
        "decrease-active-resizable-width",
        "create-branch",
      ]) {
        expect(byId(id), `${id} on ${platform}`).toMatchObject({
          enabled: true,
        });
      }
    },
  );

  it("enables the wiring-gap accelerators on Linux for a selection", () => {
    const menu = buildRepositoryMenu(
      {
        repositories: [repository],
        selectedRepository: repository,
      },
      "linux",
    );
    const items = menu.items.flatMap((item) =>
      item.type === "submenuItem" ? [item, ...item.menu.items] : [item],
    );
    const byId = (id: string) => items.find((item) => item.id === id);

    expect(byId("show-branches-list")).toMatchObject({ enabled: true });
    expect(byId("go-to-commit-message")).toMatchObject({ enabled: true });
    expect(byId("increase-active-resizable-width")).toMatchObject({
      enabled: true,
    });
    expect(byId("decrease-active-resizable-width")).toMatchObject({
      enabled: true,
    });
    expect(byId("create-branch")).toMatchObject({ enabled: true });
  });
});
