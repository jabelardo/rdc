import { truncateWithEllipsis } from "../truncate-with-ellipsis";
import { enableTestMenuItems } from "../feature-flag";
import type { IMenu, MenuAction, MenuItem, NativeMenuRole } from "../../models/app-menu";
import { getAccessKey } from "../../models/app-menu";
import type { RepoType } from "../../models/github-repository";
import type { MenuEvent } from "../../models/menu-event";
import type { MenuLabelsEvent } from "../../models/menu-labels";

export type MenuPlatform = "macos" | "windows" | "linux";

type TemplateItem = {
  readonly id?: string;
  readonly label?: string;
  readonly type?: "separator" | "checkbox" | "radio";
  readonly role?: NativeMenuRole;
  readonly action?: MenuAction;
  readonly submenu?: ReadonlyArray<TemplateItem>;
  readonly enabled?: boolean;
  readonly visible?: boolean;
  readonly checked?: boolean;
};

const separator = (): TemplateItem => ({ type: "separator" });
const event = (name: MenuEvent): MenuAction => ({
  type: "menu-event",
  event: name,
});

export function currentMenuPlatform(): MenuPlatform {
  return __DARWIN__ ? "macos" : __WIN32__ ? "windows" : "linux";
}

function normalizeTemplate(template: ReadonlyArray<TemplateItem>): IMenu {
  const seenIds = new Set<string>();

  const items = (source: ReadonlyArray<TemplateItem>, prefix = "@"): ReadonlyArray<MenuItem> =>
    source.map((item) => {
      const key = item.id ?? item.label ?? item.role ?? "unknown";
      let id = item.id;
      let counter = 0;
      while (id === undefined || seenIds.has(id)) {
        id = `${prefix}.${key}${counter++ || ""}`;
      }
      seenIds.add(id);

      const visible = item.visible ?? true;
      if (item.type === "separator") {
        return { id, type: "separator", visible };
      }

      const label = item.label ?? item.role ?? "";
      const enabled = item.enabled ?? true;
      const accessKey = getAccessKey(label);
      if (item.submenu !== undefined) {
        return {
          id,
          type: "submenuItem",
          label,
          enabled,
          visible,
          accessKey,
          role: item.role,
          menu: { id, type: "menu", items: items(item.submenu, id) },
        };
      }
      if (item.type === "checkbox" || item.type === "radio") {
        return {
          id,
          type: item.type,
          label,
          enabled,
          visible,
          accessKey,
          checked: item.checked ?? false,
          action: item.action,
        };
      }
      return {
        id,
        type: "menuItem",
        label,
        enabled,
        visible,
        accessKey,
        action: item.action,
        role: item.role,
      };
    });

  return { type: "menu", items: items(template) };
}

