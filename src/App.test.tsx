import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { IMenu } from "./models/app-menu";

const installApplicationMenu = vi.hoisted(() => vi.fn());
const replaceApplicationMenu = vi.hoisted(() => vi.fn());
const showContextMenu = vi.hoisted(() => vi.fn());
const showOpenDialog = vi.hoisted(() => vi.fn());
const showSaveDialog = vi.hoisted(() => vi.fn());
const initRepository = vi.hoisted(() => vi.fn());
// What the controller's one repository-availability check finds. Regular unless a test says
// otherwise; see "reports a deleted repository once".
const repositoryType = vi.hoisted(() => ({
  current: {
    kind: "regular",
    topLevelWorkingDirectory: "/projects/rdc",
    gitDir: "/projects/rdc/.git",
  } as { kind: "regular"; topLevelWorkingDirectory: string; gitDir: string } | { kind: "missing" },
}));
const showFolderContents = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn(async () => true));
const getAppArchitecture = vi.hoisted(() => vi.fn(async () => "arm64"));
const getMainProcessConfig = vi.hoisted(() => vi.fn());
const launchExternalEditor = vi.hoisted(() => vi.fn());
const launchShell = vi.hoisted(() => vi.fn());
const onNativeThemeUpdated = vi.hoisted(() => vi.fn());
const getCurrentWindowLabel = vi.hoisted(() => vi.fn());
const onWindowFocusChanged = vi.hoisted(() => vi.fn());
const sendReady = vi.hoisted(() => vi.fn());
const setWindowTitle = vi.hoisted(() => vi.fn());
const openRepositoryInNewWindow = vi.hoisted(() => vi.fn());
const startWindowDragging = vi.hoisted(() => vi.fn());
const maximizeWindow = vi.hoisted(() => vi.fn());
const minimizeWindow = vi.hoisted(() => vi.fn());
const restoreWindow = vi.hoisted(() => vi.fn());
const isWindowMaximized = vi.hoisted(() => vi.fn());
const getAppleActionOnDoubleClick = vi.hoisted(() => vi.fn());
const installDefaultCloseRequestHandler = vi.hoisted(() => vi.fn());
const appStore = vi.hoisted(() => ({
  state: {
    repositories: [] as Array<{ id: number; name: string; path: string }>,
    selectedRepository: null as {
      id: number;
      name: string;
      path: string;
    } | null,
  },
  load: vi.fn(),
  addRepository: vi.fn(),
  removeRepository: vi.fn(),
  selectRepository: vi.fn(),
  onDidUpdate: vi.fn(),
}));
const workingTreeStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    workingDirectory: null as {
      files: ReadonlyArray<{
        id: string;
        path: string;
        status: { kind: string };
        isIncludedInCommit: () => boolean;
        selection?: { isSelected: (line: number) => boolean };
      }>;
    } | null,
    selectedFileID: null as string | null,
    diff: null as {
      kind: number;
      text?: string;
      hunks?: ReadonlyArray<{
        unifiedDiffStart: number;
        lines: ReadonlyArray<{
          text: string;
          type?: number;
          content: string;
          oldLineNumber: number | null;
          newLineNumber: number | null;
          isIncludeableLine: () => boolean;
        }>;
      }>;
    } | null,
    diffLoading: false,
    diffError: null as string | null,
    commitLoading: false,
    commitError: null as string | null,
    hookFailure: null as {
      hook: string;
      terminalOutput: string;
    } | null,
    loading: false,
    error: null as string | null,
  },
  load: vi.fn(),
  selectFile: vi.fn(),
  setFileIncluded: vi.fn(),
  setAllFilesIncluded: vi.fn(),
  setLineIncluded: vi.fn(),
  discardFile: vi.fn(),
  getSelectedLinesDiscard: vi.fn(),
  discardSelectedLines: vi.fn(),
  commit: vi.fn(),
  resolveHookFailure: vi.fn(),
  stopHook: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
  onCommitTerminalOutput: vi.fn(),
}));
const historyStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    commits: [] as ReadonlyArray<{
      sha: string;
      shortSha: string;
      summary: string;
      body: string;
      bodyNoCoAuthors: string;
      author: { name: string; email: string; date: Date };
      committer: { name: string; email: string; date: Date };
      parentSHAs: ReadonlyArray<string>;
      tags: ReadonlyArray<string>;
    }>,
    selectedCommitSHA: null as string | null,
    changeset: null as {
      files: ReadonlyArray<{
        id: string;
        path: string;
        status: { kind: string };
      }>;
      linesAdded: number;
      linesDeleted: number;
    } | null,
    selectedFileID: null as string | null,
    loading: false,
    error: null as string | null,
    detailsLoading: false,
    detailsError: null as string | null,
    diff: null as {
      kind: number;
      text?: string;
      hunks?: ReadonlyArray<{
        unifiedDiffStart: number;
        lines: ReadonlyArray<{
          text: string;
          type?: number;
          oldLineNumber: number | null;
          newLineNumber: number | null;
        }>;
      }>;
    } | null,
    diffLoading: false,
    diffError: null as string | null,
  },
  load: vi.fn(),
  selectCommit: vi.fn(),
  selectFile: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
}));
const branchStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    branches: [] as ReadonlyArray<{
      name: string;
      ref: string;
      type: number;
      tip: { sha: string; author: { date: Date } };
    }>,
    currentBranch: null as string | null,
    defaultBranch: null as string | null,
    recentBranches: [] as ReadonlyArray<string>,
    loading: false,
    error: null as string | null,
    operation: null as "creating" | "checking-out" | null,
    progress: null as {
      description: string;
      value: number;
    } | null,
    operationError: null as string | null,
  },
  load: vi.fn(),
  createAndCheckout: vi.fn(),
  checkout: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
}));
const conflictStore = vi.hoisted(() => ({
  state: {
    repositoryPath: null as string | null,
    mergeInProgress: false,
    files: [] as ReadonlyArray<{
      path: string;
      status: { kind: string; conflictMarkerCount?: number };
      resolvedInWorkingTree: boolean;
    }>,
    loading: false,
    loadFailed: false,
    stagingPath: null as string | null,
  },
  load: vi.fn(),
  stageResolvedFile: vi.fn(),
  abortMerge: vi.fn(),
  clear: vi.fn(),
  onDidUpdate: vi.fn(),
}));
const preferencesStore = vi.hoisted(() => ({
  state: {
    theme: "system" as "light" | "dark" | "system",
    resolvedTheme: "light" as "light" | "dark",
    zoomFactor: 1.0,
    confirmRepositoryRemoval: true,
    confirmDiscardChanges: true,
    confirmDiscardChangesPermanently: true,
    defaultMergeStrategy: "merge" as const,
    selectedExternalEditor: "Zed" as string | null,
    selectedShell: "Ghostty" as string | null,
    editors: [{ editor: "Zed", path: "/applications/zed" }],
    shells: [{ shell: "Ghostty", path: "/applications/ghostty" }],
    loading: false,
    error: null as string | null,
  },
  selectedEditor: {
    editor: "Zed",
    path: "/applications/zed",
  } as { editor: string; path: string } | null,
  selectedShell: {
    shell: "Ghostty",
    path: "/applications/ghostty",
  } as { shell: string; path: string } | null,
  load: vi.fn(),
  refreshTheme: vi.fn(),
  setTheme: vi.fn(),
  setConfirmRepositoryRemoval: vi.fn(),
  setConfirmDiscardChanges: vi.fn(),
  setConfirmDiscardChangesPermanently: vi.fn(),
  setSelectedExternalEditor: vi.fn(),
  setSelectedShell: vi.fn(),
  setZoomFactor: vi.fn(),
  onDidUpdate: vi.fn(),
}));