export function buildDefaultMenu(
  params: MenuLabelsEvent,
  platform: MenuPlatform = currentMenuPlatform(),
): IMenu {
  const mac = platform === "macos";
  const windows = platform === "windows";
  const {
    selectedExternalEditor,
    selectedShell,
    askForConfirmationOnForcePush,
    askForConfirmationOnRepositoryRemoval,
    hasCurrentPullRequest = false,
    isForcePushForCurrentRepository = false,
    isStashedChangesVisible = false,
    askForConfirmationWhenStashingAllChanges = true,
    gitHubRepositoryType,
    isChangesFilterVisible = true,
  } = params;
  const defaultBranch = mac ? "Default Branch" : "default branch";
  const contributionTargetDefaultBranch = truncateWithEllipsis(
    params.contributionTargetDefaultBranch ?? defaultBranch,
    25,
  );

  const removeRepoLabel = askForConfirmationOnRepositoryRemoval
    ? mac
      ? "Remove…"
      : "&Remove…"
    : mac
      ? "Remove"
      : "&Remove";
  const pullRequestLabel = hasCurrentPullRequest
    ? `${mac ? "View Pull Request " : "View &pull request "}${onGithubLabel(gitHubRepositoryType)}`
    : mac
      ? "Create Pull Request"
      : "Create &pull request";

  const template: TemplateItem[] = [];
  if (mac) {
    template.push({
      label: "RDC",
      submenu: [
        {
          label: "About RDC",
          id: "about",
          action: event("show-about"),
        },
        separator(),
        {
          label: "Settings…",
          id: "preferences",
          action: event("show-preferences"),
        },
        {
          label: "Repository Options…",
          id: "repository-preferences",
          action: event("show-repository-preferences"),
        },
        separator(),
        {
          label: "Install Command Line Tool…",
          id: "install-cli",
          action: event("install-darwin-cli"),
        },
        separator(),
        { role: "services", submenu: [] },
        separator(),
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        separator(),
        { id: "quit", role: "quit", action: { type: "quit" } },
      ],
    });
  }

  const fileItems: TemplateItem[] = [
    {
      label: mac ? "New Repository…" : "New &repository…",
      id: "new-repository",
      action: event("create-repository"),
    },
    {
      label: "Open new window",
      id: "new-window",
      action: event("open-new-window"),
    },
    separator(),
    {
      label: mac ? "Add Local Repository…" : "Add &local repository…",
      id: "add-local-repository",
      action: event("add-local-repository"),
    },
    {
      label: mac ? "Clone Repository…" : "Clo&ne repository…",
      id: "clone-repository",
      action: event("clone-repository"),
    },
  ];
  if (!mac) {
    fileItems.push(
      separator(),
      {
        label: "&Options…",
        id: "preferences",
        action: event("show-preferences"),
      },
      {
        label: "Repository options…",
        id: "repository-preferences",
        action: event("show-repository-preferences"),
      },
      separator(),
      {
        id: "quit",
        role: "quit",
        label: "E&xit",
        action: { type: "quit" },
      },
    );
  }
  template.push({ label: mac ? "File" : "&File", submenu: fileItems });

  template.push({
    label: mac ? "Edit" : "&Edit",
    submenu: [
      { role: "undo", label: mac ? "Undo" : "&Undo" },
      { role: "redo", label: mac ? "Redo" : "&Redo" },
      separator(),
      { role: "cut", label: mac ? "Cut" : "Cu&t" },
      { role: "copy", label: mac ? "Copy" : "&Copy" },
      { role: "paste", label: mac ? "Paste" : "&Paste" },
      {
        id: "select-all",
        label: mac ? "Select All" : "Select &all",
        action: event("select-all"),
      },
      separator(),
      {
        id: "find",
        label: mac ? "Find" : "&Find",
        action: event("find-text"),
      },
    ],
  });

  template.push({
    label: mac ? "View" : "&View",
    submenu: [
      {
        label: mac ? "Show Changes" : "&Changes",
        id: "show-changes",
        action: event("show-changes"),
      },
      {
        label: mac ? "Show History" : "&History",
        id: "show-history",
        action: event("show-history"),
      },
      {
        label: mac ? "Show Compare" : "Compare",
        id: "show-compare",
        action: event("show-compare"),
      },
      {
        label: mac ? "Show Repository List" : "Repository &list",
        id: "show-repository-list",
        action: event("choose-repository"),
      },
      {
        label: mac ? "Show Branches List" : "&Branches list",
        id: "show-branches-list",
        action: event("show-branches"),
      },
      {
        label: mac ? "Show Worktrees List" : "Wor&ktrees list",
        id: "show-worktrees-list",
        action: event("show-worktrees"),
      },
      separator(),
      {
        label: mac ? "Go to Summary" : "Go to &Summary",
        id: "go-to-commit-message",
        action: event("go-to-commit-message"),
      },
      {
        label: isStashedChangesVisible
          ? mac
            ? "Hide Stashed Changes"
            : "H&ide stashed changes"
          : mac
            ? "Show Stashed Changes"
            : "Show stashed changes",
        id: "toggle-stashed-changes",
        action: event(isStashedChangesVisible ? "hide-stashed-changes" : "show-stashed-changes"),
      },
      {
        label: mac
          ? `${isChangesFilterVisible ? "Hide" : "Show"} Changes Filter`
          : `${isChangesFilterVisible ? "Hide" : "Show"} Toggle Chan&ges Filter`,
        id: "toggle-changes-filter",
        action: event("toggle-changes-filter"),
      },
      {
        label: mac ? "Toggle Full Screen" : "Toggle &full screen",
        role: "togglefullscreen",
      },
      separator(),
      {
        id: "reset-zoom",
        label: mac ? "Reset Zoom" : "Reset zoom",
        action: { type: "zoom", direction: "reset" },
      },
      {
        id: "zoom-in",
        label: mac ? "Zoom In" : "Zoom in",
        action: { type: "zoom", direction: "in" },
      },
      {
        id: "zoom-out",
        label: mac ? "Zoom Out" : "Zoom out",
        action: { type: "zoom", direction: "out" },
      },
      {
        label: mac ? "Expand Active Resizable" : "Expand active resizable",
        id: "increase-active-resizable-width",
        action: event("increase-active-resizable-width"),
      },
      {
        label: mac ? "Contract Active Resizable" : "Contract active resizable",
        id: "decrease-active-resizable-width",
        action: event("decrease-active-resizable-width"),
      },
      separator(),
      {
        label: "&Reload",
        id: "reload-window",
        action: { type: "reload-window" },
        visible: __RELEASE_CHANNEL__ === "development",
      },
      {
        id: "show-devtools",
        label: mac ? "Toggle Developer Tools" : "&Toggle developer tools",
        action: { type: "show-devtools" },
        visible: __RELEASE_CHANNEL__ === "development",
      },
    ],
  });

  const pushEvent = isForcePushForCurrentRepository ? "force-push" : "push";
  const pushLabel = !isForcePushForCurrentRepository
    ? mac
      ? "Push"
      : "P&ush"
    : askForConfirmationOnForcePush
      ? mac
        ? "Force Push…"
        : "Force P&ush…"
      : mac
        ? "Force Push"
        : "Force P&ush";

  template.push({
    label: mac ? "Repository" : "&Repository",
    id: "repository",
    submenu: [
      { id: "push", label: pushLabel, action: event(pushEvent) },
      { id: "pull", label: mac ? "Pull" : "Pu&ll", action: event("pull") },
      { id: "fetch", label: mac ? "Fetch" : "&Fetch", action: event("fetch") },
      {
        label: removeRepoLabel,
        id: "remove-repository",
        action: event("remove-repository"),
      },
      separator(),
      {
        id: "view-repository-on-github",
        label: `${mac ? "View " : "&View "}${onGithubLabel(gitHubRepositoryType)}`,
        action: event("view-repository-on-github"),
      },
      {
        label: mac ? `Open in ${selectedShell ?? "Shell"}` : `O&pen in ${selectedShell ?? "shell"}`,
        id: "open-in-shell",
        action: event("open-in-shell"),
      },
      {
        label: mac ? "Show in Finder" : windows ? "Show in E&xplorer" : "Show in your File Manager",
        id: "open-working-directory",
        action: event("open-working-directory"),
      },
      {
        label: mac
          ? `Open in ${selectedExternalEditor ?? "External Editor"}`
          : `&Open in ${selectedExternalEditor ?? "external editor"}`,
        id: "open-external-editor",
        action: event("open-external-editor"),
      },
      {
        label: mac ? "Open With…" : "Open &with…",
        id: "open-with-external-editor",
        action: event("open-with-external-editor"),
      },
      separator(),
      {
        id: "create-issue-in-repository-on-github",
        label: `${mac ? "Create Issue " : "Create &issue "}${onGithubLabel(gitHubRepositoryType)}`,
        action: event("create-issue-in-repository-on-github"),
      },
      separator(),
      {
        id: "create-worktree",
        label: mac ? "New Worktree…" : "New work&tree…",
        action: event("create-worktree"),
      },
      separator(),
      {
        label: mac ? "Repository Settings…" : "Repository &settings…",
        id: "show-repository-settings",
        action: event("show-repository-settings"),
      },
      {
        id: "manage-remotes",
        label: mac ? "Manage Remotes…" : "Manage remotes…",
        action: event("manage-remotes"),
      },
    ],
  });

  const stashLabel = askForConfirmationWhenStashingAllChanges
    ? mac
      ? "Stash All Changes…"
      : "&Stash all changes…"
    : mac
      ? "Stash All Changes"
      : "&Stash all changes";
  template.push({
    label: mac ? "Branch" : "&Branch",
    id: "branch",
    submenu: [
      {
        label: mac ? "New Branch…" : "New &branch…",
        id: "create-branch",
        action: event("create-branch"),
      },
      {
        label: mac ? "Rename…" : "&Rename…",
        id: "rename-branch",
        action: event("rename-branch"),
      },
      {
        label: mac ? "Delete…" : "&Delete…",
        id: "delete-branch",
        action: event("delete-branch"),
      },
      separator(),
      {
        label: mac ? "Discard All Changes…" : "Discard all changes…",
        id: "discard-all-changes",
        action: event("discard-all-changes"),
      },
      {
        label: mac ? "Permanently Discard All Changes…" : "Permanently discard all changes…",
        id: "permanently-discard-all-changes",
        action: event("permanently-discard-all-changes"),
      },
      {
        label: stashLabel,
        id: "stash-all-changes",
        action: event("stash-all-changes"),
      },
      separator(),
      {
        label: `${mac ? "Update from " : "&Update from "}${contributionTargetDefaultBranch}`,
        id: "update-branch-with-contribution-target-branch",
        action: event("update-branch-with-contribution-target-branch"),
      },
      {
        label: mac ? "Compare to Branch" : "&Compare to branch",
        id: "compare-to-branch",
        action: event("compare-to-branch"),
      },
      {
        label: mac ? "Merge into Current Branch…" : "&Merge into current branch…",
        id: "merge-branch",
        action: event("merge-branch"),
      },
      {
        label: mac
          ? "Squash and Merge into Current Branch…"
          : "Squas&h and merge into current branch…",
        id: "squash-and-merge-branch",
        action: event("squash-and-merge-branch"),
      },
      {
        label: mac ? "Rebase Current Branch…" : "R&ebase current branch…",
        id: "rebase-branch",
        action: event("rebase-branch"),
      },
      separator(),
      {
        label: `Compare ${onGithubLabel(gitHubRepositoryType)}`,
        id: "compare-on-github",
        action: event("compare-on-github"),
      },
      {
        label: `${mac ? "View Branch " : "View branch "}${onGithubLabel(gitHubRepositoryType)}`,
        id: "branch-on-github",
        action: event("branch-on-github"),
      },
      {
        label: mac ? "Preview Pull Request" : "Preview pull request",
        id: "preview-pull-request",
        action: event("preview-pull-request"),
      },
      {
        label: pullRequestLabel,
        id: "create-pull-request",
        action: event("open-pull-request"),
      },
    ],
  });

  if (mac) {
    template.push({
      role: "window",
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
        separator(),
        { role: "front" },
      ],
    });
  }

  const helpItems: TemplateItem[] = [
    {
      label: mac ? "Report Issue…" : "Report issue…",
      action: {
        type: "open-external",
        url: "https://github.com/jabelardo/rdc/issues/new",
      },
    },
    {
      label: mac ? "View RDC on GitHub" : "View RDC on &GitHub",
      action: {
        type: "open-external",
        url: "https://github.com/jabelardo/rdc",
      },
    },
    {
      label: mac
        ? "Show Logs in Finder"
        : windows
          ? "S&how logs in Explorer"
          : "S&how logs in your File Manager",
      action: { type: "show-logs" },
    },
  ];
  helpItems.push(...buildTestMenu(platform));
  if (mac) {
    template.push({ role: "help", label: "Help", submenu: helpItems });
  } else {
    template.push({
      label: "&Help",
      submenu: [
        ...helpItems,
        separator(),
        {
          label: "&About RDC",
          id: "about",
          action: event("show-about"),
        },
      ],
    });
  }

  return normalizeTemplate(template);
}