vi.mock("./lib/menu/application-menu", () => ({ installApplicationMenu }));
vi.mock("./lib/platform/menu", () => ({
  showContextMenu,
  setNativeMenu: vi.fn(),
  onNativeMenuAction: vi.fn(),
}));
vi.mock("./lib/platform/dialogs", () => ({ showOpenDialog, showSaveDialog }));
vi.mock("./lib/git-ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/git-ipc")>()),
  initRepository,
}));
// The controller asks once whether the selected repository is still readable before loading the
// stores. Answer it here rather than leaning on the gate's fail-open path, so these tests exercise
// the same route the app takes.
vi.mock("./lib/misc-ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/misc-ipc")>()),
  // Reads the hoisted holder on every call rather than closing over a value, so a test can change
  // the answer without depending on which mock instance it happens to hold a reference to.
  getRepositoryType: vi.fn(async () => repositoryType.current),
}));
vi.mock("./lib/platform/config", () => ({ getMainProcessConfig }));
vi.mock("./lib/platform/files", () => ({ showFolderContents, openExternal }));
vi.mock("./lib/platform/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/platform/paths")>()),
  getAppArchitecture,
}));
vi.mock("./lib/platform/editors", () => ({ launchExternalEditor }));
vi.mock("./lib/platform/shells", () => ({ launchShell }));
vi.mock("./lib/platform/theme", () => ({ onNativeThemeUpdated }));
vi.mock("./lib/platform/lifetime", () => ({
  installDefaultCloseRequestHandler,
}));
vi.mock("./lib/platform/window", () => ({
  getCurrentWindowLabel,
  onWindowFocusChanged,
  openRepositoryInNewWindow,
  sendReady,
  setWindowTitle,
  startWindowDragging,
  maximizeWindow,
  minimizeWindow,
  restoreWindow,
  isWindowMaximized,
}));
vi.mock("./lib/platform/system", () => ({ getAppleActionOnDoubleClick }));
vi.mock("./lib/stores/default-app-store", () => ({
  getDefaultAppStore: () => appStore,
}));
vi.mock("./lib/stores/default-working-tree-store", () => ({
  getDefaultWorkingTreeStore: () => workingTreeStore,
}));
vi.mock("./lib/stores/default-history-store", () => ({
  getDefaultHistoryStore: () => historyStore,
}));
vi.mock("./lib/stores/default-branch-store", () => ({
  getDefaultBranchStore: () => branchStore,
}));
vi.mock("./lib/stores/default-conflict-store", () => ({
  getDefaultConflictStore: () => conflictStore,
}));
vi.mock("./lib/stores/default-preferences-store", () => ({
  getDefaultPreferencesStore: () => preferencesStore,
}));

const repository = {
  id: 7,
  name: "rdc",
  path: "/projects/rdc",
};