function buildTestMenu(platform: MenuPlatform): ReadonlyArray<TemplateItem> {
  if (!enableTestMenuItems()) {
    return [];
  }

  const items: TemplateItem[] = [];
  if (platform === "windows") {
    items.push(separator(), {
      label: "Command Line Tool",
      submenu: [
        { label: "Install", action: event("install-windows-cli") },
        { label: "Uninstall", action: event("uninstall-windows-cli") },
      ],
    });
  }

  items.push(
    separator(),
    {
      label: "Show Dialog",
      submenu: [
        { id: "debug-about", label: "About", action: event("debug-show-about-dialog") },
        {
          id: "debug-preferences",
          label: "Preferences",
          action: event("debug-show-preferences-dialog"),
        },
        { id: "debug-clone", label: "Clone", action: event("debug-show-clone-dialog") },
        {
          id: "debug-show-discard-file-dialog",
          label: "Discard file…",
          action: event("debug-show-discard-file-dialog"),
        },
        {
          id: "debug-discard-all",
          label: "Discard all…",
          action: event("debug-show-discard-all-dialog"),
        },
        {
          id: "debug-rename-branch",
          label: "Rename branch…",
          action: event("debug-show-rename-branch-dialog"),
        },
        {
          id: "debug-delete-branch",
          label: "Delete branch…",
          action: event("debug-show-delete-branch-dialog"),
        },
        {
          id: "debug-merge-branch",
          label: "Merge…",
          action: event("debug-show-merge-dialog"),
        },
        {
          id: "debug-manage-remotes",
          label: "Manage remotes…",
          action: event("debug-show-manage-remotes-dialog"),
        },
        {
          id: "debug-hook-failure",
          label: "Hook failure…",
          action: event("debug-show-hook-failure-dialog"),
        },
        {
          id: "debug-show-add-remote-dialog",
          label: "Add remote…",
          action: event("debug-show-add-remote-dialog"),
        },
        {
          id: "debug-show-remove-repository-dialog",
          label: "Remove repository…",
          action: event("debug-show-remove-repository-dialog"),
        },
      ],
    },
    {
      label: "Crash main process…",
      action: { type: "crash-main-process" },
    },
    { label: "Crash renderer process…", action: event("boomtown") },
    { label: "Prune branches", action: event("test-prune-branches") },
    { label: "Show notification", action: event("test-notification") },
    { label: "Dispatch CLI action", action: event("test-cli-action") },
  );
  return items;
}

function onGithubLabel(type: RepoType | null) {
  switch (type) {
    case "github":
      return "on GitHub";
    case "bitbucket":
      return "on Bitbucket";
    case "gitlab":
      return "on GitLab";
    case "codeberg":
      return "on Codeberg";
    case null:
      return "in your browser";
  }
}