describe("App", () => {
  beforeEach(() => {
    repositoryType.current = {
      kind: "regular",
      topLevelWorkingDirectory: "/projects/rdc",
      gitDir: "/projects/rdc/.git",
    };
    installApplicationMenu.mockReset();
    replaceApplicationMenu.mockReset();
    replaceApplicationMenu.mockResolvedValue(undefined);
    installApplicationMenu.mockResolvedValue({
      dispose: vi.fn(),
      replaceMenu: replaceApplicationMenu,
    });
    showContextMenu.mockReset();
    showContextMenu.mockResolvedValue(undefined);
    showOpenDialog.mockReset();
    showOpenDialog.mockResolvedValue(null);
    showSaveDialog.mockReset();
    showSaveDialog.mockResolvedValue(null);
    initRepository.mockReset();
    initRepository.mockResolvedValue(undefined);
    showFolderContents.mockReset();
    showFolderContents.mockResolvedValue(undefined);
    getMainProcessConfig.mockReset();
    getMainProcessConfig.mockResolvedValue({
      titleBarStyle: "native",
      hideWindowOnQuit: false,
    });
    launchExternalEditor.mockReset();
    launchExternalEditor.mockResolvedValue(undefined);
    launchShell.mockReset();
    launchShell.mockResolvedValue(undefined);
    onNativeThemeUpdated.mockReset();
    onNativeThemeUpdated.mockResolvedValue(vi.fn());
    getCurrentWindowLabel.mockReset();
    getCurrentWindowLabel.mockReturnValue("repository-1");
    onWindowFocusChanged.mockReset();
    onWindowFocusChanged.mockResolvedValue(vi.fn());
    sendReady.mockReset();
    sendReady.mockResolvedValue(null);
    setWindowTitle.mockReset();
    setWindowTitle.mockResolvedValue(undefined);
    openRepositoryInNewWindow.mockReset();
    openRepositoryInNewWindow.mockResolvedValue(undefined);
    startWindowDragging.mockReset();
    startWindowDragging.mockResolvedValue(undefined);
    maximizeWindow.mockReset();
    maximizeWindow.mockResolvedValue(undefined);
    minimizeWindow.mockReset();
    minimizeWindow.mockResolvedValue(undefined);
    restoreWindow.mockReset();
    restoreWindow.mockResolvedValue(undefined);
    isWindowMaximized.mockReset();
    isWindowMaximized.mockResolvedValue(false);
    getAppleActionOnDoubleClick.mockReset();
    getAppleActionOnDoubleClick.mockResolvedValue("Maximize");
    installDefaultCloseRequestHandler.mockReset();
    installDefaultCloseRequestHandler.mockResolvedValue(vi.fn());
    appStore.state = {
      repositories: [],
      selectedRepository: null,
    };
    appStore.load.mockReset();
    appStore.load.mockResolvedValue(undefined);
    appStore.addRepository.mockReset();
    appStore.addRepository.mockResolvedValue(undefined);
    appStore.removeRepository.mockReset();
    appStore.removeRepository.mockResolvedValue(undefined);
    appStore.selectRepository.mockReset();
    appStore.selectRepository.mockResolvedValue(undefined);
    appStore.onDidUpdate.mockReset();
    appStore.onDidUpdate.mockReturnValue(vi.fn());
    workingTreeStore.state = {
      repositoryPath: null,
      workingDirectory: null,
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    workingTreeStore.load.mockReset();
    workingTreeStore.load.mockResolvedValue(undefined);
    workingTreeStore.selectFile.mockReset();
    workingTreeStore.selectFile.mockResolvedValue(undefined);
    workingTreeStore.setFileIncluded.mockReset();
    workingTreeStore.setAllFilesIncluded.mockReset();
    workingTreeStore.setLineIncluded.mockReset();
    workingTreeStore.discardFile.mockReset();
    workingTreeStore.discardFile.mockResolvedValue("discarded");
    workingTreeStore.getSelectedLinesDiscard.mockReset();
    workingTreeStore.getSelectedLinesDiscard.mockReturnValue({
      repositoryPath: repository.path,
      filePath: "Alpha.ts",
      diff: {},
      selectedLines: [1],
    });
    workingTreeStore.discardSelectedLines.mockReset();
    workingTreeStore.discardSelectedLines.mockResolvedValue(true);
    workingTreeStore.commit.mockReset();
    workingTreeStore.commit.mockResolvedValue(null);
    workingTreeStore.resolveHookFailure.mockReset();
    workingTreeStore.clear.mockReset();
    workingTreeStore.onDidUpdate.mockReset();
    workingTreeStore.onDidUpdate.mockReturnValue(vi.fn());
    workingTreeStore.onCommitTerminalOutput.mockReset();
    workingTreeStore.onCommitTerminalOutput.mockReturnValue(vi.fn());
    historyStore.state = {
      repositoryPath: null,
      commits: [],
      selectedCommitSHA: null,
      changeset: null,
      selectedFileID: null,
      loading: false,
      error: null,
      detailsLoading: false,
      detailsError: null,
      diff: null,
      diffLoading: false,
      diffError: null,
    };
    historyStore.load.mockReset();
    historyStore.load.mockResolvedValue(undefined);
    historyStore.selectCommit.mockReset();
    historyStore.selectCommit.mockResolvedValue(undefined);
    historyStore.selectFile.mockReset();
    historyStore.selectFile.mockResolvedValue(undefined);
    historyStore.clear.mockReset();
    historyStore.onDidUpdate.mockReset();
    historyStore.onDidUpdate.mockReturnValue(vi.fn());
    branchStore.state = {
      repositoryPath: null,
      branches: [],
      currentBranch: null,
      defaultBranch: null,
      recentBranches: [],
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    };
    branchStore.load.mockReset();
    branchStore.load.mockResolvedValue(undefined);
    branchStore.createAndCheckout.mockReset();
    branchStore.createAndCheckout.mockResolvedValue(false);
    branchStore.checkout.mockReset();
    branchStore.checkout.mockResolvedValue(false);
    branchStore.clear.mockReset();
    branchStore.onDidUpdate.mockReset();
    branchStore.onDidUpdate.mockReturnValue(vi.fn());
    conflictStore.state = {
      repositoryPath: null,
      mergeInProgress: false,
      files: [],
      loading: false,
      loadFailed: false,
      stagingPath: null,
    };
    conflictStore.load.mockReset();
    conflictStore.abortMerge.mockReset();
    conflictStore.abortMerge.mockResolvedValue(null);
    conflictStore.load.mockResolvedValue(undefined);
    conflictStore.stageResolvedFile.mockReset();
    conflictStore.stageResolvedFile.mockResolvedValue(false);
    conflictStore.clear.mockReset();
    conflictStore.onDidUpdate.mockReset();
    conflictStore.onDidUpdate.mockReturnValue(vi.fn());
    preferencesStore.state = {
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
    };
    preferencesStore.selectedEditor = {
      editor: "Zed",
      path: "/applications/zed",
    };
    preferencesStore.selectedShell = {
      shell: "Ghostty",
      path: "/applications/ghostty",
    };
    preferencesStore.load.mockReset();
    preferencesStore.load.mockResolvedValue(undefined);
    preferencesStore.refreshTheme.mockReset();
    preferencesStore.refreshTheme.mockResolvedValue(undefined);
    preferencesStore.setTheme.mockReset();
    preferencesStore.setTheme.mockResolvedValue(undefined);
    preferencesStore.setConfirmRepositoryRemoval.mockReset();
    preferencesStore.setConfirmDiscardChanges.mockReset();
    preferencesStore.setConfirmDiscardChangesPermanently.mockReset();
    preferencesStore.setSelectedExternalEditor.mockReset();
    preferencesStore.setSelectedShell.mockReset();
    preferencesStore.onDidUpdate.mockReset();
    preferencesStore.onDidUpdate.mockReturnValue(vi.fn());
  });

  it("reports readiness and installs native lifetime handling", () => {
    render(<App />);

    expect(sendReady).toHaveBeenCalledWith(expect.any(Number));
    expect(installDefaultCloseRequestHandler).toHaveBeenCalledOnce();
  });

  it("provides caught drag and double-click chrome when the native frame is overlaid", async () => {
    render(<App />);

    await vi.waitFor(() => {
      expect(document.querySelector(".window-drag-region") !== null).toBe(!__LINUX__);
    });
    const dragRegion = document.querySelector(".window-drag-region");
    expect(dragRegion?.querySelector("button")).toBeFalsy();
    if (dragRegion !== null) {
      fireEvent.mouseDown(dragRegion, { button: 0, detail: 1 });
      fireEvent.doubleClick(dragRegion);
      await vi.waitFor(() => {
        expect(startWindowDragging).toHaveBeenCalledOnce();
        expect(maximizeWindow).toHaveBeenCalledOnce();
      });
    }
  });

  it("installs the repository-derived application menu", () => {
    render(<App />);

    const configuration = installApplicationMenu.mock.calls[0][0];
    const initialMenu = configuration.initialMenu as IMenu;
    const items = initialMenu.items.flatMap((item) =>
      item.type === "submenuItem" ? [item, ...item.menu.items] : [item],
    );
    expect(items.find((item) => item.id === "add-local-repository")).toMatchObject({
      enabled: true,
    });
    expect(items.find((item) => item.id === "remove-repository")).toMatchObject({
      enabled: false,
    });
    expect(items.find((item) => item.id === "preferences")).toMatchObject({
      enabled: true,
    });
  });

  it("opens preferences from the native menu and updates MVP settings", async () => {
    const user = userEvent.setup();
    render(<App />);
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

    await act(() => executeMenuEvent("show-preferences"));

    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "dark");
    await user.selectOptions(screen.getByRole("combobox", { name: "External editor" }), "Zed");
    await user.selectOptions(screen.getByRole("combobox", { name: "Shell" }), "Ghostty");
    await user.click(
      screen.getByRole("checkbox", {
        name: "Removing a repository from rdc",
      }),
    );

    expect(preferencesStore.setTheme).toHaveBeenCalledWith("dark");
    expect(preferencesStore.setSelectedExternalEditor).toHaveBeenCalledWith("Zed");
    expect(preferencesStore.setSelectedShell).toHaveBeenCalledWith("Ghostty");
    expect(preferencesStore.setConfirmRepositoryRemoval).toHaveBeenCalledWith(false);
  });

  it("opens the clone progress preview from the debug menu", async () => {
    render(<App />);
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

    await act(() => executeMenuEvent("debug-show-clone-progress-dialog"));

    expect(screen.getByRole("alertdialog", { name: "Cloning in progress" })).toBeInTheDocument();
  });

  it("drives the clone progress preview 0→100 and then ends it", async () => {
    // The mock clone must exercise the live updates the dialog exists for — the bar moving and
    // the git line changing — and, being undismissable, must synthesize a completion rather than
    // lock the UI forever.
    vi.useFakeTimers();
    try {
      render(<App />);
      const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

      await act(() => executeMenuEvent("debug-show-clone-progress-dialog"));
      const dialog = screen.getByRole("alertdialog", { name: "Cloning in progress" });
      expect(dialog).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

      // One frame in, the bar and the line have moved: the bar left zero and the status now
      // reports the enumerating stage instead of the opening "Cloning into…" line.
      await act(async () => vi.advanceTimersByTime(667));
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).not.toBe("0");
      expect(screen.getByRole("status").textContent).toContain("Enumerating");

      // The rest of the frames and the synthetic finish close the dialog and unlock the UI.
      await act(async () => vi.advanceTimersByTime(8 * 667));
      expect(
        screen.queryByRole("alertdialog", { name: "Cloning in progress" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses a safe modal with Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(<App />);
    const [opener] = screen.getAllByRole("button", {
      name: "Clone repository",
    });

    await user.click(opener);
    expect(screen.getByRole("textbox", { name: "Repository URL" })).toHaveFocus();

    await user.keyboard("{Escape}");
    // Radix restores focus to the invoking element on close, asynchronously (the old hand-rolled
    // Modal did it synchronously). Wait for it rather than asserting mid-frame.
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Clone a repository" })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });
  });

  it("discards all changes from the native menu after the working tree loads", async () => {
    // The menu controller is installed once, so its callbacks must read live store state rather
    // than the state captured at first render. Mounting with an empty working tree and only then
    // delivering the files is the real sequence: the app starts with nothing selected, the user
    // picks a repository, and the files arrive afterwards.
    let notifyWorkingTree: ((state: unknown) => void) | undefined;
    workingTreeStore.onDidUpdate.mockImplementation((listener: (state: unknown) => void) => {
      notifyWorkingTree = listener;
      return vi.fn();
    });
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };

    render(<App />);
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

    workingTreeStore.state = {
      ...workingTreeStore.state,
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
    };
    act(() => notifyWorkingTree?.(workingTreeStore.state));

    await act(() => executeMenuEvent("discard-all-changes"));

    expect(screen.getByRole("alertdialog", { name: /discard all changes/i })).toBeInTheDocument();
  });

  it("opens an rdc About surface from the native menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

    await act(() => executeMenuEvent("show-about"));

    expect(screen.getByRole("dialog", { name: "About RDC" })).toHaveTextContent(
      `Version ${__APP_VERSION__}`,
    );
    expect(screen.getByText("A native Git client built with Tauri and Rust.")).toBeInTheDocument();

    // The architecture is appended so the version can be pasted into a bug report as one string.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "About RDC" })).toHaveTextContent(
        `Version ${__APP_VERSION__} (arm64)`,
      ),
    );

    // Links must route through openExternal rather than navigating the webview.
    await user.click(screen.getByRole("link", { name: "MIT License" }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/jabelardo/rdc/blob/main/LICENSE");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "About RDC" })).not.toBeInTheDocument();
  });

  it("launches the preferred editor and shell from native menu actions", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    const user = userEvent.setup();
    render(<App />);
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

    await executeMenuEvent("open-in-shell");
    await executeMenuEvent("open-external-editor");

    expect(launchShell).toHaveBeenCalledWith(preferencesStore.selectedShell, repository.path);
    expect(launchExternalEditor).toHaveBeenCalledWith(
      repository.path,
      preferencesStore.selectedEditor,
    );

    await user.click(screen.getByRole("button", { name: "Open in terminal" }));
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    await user.click(screen.getByRole("button", { name: "Show files" }));

    expect(launchShell).toHaveBeenCalledTimes(2);
    expect(launchExternalEditor).toHaveBeenCalledTimes(2);
    expect(showFolderContents).toHaveBeenCalledWith(repository.path);
  });

  it("shows a compact product empty state with the three real entry actions", () => {
    render(<App />);

    expect(screen.queryByRole("heading", { name: /rdc/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Add a repository to get started")).not.toBeInTheDocument();
    expect(screen.queryByText(/open an existing git repository/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create repository" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create repository" }).querySelector("svg"),
    ).toHaveClass("lucide-plus");
    expect(screen.getByRole("button", { name: "Add existing repository" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add existing repository" }).querySelector("svg"),
    ).toHaveClass("lucide-folder-plus");
    expect(screen.getByRole("button", { name: "Clone repository" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clone repository" }).querySelector("svg"),
    ).toHaveClass("lucide-copy");
    expect(screen.queryByText(/native integration harness/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/path\/to\/a\/git\/repository/i)).not.toBeInTheDocument();
  });

  it("renders backed sidebar panels as an exclusive accordion", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("button", { name: "Repositories" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Branches" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("button", { name: "Tags" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stashes")).not.toBeInTheDocument();
    expect(screen.queryByText("Submodules")).not.toBeInTheDocument();
    expect(screen.queryByText("Subtrees")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Branches" }));
    expect(screen.getByRole("button", { name: "Repositories" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Branches" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByRole("region", { name: "Repositories" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Repositories" }));
    expect(screen.getByRole("button", { name: "Repositories" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Branches" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "data-tooltip",
      "Expand sidebar",
    );
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const repositoriesRailButton = screen.getByRole("button", {
      name: "Repositories: No repository selected",
    });
    const branchesRailButton = screen.getByRole("button", {
      name: "Branches: No branch selected",
    });
    expect(repositoriesRailButton).toHaveAttribute(
      "data-tooltip",
      "Repositories: No repository selected",
    );
    expect(repositoriesRailButton.querySelector("svg")).toHaveClass("lucide-folder-tree");
    expect(branchesRailButton).toHaveAttribute("data-tooltip", "Branches: No branch selected");
    expect(branchesRailButton.querySelector("svg")).toHaveClass("lucide-git-branch");
    expect(screen.queryByRole("button", { name: "Branches" })).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Repositories: No repository selected",
      }),
    );
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repositories" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("places live branch selection in the Branches sidebar panel", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    branchStore.state = {
      repositoryPath: repository.path,
      branches: [
        {
          name: "main",
          ref: "refs/heads/main",
          type: 0,
          tip: {
            sha: "a".repeat(40),
            author: { date: new Date("2026-04-23T14:04:00") },
          },
        },
      ],
      currentBranch: "main",
      defaultBranch: "main",
      recentBranches: [],
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    };

    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Branches" }));

    const panel = screen.getByRole("region", { name: "Branches" });
    expect(panel).toContainElement(screen.getByRole("searchbox", { name: "Filter branches" }));
    expect(panel).toContainElement(screen.getByRole("button", { name: "main — current branch" }));
    const newBranchButton = screen.getByRole("button", { name: "New branch" });
    expect(newBranchButton).toHaveAttribute("aria-expanded", "false");
    expect(newBranchButton.querySelector(".lucide-split")).toBeInTheDocument();
    expect(setWindowTitle).toHaveBeenLastCalledWith("RDC — rdc — main");
    const toolbar = screen.getByRole("toolbar", {
      name: "Repository actions",
    });
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "New repository" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "Add local repository" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "Clone repository" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "Show files" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "Open in editor" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "Open in terminal" }));
    expect(toolbar).toContainElement(
      screen.getByRole("region", {
        name: "Remote synchronization",
      }),
    );
    expect(toolbar).not.toContainElement(screen.getByRole("list", { name: "Branches" }));
    expect(screen.queryByRole("button", { name: "Open in new window" })).not.toBeInTheDocument();
  });

  it("adds the directory selected by the native dialog", async () => {
    showOpenDialog.mockResolvedValue("/repo");
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getAllByRole("button", {
        name: /add existing repository/i,
      })[0],
    );

    expect(showOpenDialog).toHaveBeenCalledWith({
      title: "Choose a repository directory",
      properties: ["openDirectory", "createDirectory"],
    });
    expect(appStore.addRepository).toHaveBeenCalledWith("/repo");
  });

  it("creates and registers the directory selected by the native dialog", async () => {
    showSaveDialog.mockResolvedValue("/projects/new-repository");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Create repository" }));

    expect(showSaveDialog).toHaveBeenCalledWith({
      title: "Create a repository",
      properties: ["createDirectory"],
    });
    expect(initRepository).toHaveBeenCalledWith("/projects/new-repository", "main");
    expect(appStore.addRepository).toHaveBeenCalledWith("/projects/new-repository");
  });

  it("does nothing when the native directory dialog is dismissed", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getAllByRole("button", {
        name: /add existing repository/i,
      })[0],
    );

    expect(appStore.addRepository).not.toHaveBeenCalled();
  });

  it("consumes a startup repository action without diagnostic output", async () => {
    sendReady.mockResolvedValue({
      kind: "open-repository",
      path: "/repo/../repo",
      persistSelection: false,
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(appStore.addRepository).toHaveBeenCalledWith("/repo/../repo", false);
    });
    expect(screen.queryByText(/persist selection/i)).not.toBeInTheDocument();
  });

  it("renders store updates and selects a repository from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App />);

    act(() => {
      for (const [update] of appStore.onDidUpdate.mock.calls) {
        update({
          repositories: [repository],
          selectedRepository: null,
        });
      }
    });
    await user.click(screen.getByRole("button", { name: "Repositories" }));
    await user.click(screen.getByRole("button", { name: "Select rdc" }));

    expect(screen.getByRole("button", { name: "Select rdc" })).toHaveAttribute(
      "data-tooltip",
      "/projects/rdc",
    );
    expect(appStore.selectRepository).toHaveBeenCalledWith(repository);
  });

  it("navigates repository selection with arrows, Home and End", async () => {
    const secondRepository = {
      id: 8,
      name: "desktop-plus",
      path: "/projects/desktop-plus",
    };
    appStore.state = {
      repositories: [repository, secondRepository],
      selectedRepository: repository,
    };
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Repositories" }));
    const first = screen.getByRole("button", { name: "Select rdc" });
    const second = screen.getByRole("button", {
      name: "Select desktop-plus",
    });

    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(appStore.selectRepository).toHaveBeenLastCalledWith(secondRepository);
    expect(second).toHaveFocus();

    await user.keyboard("{Home}");
    expect(appStore.selectRepository).toHaveBeenLastCalledWith(repository);
    expect(first).toHaveFocus();

    await user.keyboard("{End}");
    expect(appStore.selectRepository).toHaveBeenLastCalledWith(secondRepository);
    expect(second).toHaveFocus();
  });

  it("filters repositories by name or path without changing selection", async () => {
    const secondRepository = {
      id: 8,
      name: "desktop-plus",
      path: "/projects/upstream/desktop-plus",
    };
    appStore.state = {
      repositories: [repository, secondRepository],
      selectedRepository: repository,
    };
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Repositories" }));

    const filter = screen.getByRole("searchbox", {
      name: "Filter repositories",
    });
    await user.type(filter, "upstream");

    expect(screen.queryByRole("button", { name: "Select rdc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select desktop-plus" })).toBeInTheDocument();
    expect(appStore.selectRepository).not.toHaveBeenCalled();
  });

  it("orders the selected-repository toolbar actions and keeps tooltips generic", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    render(<App />);

    const toolbar = screen.getByRole("toolbar", {
      name: "Repository actions",
    });
    expect(toolbar).not.toHaveTextContent(repository.name);
    expect(toolbar).not.toHaveTextContent(repository.path);
    const toolbarButtonNames = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>("button"),
    ).map((button) => button.getAttribute("aria-label"));
    expect(toolbarButtonNames.slice(0, 6)).toEqual([
      "New repository",
      "Add local repository",
      "Clone repository",
      "Show files",
      "Open in editor",
      "Open in terminal",
    ]);
    expect(screen.queryByRole("button", { name: "Open in new window" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New repository" }).querySelector("svg")).toHaveClass(
      "lucide-plus",
    );
    expect(
      screen.getByRole("button", { name: "Add local repository" }).querySelector("svg"),
    ).toHaveClass("lucide-folder-plus");
    expect(
      screen.getByRole("button", { name: "Clone repository" }).querySelector("svg"),
    ).toHaveClass("lucide-copy");
    expect(screen.getByRole("button", { name: "Fetch" }).querySelector("svg")).toHaveClass(
      "lucide-arrow-down-to-line",
    );
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    const tooltipLabels = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        "button[data-tooltip], .disabled-tooltip-anchor[data-tooltip]",
      ),
    ).map((tooltip) => tooltip.dataset.tooltip);
    expect(tooltipLabels).toEqual([
      "New repository",
      "Add local repository",
      "Clone repository",
      "Show in file manager",
      "Open in configured editor",
      "Open in terminal",
      "Fetch from remote",
      "Pull from remote",
      "Push to remote",
      "Show changes",
      "Show history",
    ]);
    for (const label of tooltipLabels) {
      expect(label).not.toContain(repository.name);
      expect(label).not.toContain("main");
      expect(label).not.toContain("origin");
    }
    // The stores load behind the controller's one repository-availability check, so they arrive a
    // turn later than the render.
    await waitFor(() => {
      expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path);
      expect(branchStore.load).toHaveBeenCalledWith(repository.path);
      expect(conflictStore.load).toHaveBeenCalledWith(repository.path);
    });
  });

  it("routes repository creation actions from the selected-repository toolbar", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "New repository" }));
    await user.click(screen.getByRole("button", { name: "Add local repository" }));
    await user.click(screen.getByRole("button", { name: "Clone repository" }));

    expect(showSaveDialog).toHaveBeenCalledOnce();
    expect(showOpenDialog).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Clone a repository" })).toBeInTheDocument();
  });

  it("lists branches, checks out a local branch, and creates from HEAD", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    branchStore.state = {
      repositoryPath: repository.path,
      branches: [
        {
          name: "main",
          ref: "refs/heads/main",
          type: 0,
          tip: {
            sha: "a".repeat(40),
            author: { date: new Date("2026-04-23T14:04:00") },
          },
        },
        {
          name: "topic",
          ref: "refs/heads/topic",
          type: 0,
          tip: {
            sha: "b".repeat(40),
            author: { date: new Date("2026-04-22T13:03:00") },
          },
        },
        {
          name: "origin/main",
          ref: "refs/remotes/origin/main",
          type: 1,
          tip: {
            sha: "a".repeat(40),
            author: { date: new Date("2026-04-21T12:02:00") },
          },
        },
      ],
      currentBranch: "main",
      defaultBranch: "main",
      recentBranches: ["topic"],
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    };
    branchStore.checkout.mockResolvedValue(true);
    branchStore.createAndCheckout.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Branches" }));

    const currentBranch = screen.getByRole("button", {
      name: "main — current branch",
    });
    expect(currentBranch).toHaveAttribute("aria-current", "true");
    expect(currentBranch).toHaveAttribute(
      "data-tooltip",
      "Current branch\nLast modified: 2026-04-23 14:04",
    );
    expect(screen.getByRole("heading", { name: "Default Branch" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent Branches" })).toBeInTheDocument();
    const topicBranch = screen.getByRole("button", { name: "Check out topic" });
    expect(topicBranch).toBeInTheDocument();
    expect(topicBranch).toHaveAttribute(
      "data-tooltip",
      "Check out branch\nLast modified: 2026-04-22 13:03",
    );
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();
    const filter = screen.getByRole("searchbox", { name: "Filter branches" });
    await user.type(filter, "topic");
    expect(screen.queryByRole("button", { name: "main — current branch" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check out topic" })).toBeInTheDocument();
    await user.clear(filter);
    await user.click(screen.getByRole("button", { name: "Check out topic" }));

    expect(branchStore.checkout).toHaveBeenCalledWith("topic");
    expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path);

    await user.click(screen.getByRole("button", { name: "New branch" }));
    await user.type(screen.getByRole("textbox", { name: "New branch name" }), "feature");
    await user.click(screen.getByRole("button", { name: "Create branch" }));

    expect(branchStore.createAndCheckout).toHaveBeenCalledWith("feature");
  });

  it("shows merge conflicts and stages an externally resolved file", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    conflictStore.state = {
      repositoryPath: repository.path,
      mergeInProgress: true,
      files: [
        {
          path: "resolved.txt",
          status: { kind: "Conflicted", conflictMarkerCount: 0 },
          resolvedInWorkingTree: true,
        },
        {
          path: "unresolved.txt",
          status: { kind: "Conflicted", conflictMarkerCount: 2 },
          resolvedInWorkingTree: false,
        },
      ],
      loading: false,
      loadFailed: false,
      stagingPath: null,
    };
    conflictStore.stageResolvedFile.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<App />);

    const conflicts = screen.getByRole("region", {
      name: "Merge conflicts",
    });
    expect(conflicts).toHaveTextContent("Merge in progress");
    expect(conflicts).toHaveTextContent("resolved.txtResolved");
    expect(conflicts).toHaveTextContent("unresolved.txt2 conflict markers");
    expect(
      screen.getByRole("button", {
        name: "Stage resolution for unresolved.txt",
      }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", {
        name: "Stage resolution for resolved.txt",
      }),
    );
    expect(conflictStore.stageResolvedFile).toHaveBeenCalledWith("resolved.txt");
    expect(workingTreeStore.load).toHaveBeenCalledWith(repository.path);

    await user.click(
      screen.getByRole("button", {
        name: "Refresh conflict state",
      }),
    );
    expect(conflictStore.load).toHaveBeenCalledWith(repository.path);
  });

  it("prepares complete repository history before changing the visible view", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    historyStore.state = {
      repositoryPath: null,
      commits: [
        {
          sha: "a".repeat(40),
          shortSha: "aaaaaaa",
          summary: "Start Phase 7c",
          body: "Render selected commit details.",
          bodyNoCoAuthors: "Render selected commit details.",
          author: {
            name: "Mona Lisa",
            email: "mona@example.com",
            date: new Date("2026-07-30T12:00:00Z"),
          },
          committer: {
            name: "Mona Lisa",
            email: "mona@example.com",
            date: new Date("2026-07-30T12:00:00Z"),
          },
          parentSHAs: ["b".repeat(40)],
          tags: ["phase-7c"],
        },
      ],
      selectedCommitSHA: "a".repeat(40),
      changeset: {
        files: [
          {
            id: "Modified+src/App.tsx",
            path: "src/App.tsx",
            status: { kind: "Modified" },
          },
        ],
        linesAdded: 7,
        linesDeleted: 2,
      },
      selectedFileID: "Modified+src/App.tsx",
      loading: false,
      error: null,
      detailsLoading: false,
      detailsError: null,
      diff: {
        kind: 0,
        text: "diff",
        hunks: [
          {
            unifiedDiffStart: 4,
            lines: [
              {
                text: "+selected commit diff",
                type: 1,
                oldLineNumber: null,
                newLineNumber: 12,
              },
            ],
          },
        ],
      },
      diffLoading: false,
      diffError: null,
    };
    let finishHistoryLoad: (() => void) | undefined;
    historyStore.load.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHistoryLoad = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(historyStore.load).toHaveBeenCalledWith(repository.path);
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector(".history")).toHaveAttribute("hidden");
    await act(async () => finishHistoryLoad?.());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    const history = screen.getByRole("region", { name: "History" });
    expect(history.querySelector(".history-list-pane")).not.toBeNull();
    expect(
      screen.getByRole("separator", { name: "Resize History commit list" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize History changed files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Selected commit details" }).closest(".history"),
    ).toBe(history);
    const selectedCommit = screen.getByRole("button", {
      name: /Start Phase 7c.*Mona Lisa/,
    });
    expect(selectedCommit).toHaveAttribute("aria-current", "true");
    expect(selectedCommit).not.toHaveTextContent("aaaaaaa");
    expect(history).toHaveTextContent("Render selected commit details.");
    expect(history).toHaveTextContent("Mona Lisa·aaaaaaa+7−2");
    const copyCommitHash = screen.getByRole("button", {
      name: "Copy full commit hash",
    });
    expect(copyCommitHash).toHaveAttribute("data-tooltip", "a".repeat(40));
    await user.click(copyCommitHash);
    expect(await navigator.clipboard.readText()).toBe("a".repeat(40));
    expect(history).toHaveTextContent("1 changed file");
    expect(screen.getByRole("img", { name: "Modified" })).toBeInTheDocument();
    expect(history).toHaveTextContent("+selected commit diff");
    expect(screen.getByRole("button", { name: "src/App.tsx" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("renders working-tree updates in frontend-owned order", () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    render(<App />);

    act(() => {
      for (const [update] of workingTreeStore.onDidUpdate.mock.calls) {
        update({
          repositoryPath: repository.path,
          workingDirectory: {
            files: [
              {
                id: "Modified+Alpha.ts",
                path: "Alpha.ts",
                status: { kind: "Modified" },
                isIncludedInCommit: () => true,
                selection: { isSelected: () => true },
              },
              {
                id: "Untracked+zeta.ts",
                path: "zeta.ts",
                status: { kind: "Untracked" },
                isIncludedInCommit: () => true,
                selection: { isSelected: () => true },
              },
            ],
          },
          selectedFileID: "Modified+Alpha.ts",
          diff: {
            kind: 0,
            text: "@@ -1 +1 @@\n-before\n+after",
            hunks: [
              {
                unifiedDiffStart: 0,
                lines: [
                  {
                    text: "@@ -1 +1 @@",
                    content: "@ -1 +1 @@",
                    oldLineNumber: null,
                    newLineNumber: null,
                    isIncludeableLine: () => false,
                  },
                  {
                    text: "-before",
                    content: "before",
                    oldLineNumber: 1,
                    newLineNumber: null,
                    isIncludeableLine: () => true,
                  },
                  {
                    text: "+after",
                    content: "after",
                    oldLineNumber: null,
                    newLineNumber: 1,
                    isIncludeableLine: () => true,
                  },
                ],
              },
            ],
          },
          diffLoading: false,
          diffError: null,
          commitLoading: false,
          commitError: null,
          hookFailure: null,
          loading: false,
          error: null,
        });
      }
    });

    expect(screen.getByRole("region", { name: "Changes" })).toHaveTextContent(
      /2 changed files.*Alpha\.ts.*zeta\.ts/,
    );
    expect(screen.getByRole("img", { name: "Modified" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "New" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "File diff" })).toHaveTextContent(/-before.*\+after/);
  });

  it("loads the diff for a changed file selected in the shell", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Alpha.ts" }));

    expect(workingTreeStore.selectFile).toHaveBeenCalledWith("Modified+Alpha.ts");
  });

  it("navigates changed files with the same keyboard contract", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
          {
            id: "Untracked+Beta.ts",
            path: "Beta.ts",
            status: { kind: "Untracked" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);
    const first = screen.getByRole("button", {
      name: "Alpha.ts",
    });
    const second = screen.getByRole("button", {
      name: "Beta.ts",
    });

    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(workingTreeStore.selectFile).toHaveBeenLastCalledWith("Untracked+Beta.ts");
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(workingTreeStore.selectFile).toHaveBeenLastCalledWith("Modified+Alpha.ts");
    expect(first).toHaveFocus();
  });

  it("changes inclusion using the displayed unified-diff index", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => false,
            selection: { isSelected: (line) => line !== 2 },
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: {
        kind: 0,
        text: "@@ -0,0 +1,2 @@\n+first\n+second",
        hunks: [
          {
            unifiedDiffStart: 0,
            lines: [
              {
                text: "@@ -0,0 +1,2 @@",
                type: 3,
                content: "@ -0,0 +1,2 @@",
                oldLineNumber: null,
                newLineNumber: null,
                isIncludeableLine: () => false,
              },
              {
                text: "+first",
                type: 1,
                content: "first",
                oldLineNumber: null,
                newLineNumber: 1,
                isIncludeableLine: () => true,
              },
              {
                text: "+second",
                type: 1,
                content: "second",
                oldLineNumber: null,
                newLineNumber: 2,
                isIncludeableLine: () => true,
              },
            ],
          },
        ],
      },
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);

    const first = screen.getByRole("checkbox", {
      name: "Include diff line 1: first",
    });
    const second = screen.getByRole("checkbox", {
      name: "Include diff line 2: second",
    });
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    const changes = screen.getByRole("region", { name: "Changes" }).closest(".changes-workspace");
    expect(changes).toContainElement(screen.getByRole("region", { name: "File diff" }));
    expect(changes).toContainElement(screen.getByRole("form", { name: "Commit changes" }));
    expect(document.querySelectorAll(".diff-line-add")).toHaveLength(2);
    expect(document.querySelectorAll(".diff-line-hunk")).toHaveLength(1);

    await user.click(second);

    expect(workingTreeStore.setLineIncluded).toHaveBeenCalledWith(2, true);

    const discardSelectedLines = screen.getByRole("button", {
      name: "Discard selected lines",
    });
    expect(discardSelectedLines.querySelector("svg")).toHaveClass("lucide-trash-2");
    await user.click(discardSelectedLines);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Selected changes cannot be restored from the operating system trash.",
    );
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(workingTreeStore.discardSelectedLines).toHaveBeenCalledWith(
      workingTreeStore.getSelectedLinesDiscard.mock.results[0].value,
    );
  });

  it("updates whole-file inclusion without staging eagerly", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("checkbox", { name: "Include Alpha.ts" }));

    expect(workingTreeStore.setFileIncluded).toHaveBeenCalledWith("Modified+Alpha.ts", false);
  });

  it("confirms before discarding a changed file", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Discard Alpha.ts" }));
    expect(workingTreeStore.discardFile).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", {
        name: "Confirm discard changes",
      }),
    ).toHaveTextContent("Changes can be restored from the operating system trash.");

    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(workingTreeStore.discardFile).toHaveBeenCalledWith("Modified+Alpha.ts", false);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("writes the discard opt-out only when the discard is confirmed", async () => {
    // Ported from desktop-plus, where the preference is written in discard(), not when the box is
    // ticked. Ticking it and then cancelling must leave the guard on an irreversible action intact.
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      ...workingTreeStore.state,
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Discard Alpha.ts" }));
    await user.click(screen.getByRole("checkbox", { name: "Do not show this message again" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(preferencesStore.setConfirmDiscardChanges).not.toHaveBeenCalled();

    // Reopening resets the box, so the earlier tick does not leak into the next confirmation.
    await user.click(screen.getByRole("button", { name: "Discard Alpha.ts" }));
    expect(
      screen.getByRole("checkbox", { name: "Do not show this message again" }),
    ).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Do not show this message again" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(preferencesStore.setConfirmDiscardChanges).toHaveBeenCalledWith(false);
  });

  it("lists every path a discard-all will affect, at any count", async () => {
    const fileAt = (index: number) => ({
      id: `Modified+file-${index}.ts`,
      path: `src/file-${index}.ts`,
      status: { kind: "Modified" },
      isIncludedInCommit: () => true,
    });
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      ...workingTreeStore.state,
      repositoryPath: repository.path,
      workingDirectory: { files: [fileAt(1), fileAt(2)] },
    };
    const user = userEvent.setup();
    render(<App />);
    const { executeMenuEvent } = installApplicationMenu.mock.calls[0][0];

    await act(() => executeMenuEvent("discard-all-changes"));

    // Scoped to the dialog: the same paths are listed in the working-tree pane behind it.
    const listed = within(screen.getByRole("alertdialog", { name: "Discard all changes" }));
    expect(
      listed.getByText("Are you sure you want to discard all changes to these 2 files:"),
    ).toBeInTheDocument();
    expect(listed.getByText("src/file-1.ts")).toBeInTheDocument();
    expect(listed.getByText("src/file-2.ts")).toBeInTheDocument();

    await user.click(listed.getByRole("button", { name: "Cancel" }));

    // A larger discard still says which files it covers. There is no cap past which the list is
    // replaced by a bare count — that told the user nothing exactly when they most wanted to check.
    workingTreeStore.state = {
      ...workingTreeStore.state,
      workingDirectory: {
        files: Array.from({ length: 40 }, (_unused, index) => fileAt(index)),
      },
    };
    await act(() => executeMenuEvent("discard-all-changes"));

    const many = within(screen.getByRole("alertdialog", { name: "Discard all changes" }));
    expect(
      many.getByText("Are you sure you want to discard all changes to these 40 files:"),
    ).toBeInTheDocument();
    expect(many.getByRole("list", { name: "Files to discard" })).toBeInTheDocument();
    expect(many.getAllByRole("listitem")).toHaveLength(40);
  });

  it("refuses every dismissal while a discard is in flight", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      ...workingTreeStore.state,
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
    };
    // Never settles, so the dialog stays in its in-flight state for the assertions.
    workingTreeStore.discardFile.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Discard Alpha.ts" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    // Losing the dialog mid-operation would leave no indication of whether it completed.
    expect(screen.getByRole("button", { name: "Discarding…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("discards immediately when file confirmation is disabled", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    preferencesStore.state.confirmDiscardChanges = false;
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Discard Alpha.ts" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(workingTreeStore.discardFile).toHaveBeenCalledWith("Modified+Alpha.ts", false);
  });

  it("cancels a discard without touching the working tree", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Untracked+notes.txt",
            path: "notes.txt",
            status: { kind: "Untracked" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Untracked+notes.txt",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Discard notes.txt" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(workingTreeStore.discardFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("requires a second warning before permanent deletion after trash fails", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Untracked+notes.txt",
            path: "notes.txt",
            status: { kind: "Untracked" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Untracked+notes.txt",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    workingTreeStore.discardFile
      .mockResolvedValueOnce("trash-failed")
      .mockResolvedValueOnce("discarded");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Discard notes.txt" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(
      screen.getByRole("alertdialog", {
        name: "Permanently discard changes",
      }),
    ).toHaveTextContent("Changes cannot be restored after deletion.");

    await user.click(
      screen.getByRole("button", {
        name: "Permanently discard changes",
      }),
    );

    expect(workingTreeStore.discardFile.mock.calls).toEqual([
      ["Untracked+notes.txt", false],
      ["Untracked+notes.txt", true],
    ]);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("commits the frontend message and clears it after success", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    workingTreeStore.commit.mockResolvedValue("a".repeat(40));
    const user = userEvent.setup();
    render(<App />);

    const message = screen.getByRole("textbox", {
      name: "Commit summary",
    });
    await user.type(message, "Commit from rdc");
    await user.click(screen.getByText("Commit options"));
    await user.click(
      screen.getByRole("checkbox", {
        name: "Bypass hooks",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Commit 1 file" }));

    expect(workingTreeStore.commit).toHaveBeenCalledWith("Commit from rdc", true);
    await vi.waitFor(() => expect(message).toHaveValue(""));
  });

  it("offers abort and ignore when an intercepted hook fails", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    const user = userEvent.setup();
    render(<App />);
    const [listener] = workingTreeStore.onDidUpdate.mock.calls[0];

    act(() =>
      listener({
        ...workingTreeStore.state,
        hookFailure: {
          hook: "pre-commit",
          terminalOutput: "lint failed",
        },
        commitLoading: true,
      }),
    );

    const dialog = screen.getByRole("alertdialog", { name: /hook failed/i });
    expect(dialog).toHaveTextContent("pre-commit");
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ignore and Continue" }));
    expect(workingTreeStore.resolveHookFailure).toHaveBeenCalledWith("ignore");
  });

  it("shows live commit terminal output and clears it with the buffer", () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    workingTreeStore.state = {
      repositoryPath: repository.path,
      workingDirectory: {
        files: [
          {
            id: "Modified+Alpha.ts",
            path: "Alpha.ts",
            status: { kind: "Modified" },
            isIncludedInCommit: () => true,
          },
        ],
      },
      selectedFileID: "Modified+Alpha.ts",
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: true,
      commitError: null,
      hookFailure: null,
      loading: false,
      error: null,
    };
    render(<App />);
    const [listener] = workingTreeStore.onCommitTerminalOutput.mock.calls[0];

    act(() => listener("running pre-commit hook"));

    expect(screen.getByRole("alertdialog", { name: "Committing in progress" })).toBeInTheDocument();
    expect(screen.getByLabelText("Commit terminal output")).toHaveTextContent(
      "running pre-commit hook",
    );

    act(() => listener(""));

    expect(screen.queryByLabelText("Commit terminal output")).not.toBeInTheDocument();
  });

  it("opens a repository contextual menu on secondary click", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Repositories" }));
    await user.pointer({
      target: screen.getByRole("button", { name: "Select rdc" }),
      keys: "[MouseRight]",
    });

    expect(showContextMenu).toHaveBeenCalledOnce();
    expect(showContextMenu.mock.calls[0][0]).toMatchObject([
      { text: "Open in New Window" },
      { text: "Show in File Manager" },
      { type: "separator" },
      { text: "Manage remotes…" },
      { text: "Remove" },
    ]);
  });

  it("routes contextual repository actions through the owning seams", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    showContextMenu.mockImplementation(async (items) => {
      items[0].action();
      items[1].action();
      items[4].action();
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Repositories" }));
    await user.pointer({
      target: screen.getByRole("button", { name: "Select rdc" }),
      keys: "[MouseRight]",
    });

    expect(openRepositoryInNewWindow).toHaveBeenCalledWith(repository.path);
    expect(showFolderContents).toHaveBeenCalledWith(repository.path);
    expect(screen.getByRole("alertdialog", { name: "Remove repository" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove repository" }));
    expect(appStore.removeRepository).toHaveBeenCalledWith(repository);
  });

  // BRANCH_OPERATIONS_PLAN.md Slice 4. Aborting throws away uncommitted conflict resolution, so it
  // is destructive and asks first — and the confirmation obeys Convention 17.
  it("confirms before aborting a merge, and keeps the dialog on failure", async () => {
    appStore.state = { repositories: [repository], selectedRepository: repository };
    conflictStore.state = {
      ...conflictStore.state,
      repositoryPath: repository.path,
      mergeInProgress: true,
    };
    conflictStore.abortMerge.mockResolvedValueOnce("merge is not in progress");
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Abort merge" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Abort merge" });
    expect(conflictStore.abortMerge).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent(/discarded/);

    await user.click(within(dialog).getByRole("button", { name: "Abort merge" }));

    expect(conflictStore.abortMerge).toHaveBeenCalledOnce();
    expect(await within(dialog).findByText("merge is not in progress")).toBeInTheDocument();

    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    expect(screen.queryByRole("alertdialog", { name: "Abort merge" })).not.toBeInTheDocument();
  });

  // Convention 17: the dialog owns the failure of the action it confirmed, so it may not dismiss
  // before that action settles — and it must stay escapable for a user who cannot retry.
  it("keeps the remove-repository dialog open on failure, with a way out", async () => {
    appStore.state = {
      repositories: [repository],
      selectedRepository: repository,
    };
    vi.mocked(appStore.removeRepository).mockRejectedValueOnce(new Error("repository is busy"));
    showContextMenu.mockImplementation(async (items) => {
      items[4].action();
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Repositories" }));
    await user.pointer({
      target: screen.getByRole("button", { name: "Select rdc" }),
      keys: "[MouseRight]",
    });
    await user.click(screen.getByRole("button", { name: "Remove repository" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Remove repository" });
    expect(await within(dialog).findByText("repository is busy")).toBeInTheDocument();

    // The way out. Without it a repository that cannot be removed is a dialog with no exit.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    await user.click(cancel);

    expect(
      screen.queryByRole("alertdialog", { name: "Remove repository" }),
    ).not.toBeInTheDocument();
  });
});
