import { useCallback, useEffect, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { BranchType, type Branch } from "../../../models/branch";
import type { Commit } from "../../../models/commit";
import { nameOf, type Repository } from "../../../models/repository";
import { getCloneDirectoryName } from "../../clone-destination";
import { isContiguousSelection, orderSelectedCommits } from "../../history-operation-selection";
import { getMergedBranches } from "../../branch-ipc";
import { abortMerge, abortRebase, continueRebase, initRepository } from "../../git-ipc";
import { abortRevert, getRepositoryType, revertCommit } from "../../misc-ipc";
import { repositoryAvailability } from "../../repository-availability";
import { reportErrorMessage } from "../../format-error";
import { abortCherryPick, cherryPick, continueCherryPick, reorder, squash } from "../../stash-ipc";
import { installApplicationMenu } from "../../menu/application-menu";
import { showContextMenu } from "../../platform/menu";
import { dismissAllTooltips } from "../tooltip";
import { currentMenuPlatform } from "../../menu/default-menu";
import { buildRepositoryMenu, createRepositoryMenuEventExecutor } from "../../menu/repository-menu";
import { getMainProcessConfig } from "../../platform/config";
import { showOpenDialog, showSaveDialog } from "../../platform/dialogs";
import { launchExternalEditor } from "../../platform/editors";
import {
  debugMergePreview,
  debugMergedBranches,
  debugRebasePreview,
  injectCloneProgress,
  injectDebugState,
  isDebugStateInjected,
} from "../../debug/inject-test-state";
import { showFolderContents } from "../../platform/files";
import { getAppArchitecture, type Architecture } from "../../platform/paths";
import { installDefaultCloseRequestHandler } from "../../platform/lifetime";
import { launchShell } from "../../platform/shells";
import { onNativeThemeUpdated } from "../../platform/theme";
import { useQaStateDriver } from "./use-qa-state-driver";
import {
  getCurrentWindowLabel,
  onWindowFocusChanged,
  openRepositoryInNewWindow,
  sendReady,
  setWindowTitle,
} from "../../platform/window";
import { shouldShowWindowDragRegion } from "../../platform/window-drag-region";
import { setWindowZoomFactor } from "../../platform/window";
import type { AppStoreState } from "../../stores/app-store";
import type { BranchState } from "../../stores/branch-store";
import type { MergeInitiationResult, RebaseInitiationResult } from "../../stores/branch-store";
import type { CloneState } from "../../stores/clone-store";
import type { ConflictState } from "../../stores/conflict-store";
import { getDefaultAppStore } from "../../stores/default-app-store";
import { getDefaultBranchStore } from "../../stores/default-branch-store";
import { getDefaultCloneStore } from "../../stores/default-clone-store";
import { describeError, reportError } from "../../format-error";
import { getDefaultConflictStore } from "../../stores/default-conflict-store";
import { getDefaultHistoryStore } from "../../stores/default-history-store";
import { getDefaultMessageStore } from "../../stores/default-message-store";
import { getDefaultPreferencesStore } from "../../stores/default-preferences-store";
import { getDefaultRemoteStore } from "../../stores/default-remote-store";
import { getDefaultWorkingTreeStore } from "../../stores/default-working-tree-store";
import type { HistoryState } from "../../stores/history-store";
import type { MessageState } from "../../stores/message-store";
import type { PreferencesState } from "../../stores/preferences-store";
import type { RemoteState } from "../../stores/remote-store";
import type { SelectedLinesDiscard, WorkingTreeState } from "../../stores/working-tree-store";
import type { SidebarSectionID } from "../sidebar-sections";
import { determineMergeability } from "../../misc-ipc";
import { getAheadBehind } from "../../rev-list-ipc";
import { revSymmetricDifference } from "../../rev-range";
import { ComputedAction } from "../../../models/computed-action";
import type { MergeTreeResult } from "../../../models/merge";
import type { MergeStrategy } from "../../../models/merge-strategy";
import type { RebasePreview } from "../../../models/rebase-preview";
import { OperationStore } from "../../stores/operation-store";
import { isTerminalOperation } from "../../operation-presentation";

const rendererStartTime = performance.now();
const rendererPlatform = currentMenuPlatform();
export type RepositoryView = "changes" | "history";

export function useAppController() {
  const [appStore] = useState(getDefaultAppStore);
  const [branchStore] = useState(getDefaultBranchStore);
  const [cloneStore] = useState(getDefaultCloneStore);
  const [conflictStore] = useState(getDefaultConflictStore);
  const [historyStore] = useState(getDefaultHistoryStore);
  const [messageStore] = useState(getDefaultMessageStore);
  const [preferencesStore] = useState(getDefaultPreferencesStore);
  const [remoteStore] = useState(getDefaultRemoteStore);
  const [workingTreeStore] = useState(getDefaultWorkingTreeStore);
  const [appState, setAppState] = useState<AppStoreState>(appStore.state);
  /**
   * Answers "can this repository still be read?" once, before the stores that would each answer it
   * separately.
   *
   * Five stores load a repository with five git commands. Delete the directory out from under the
   * app and every one of them fails independently, in its own words — Phase 8b cycle 2 caught two
   * toasts naming `getBranches` and `getStatus` plus an inline block, from one deleted directory.
   * Coalescing cannot merge those, because they are not the same sentence.
   *
   * Asking here makes it one condition with one wording, and stops the loads rather than letting
   * each store discover the same thing the hard way. The check costs one `git rev-parse` against
   * the four or five the refresh was going to run anyway.
   */
  const repositoryIsAvailable = useCallback(
    async (repository: Repository): Promise<boolean> => {
      let availability;
      try {
        availability = repositoryAvailability(
          nameOf(repository),
          await getRepositoryType(repository.path),
        );
      } catch (error) {
        // Fail open. This gate exists to improve how a missing repository is *reported*; if the gate
        // itself cannot answer, refusing to load anything would be a far worse failure than the one
        // it prevents. Let the stores run and report in their own words, as they did before.
        log.warn("Could not check whether the repository is still available", error);
        return true;
      }
      if (availability.available) {
        return true;
      }
      // Identical wording every time, so the message store collapses repeat discoveries into one
      // message with a count rather than a stack of near-duplicates.
      reportErrorMessage(availability.message);
      branchStore.clear();
      conflictStore.clear();
      remoteStore.clear();
      workingTreeStore.clear();
      historyStore.clear();
      return false;
    },
    [branchStore, conflictStore, historyStore, remoteStore, workingTreeStore],
  );

  const [operationStore] = useState(() => new OperationStore(""));
  const [operationState, setOperationState] = useState(operationStore.state);
  const [workingTreeState, setWorkingTreeState] = useState<WorkingTreeState>(
    workingTreeStore.state,
  );
  const [historyState, setHistoryState] = useState<HistoryState>(historyStore.state);
  const [messageState, setMessageState] = useState<MessageState>(messageStore.state);
  const [remoteState, setRemoteState] = useState<RemoteState>(remoteStore.state);
  const [preferencesState, setPreferencesState] = useState<PreferencesState>(
    preferencesStore.state,
  );
  const [branchState, setBranchState] = useState<BranchState>(branchStore.state);
  const [cloneState, setCloneState] = useState<CloneState>(cloneStore.state);
  const [conflictState, setConflictState] = useState<ConflictState>(conflictStore.state);
  const [repositoryView, setActiveRepositoryView] = useState<RepositoryView>("changes");
  const activeRepositoryView = useRef<RepositoryView>("changes");
  const pendingRepositoryView = useRef<RepositoryView | null>(null);
  const repositoryViewTransitionID = useRef(0);
  const refreshedRecoveryOperationID = useRef<string | null>(null);
  const refreshedTerminalOperationID = useRef<string | null>(null);
  // The debug clone preview's frame timer, cleared on teardown so it never fires against an
  // unmounted controller.
  const clonePreviewTimer = useRef<number | undefined>(undefined);
  // Clear the timer when the controller goes away; without this a pending preview could call
  // setState against an unmounted hook after disposal.
  useEffect(() => () => window.clearInterval(clonePreviewTimer.current), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [expandedSidebarSections, setExpandedSidebarSections] = useState<
    ReadonlySet<SidebarSectionID>
  >(() => new Set<SidebarSectionID>());
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [showBranchCreation, setShowBranchCreation] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(264);
  const [bypassHooks, setBypassHooks] = useState(false);
  const [commitTerminalOutput, setCommitTerminalOutput] = useState("");
  const [discardFileID, setDiscardFileID] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [permanentlyDiscard, setPermanentlyDiscard] = useState(false);
  const [discardSelection, setDiscardSelection] = useState(false);
  const [selectedLinesDiscard, setSelectedLinesDiscard] = useState<SelectedLinesDiscard | null>(
    null,
  );
  const [discardAll, setDiscardAll] = useState<{
    readonly permanent: boolean;
    // Every path, because the dialog lists every path. A snapshot rather than a live read so the
    // list cannot change under the user while they are deciding.
    readonly paths: ReadonlyArray<string>;
  } | null>(null);
  // Reset whenever a discard dialog opens, and written to preferences only on confirm — ticking the
  // box and then cancelling must not remove the guard (see ConfirmOptOut).
  const [discardOptOut, setDiscardOptOut] = useState(false);
  const [branchToRename, setBranchToRename] = useState<Branch | null>(null);
  const [renameName, setRenameName] = useState("");
  const [branchToDelete, setBranchToDelete] = useState<Branch | null>(null);
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const [deleteUnmerged, setDeleteUnmerged] = useState(false);
  const [deletePruneTrackingRef, setDeletePruneTrackingRef] = useState(false);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeMessage, setMergeMessage] = useState<string | null>(null);
  const [mergeRunning, setMergeRunning] = useState(false);
  // Seeded from the preference each time the dialog opens, not once at mount: the preference can
  // change in Preferences while the app runs, and the dialog should honour the current value.
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>(
    preferencesStore.state.defaultMergeStrategy,
  );
  const [mergeStatus, setMergeStatus] = useState<MergeTreeResult | null>(null);
  // Distinct from a status: "we could not work out whether this can merge" is not the same claim as
  // any ComputedAction, and collapsing it into one was reporting failures as "already up to date".
  const [mergePreviewError, setMergePreviewError] = useState<string | null>(null);
  // `git branch --merged`'s ref-to-SHA map for the current branch. One call on open, not one per
  // branch — and keeping the SHAs is what lets a remote branch on an already-merged commit be
  // recognised, since --merged itself reports only local refs.
  const [mergedBranches, setMergedBranches] = useState<ReadonlyMap<string, string>>(new Map());
  const [mergeCommitCount, setMergeCommitCount] = useState(0);
  const [rebasePickerOpen, setRebasePickerOpen] = useState(false);
  const [rebaseTarget, setRebaseTarget] = useState("");
  const [rebasePreview, setRebasePreview] = useState<RebasePreview | null>(null);
  const [rebaseRunning, setRebaseRunning] = useState(false);
  const [rebaseMessage, setRebaseMessage] = useState<string | null>(null);
  // Distinct from a preview: "we could not work out how far apart these branches are" is not the
  // same claim as any ComputedAction, and collapsing it into one reported failures as "up to date".
  const [rebasePreviewError, setRebasePreviewError] = useState<string | null>(null);
  const [showManageRemotes, setShowManageRemotes] = useState(false);
  const [remoteFilter, setRemoteFilter] = useState("");
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [addRemoteName, setAddRemoteName] = useState("");
  const [addRemoteURL, setAddRemoteURL] = useState("");
  const [manageRemoteError, setManageRemoteError] = useState<string | null>(null);
  const [manageRunning, setManageRunning] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  // Resolved once and shown in About, where it exists so a version string can be pasted
  // into a bug report complete with the architecture it was running under.
  const [appArchitecture, setAppArchitecture] = useState<Architecture | null>(null);
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);
  const [repositoryToRemove, setRepositoryToRemove] = useState<Repository | null>(null);
  const [removeRepositoryError, setRemoveRepositoryError] = useState<string | null>(null);
  const [removingRepository, setRemovingRepository] = useState(false);
  const [cloneURL, setCloneURL] = useState("");
  const [clonePath, setClonePath] = useState("");
  const [showWindowDragRegion, setShowWindowDragRegion] = useState(
    shouldShowWindowDragRegion(rendererPlatform, "native"),
  );

  useEffect(() => {
    if (rendererPlatform !== "linux") {
      return;
    }
    void getMainProcessConfig()
      .then((config) => {
        setShowWindowDragRegion(shouldShowWindowDragRegion(rendererPlatform, config.titleBarStyle));
      })
      .catch((error) => {
        log.error("Failed to resolve native title-bar configuration", error);
      });
  }, []);

  useEffect(() => {
    const repository = appState.selectedRepository;
    const title =
      repository === null
        ? "RDC"
        : `RDC — ${repository.name}${
            branchState.currentBranch === null ? "" : ` — ${branchState.currentBranch}`
          }`;
    void setWindowTitle(title).catch((error) => {
      log.error("Failed to update native window title", error);
    });
  }, [appState.selectedRepository, branchState.currentBranch]);

  useEffect(() => operationStore.onDidUpdate(setOperationState), [operationStore]);

  useEffect(() => {
    let disposed = false;
    const label = getCurrentWindowLabel();
    if (!disposed) {
      operationStore.setWindowLabel(label);
    }
    return () => {
      disposed = true;
      operationStore.dispose();
    };
  }, [operationStore]);

  useEffect(() => {
    if (appState.selectedRepository === null) {
      return;
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void operationStore.refreshActiveOperation().catch((error) => {
          log.error("Failed to reconcile the repository operation", error);
        });
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [appState.selectedRepository, operationStore]);

  useEffect(() => {
    void operationStore
      .selectRepository(appState.selectedRepository?.path ?? null)
      .catch((error) => {
        log.error("Failed to select the repository operation", error);
      });
  }, [appState.selectedRepository?.path, operationStore]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onWindowFocusChanged((focused) => {
      if (focused) {
        void operationStore.refreshActiveOperation().catch((error) => {
          log.error("Failed to refresh the focused repository operation", error);
        });
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [operationStore]);

  useEffect(() => {
    const operation = operationState.operation;
    const repository = appState.selectedRepository;
    if (
      operation === null ||
      repository === null ||
      !isTerminalOperation(operation.state) ||
      refreshedTerminalOperationID.current === operation.id
    ) {
      return;
    }
    refreshedTerminalOperationID.current = operation.id;
    void repositoryIsAvailable(repository)
      .then(async (available) => {
        if (!available) {
          return;
        }
        await Promise.all([
          branchStore.load(repository.path),
          operation.refresh?.repositoryFacts === false
            ? Promise.resolve()
            : remoteStore.load(repository.path),
          workingTreeStore.load(repository.path),
          conflictStore.load(repository.path),
          historyStore.state.repositoryPath === repository.path
            ? historyStore.load(repository.path)
            : Promise.resolve(),
        ]);
      })
      .catch((error) => {
        log.error("Failed to refresh after a terminal repository operation", error);
      });
  }, [
    appState.selectedRepository,
    branchStore,
    conflictStore,
    historyStore,
    operationState.operation,
    remoteStore,
    repositoryIsAvailable,
    workingTreeStore,
  ]);

  useEffect(() => {
    const operation = operationState.operation;
    const repository = appState.selectedRepository;
    if (
      operation === null ||
      repository === null ||
      operation.state !== "recovering" ||
      (operation.operation !== "cherryPick" && operation.operation !== "revert") ||
      refreshedRecoveryOperationID.current === operation.id
    ) {
      return;
    }
    // The operation can enter recovery before the status event that created the conflict files
    // reaches the renderer. Refresh here so recovery controls never infer that every file is
    // resolved from the repository-selection snapshot.
    refreshedRecoveryOperationID.current = operation.id;
    void repositoryIsAvailable(repository)
      .then((available) => (available ? conflictStore.load(repository.path) : undefined))
      .catch((error) => {
        log.error("Failed to refresh history recovery conflicts", error);
      });
  }, [appState.selectedRepository, conflictStore, operationState.operation, repositoryIsAvailable]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void installDefaultCloseRequestHandler()
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        log.error("Failed to install the native close handler", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // This controller is installed once and reads changing menu data from store subscriptions.
  // Its action callbacks use stable stores/setters rather than render-time state. The planned
  // App decomposition will turn them into stable callbacks; recreating the native menu controller
  // on every render in the meantime would be the behavioral regression.
  // oxlint-disable react-hooks/exhaustive-deps
  useEffect(() => {
    let disposed = false;
    let controller: Awaited<ReturnType<typeof installApplicationMenu>> | undefined;
    let updatePending = false;
    let latestState = appStore.state;
    let latestRemoteState = remoteStore.state;
    let latestPreferencesState = preferencesStore.state;
    let latestOperationActive =
      operationStore.state.operation !== null &&
      !isTerminalOperation(operationStore.state.operation.state);
    const platform = rendererPlatform;
    const executeMenuEvent = createRepositoryMenuEventExecutor(appStore, {
      createRepository,
      addLocalRepository: addExistingRepository,
      chooseRepository: () => {
        document
          .querySelector<HTMLElement>('[aria-label="Repositories"] [aria-current="true"]')
          ?.focus();
      },
      showChanges: () => selectRepositoryView("changes"),
      showHistory: () => selectRepositoryView("history"),
      openRepositoryInNewWindow,
      showFolderContents,
      fetch: refreshAfterFetch,
      push: refreshAfterPush,
      pull: refreshAfterPull,
      showClone: openCloneDialog,
      showAbout: () => setShowAboutDialog(true),
      showPreferences: () => setShowPreferencesDialog(true),
      removeRepository: requestRemoveRepository,
      openInShell,
      openInExternalEditor,
      showBranches,
      goToCommitMessage,
      increaseActiveResizableWidth,
      decreaseActiveResizableWidth,
      createBranch,
      discardAllChanges: () => requestDiscardAll(false),
      permanentlyDiscardAllChanges: () => requestDiscardAll(true),
      renameBranch: renameCurrentBranch,
      deleteBranch: deleteCurrentBranch,
      mergeBranch: requestMerge,
      manageRemotes: requestManageRemotes,
      showDiscardFileDialog: () => {
        injectDebugState();
        const firstFile = workingTreeStore.state.workingDirectory?.files[0];
        if (firstFile !== undefined) {
          setDiscardFileID(firstFile.id);
          setDiscardSelection(false);
          setPermanentlyDiscard(false);
        }
      },
      showAddRemoteDialog: () => {
        injectDebugState();
        setShowAddRemote(true);
      },
      showRemoveRepositoryDialog: () => {
        injectDebugState();
        if (appStore.state.selectedRepository !== null) {
          setRepositoryToRemove(appStore.state.selectedRepository);
        }
      },
      debugShowAboutDialog: () => setShowAboutDialog(true),
      debugShowPreferencesDialog: () => setShowPreferencesDialog(true),
      debugShowCloneDialog: () => setShowCloneDialog(true),
      debugShowCloneProgressDialog: () => {
        // No real clone can run from the debug menu, so drive the category-1 progress step with a
        // canned clone that actually advances: value and git line moving 0→100 frame by frame over
        // a few seconds, then a synthetic finish. A static bar would never exercise the live
        // updates the dialog exists for, and an undismissable dialog that never ends would lock
        // the UI forever.
        setShowCloneDialog(true);
        window.clearInterval(clonePreviewTimer.current);
        const frames: ReadonlyArray<{ readonly value: number; readonly description: string }> = [
          { value: 0.0, description: "Cloning into '/tmp/mock-repo'..." },
          { value: 0.1, description: "remote: Enumerating objects: 204, done." },
          { value: 0.25, description: "Receiving objects: 25% (51/204)" },
          {
            value: 0.4,
            description: "Receiving objects: 40% (82/204), 12.4 MiB | 1.1 MiB/s",
          },
          {
            value: 0.55,
            description: "Receiving objects: 55% (113/204), 18.9 MiB | 1.3 MiB/s",
          },
          {
            value: 0.7,
            description: "Receiving objects: 70% (143/204), 24.6 MiB | 1.2 MiB/s",
          },
          {
            value: 0.85,
            description: "Receiving objects: 85% (174/204), 30.1 MiB | 1.1 MiB/s",
          },
          { value: 0.95, description: "Resolving deltas: 95% (52/55)" },
          { value: 1.0, description: "Resolving deltas: 100% (55/55), done." },
        ];
        let index = 0;
        const step = () => {
          if (index >= frames.length) {
            window.clearInterval(clonePreviewTimer.current);
            setShowCloneDialog(false);
            cloneStore.reset();
            return;
          }
          const frame = frames[index++];
          injectCloneProgress(frame.value, frame.description);
        };
        step();
        // ~9 frames across the same window the old static preview used; each tick advances the
        // bar and the git line, and the frame after 100% ends the preview.
        clonePreviewTimer.current = window.setInterval(step, 667);
      },
      debugShowDiscardAllDialog: () => {
        injectDebugState();
        requestDiscardAll(false);
      },
      debugShowRenameBranchDialog: () => {
        injectDebugState();
        renameCurrentBranch();
      },
      debugShowDeleteBranchDialog: () => {
        injectDebugState();
        deleteCurrentBranch();
      },
      debugShowMergeDialog: () => {
        injectDebugState();
        requestMerge();
      },
      debugShowRebaseDialog: () => {
        injectDebugState();
        requestRebase();
      },
      debugShowManageRemotesDialog: () => {
        injectDebugState();
        requestManageRemotes();
      },
      debugShowHookFailureDialog: () => {
        injectDebugState({ hookFailure: true });
      },
    });
    const replaceMenu = () => {
      if (controller === undefined) {
        updatePending = true;
        return;
      }
      void controller
        .replaceMenu(
          buildRepositoryMenu(
            latestState,
            platform,
            latestRemoteState,
            latestPreferencesState,
            latestOperationActive,
          ),
        )
        .catch((error) => {
          log.error("Failed to update the application menu", error);
        });
    };
    const unsubscribe = appStore.onDidUpdate((state) => {
      latestState = state;
      replaceMenu();
    });
    const unsubscribeRemote = remoteStore.onDidUpdate((state) => {
      latestRemoteState = state;
      replaceMenu();
    });
    const unsubscribeOperation = operationStore.onDidUpdate((state) => {
      latestOperationActive =
        state.operation !== null && !isTerminalOperation(state.operation.state);
      replaceMenu();
    });
    const unsubscribePreferences = preferencesStore.onDidUpdate((state) => {
      latestPreferencesState = state;
      replaceMenu();
    });

    void installApplicationMenu({
      initialMenu: buildRepositoryMenu(
        latestState,
        platform,
        latestRemoteState,
        latestPreferencesState,
        latestOperationActive,
      ),
      executeMenuEvent,
    })
      .then(async (installedController) => {
        if (disposed) {
          installedController.dispose();
        } else {
          controller = installedController;
          if (updatePending) {
            updatePending = false;
            await controller.replaceMenu(
              buildRepositoryMenu(
                latestState,
                platform,
                latestRemoteState,
                latestPreferencesState,
                latestOperationActive,
              ),
            );
          }
        }
      })
      .catch((error) => {
        log.error("Failed to install the application menu", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeRemote();
      unsubscribeOperation();
      unsubscribePreferences();
      controller?.dispose();
    };
  }, [
    appStore,
    branchStore,
    cloneStore,
    historyStore,
    operationStore,
    preferencesStore,
    remoteStore,
  ]);
  // oxlint-enable react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubscribe = workingTreeStore.onDidUpdate(setWorkingTreeState);
    const repository = appState.selectedRepository;
    setDiscardFileID(null);
    setDiscarding(false);
    setPermanentlyDiscard(false);
    setDiscardSelection(false);
    setSelectedLinesDiscard(null);
    setDiscardAll(null);
    setBranchToRename(null);
    setBranchToDelete(null);
    setDeleteRefusal(null);
    setDeleteUnmerged(false);
    setDeletePruneTrackingRef(false);
    setMergePickerOpen(false);
    setMergeMessage(null);
    setMergeRunning(false);
    setRebasePickerOpen(false);
    setRebaseTarget("");
    setRebasePreview(null);
    setRebaseRunning(false);
    setRebaseMessage(null);
    setRebasePreviewError(null);
    setShowManageRemotes(false);
    setShowAddRemote(false);
    setRemoteFilter("");
    setManageRemoteError(null);
    setManageRunning(false);
    repositoryViewTransitionID.current++;
    pendingRepositoryView.current = null;
    historyStore.clear();
    if (repository === null) {
      branchStore.clear();
      conflictStore.clear();
      remoteStore.clear();
      workingTreeStore.clear();
    } else {
      const wantsHistory = activeRepositoryView.current === "history";
      if (wantsHistory) {
        // Keep a valid frame visible while preparing History for the newly selected repository.
        activeRepositoryView.current = "changes";
        setActiveRepositoryView("changes");
      }
      const transitionID = ++repositoryViewTransitionID.current;
      if (wantsHistory) {
        pendingRepositoryView.current = "history";
      }
      void repositoryIsAvailable(repository).then((available) => {
        if (!available) {
          pendingRepositoryView.current = null;
          return;
        }
        void branchStore.load(repository.path);
        void conflictStore.load(repository.path);
        void remoteStore.load(repository.path);
        void workingTreeStore.load(repository.path);
        if (!wantsHistory) {
          return;
        }
        void historyStore.load(repository.path).then(() => {
          if (repositoryViewTransitionID.current === transitionID) {
            pendingRepositoryView.current = null;
            activeRepositoryView.current = "history";
            setActiveRepositoryView("history");
          }
        });
      });
    }
    return unsubscribe;
  }, [
    appState.selectedRepository,
    branchStore,
    conflictStore,
    historyStore,
    remoteStore,
    repositoryIsAvailable,
    workingTreeStore,
  ]);

  useEffect(
    () => workingTreeStore.onCommitTerminalOutput(setCommitTerminalOutput),
    [workingTreeStore],
  );

  useEffect(() => {
    void getAppArchitecture()
      .then(setAppArchitecture)
      .catch((error) => log.error("Failed to resolve the application architecture", error));
  }, []);

  useEffect(() => historyStore.onDidUpdate(setHistoryState), [historyStore]);
  useEffect(() => messageStore.onDidUpdate(setMessageState), [messageStore]);

  useEffect(() => cloneStore.onDidUpdate(setCloneState), [cloneStore]);

  useEffect(() => remoteStore.onDidUpdate(setRemoteState), [remoteStore]);

  useEffect(() => {
    const unsubscribe = preferencesStore.onDidUpdate(setPreferencesState);
    void preferencesStore.load().then(() => {
      // Apply persisted zoom after preferences load. The startup executor
      // initializes to 1.0; preferences may hold a different value.
      const zoom = preferencesStore.state.zoomFactor;
      if (zoom !== 1.0) {
        void setWindowZoomFactor(zoom);
      }
    });
    let disposed = false;
    let unlistenTheme: (() => void) | undefined;
    void onNativeThemeUpdated(() => {
      if (preferencesStore.state.theme === "system") {
        void preferencesStore.refreshTheme();
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenTheme = unlisten;
        }
      })
      .catch((error) => {
        log.error("Failed to observe native theme changes", error);
      });
    return () => {
      disposed = true;
      unsubscribe();
      unlistenTheme?.();
    };
  }, [preferencesStore]);

  useEffect(() => branchStore.onDidUpdate(setBranchState), [branchStore]);

  useEffect(() => conflictStore.onDidUpdate(setConflictState), [conflictStore]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = appStore.onDidUpdate((state) => {
      if (!disposed) {
        setAppState(state);
      }
    });
    const load = appStore.load().catch((error) => {
      log.error("Failed to load the repository list", error);
      if (!disposed) {
        reportError(error);
      }
    });

    void sendReady(performance.now() - rendererStartTime)
      .then(async (action) => {
        if (action?.kind === "open-repository") {
          await load;
          await appStore.addRepository(action.path, action.persistSelection);
        }
      })
      .catch((error) => {
        log.error("Failed to complete the renderer-ready handshake", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [appStore]);

  async function addExistingRepository() {
    const selected = await showOpenDialog({
      title: "Choose a repository directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected === null) {
      return;
    }

    try {
      await appStore.addRepository(selected);
    } catch (error) {
      reportError(error);
    }
  }

  async function createRepository(): Promise<void> {
    const selected = await showSaveDialog({
      title: "Create a repository",
      properties: ["createDirectory"],
    });
    if (selected === null) {
      return;
    }

    try {
      await initRepository(selected, "main");
      await appStore.addRepository(selected);
    } catch (error) {
      reportError(error);
    }
  }

  function openCloneDialog(): void {
    cloneStore.reset();
    setShowCloneDialog(true);
  }

  function dismissCloneDialog(): void {
    if (cloneState.operation !== null) {
      return;
    }
    cloneStore.reset();
    setShowCloneDialog(false);
  }

  async function chooseCloneDestination(): Promise<void> {
    const platform = currentMenuPlatform();
    if (platform === "macos") {
      const selected = await showSaveDialog({
        title: "Choose a clone destination",
        defaultPath: clonePath || undefined,
        properties: ["createDirectory"],
      });
      if (selected !== null) {
        setClonePath(selected);
      }
      return;
    }

    const parent = await showOpenDialog({
      title: "Choose a parent directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (parent === null) {
      return;
    }
    const name = getCloneDirectoryName(cloneURL);
    setClonePath(name === null ? parent : await join(parent, name));
  }

  async function submitClone(): Promise<void> {
    const clonedPath = await cloneStore.clone(cloneURL, clonePath);
    if (clonedPath === null) {
      return;
    }
    try {
      await appStore.addRepository(clonedPath);
      setCloneURL("");
      setClonePath("");
      setShowCloneDialog(false);
    } catch (error) {
      reportError(error);
    }
  }

  async function selectRepository(repository: Repository) {
    try {
      await appStore.selectRepository(repository);
    } catch (error) {
      reportError(error);
    }
  }

  async function openRepositoryContextMenu(repository: Repository, x: number, y: number) {
    if (appState.selectedRepository?.id !== repository.id) {
      await selectRepository(repository);
    }
    // The row's own `.blur()`-after-click only helps a keyboard user: WebKit does not focus a
    // <button> on an ordinary mouse click, so hovering "more actions" then clicking it can leave
    // its tooltip open, unreachable by onBlur/onMouseLeave once the native menu covers it. See
    // dismissAllTooltips's doc comment.
    dismissAllTooltips();
    await showContextMenu(
      [
        {
          text: "Open in New Window",
          action: () => {
            void runRepositoryAction(() => openRepositoryInNewWindow(repository.path));
          },
        },
        {
          text: "Show in File Manager",
          action: () => {
            void runRepositoryAction(() => showFolderContents(repository.path));
          },
        },
        { type: "separator" },
        {
          text: "Manage remotes…",
          action: () => {
            requestManageRemotes();
          },
        },
        {
          text: "Remove",
          action: () => {
            requestRemoveRepository(repository);
          },
        },
      ],
      { x, y },
    );
  }

  async function runRepositoryAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      reportError(error);
    }
  }

  function cancelRemoveRepository(): void {
    if (removingRepository) {
      return;
    }
    setRepositoryToRemove(null);
    setRemoveRepositoryError(null);
  }

  function requestRemoveRepository(repository: Repository): void {
    if (preferencesStore.state.confirmRepositoryRemoval) {
      setRepositoryToRemove(repository);
    } else {
      void runRepositoryAction(() => appStore.removeRepository(repository));
    }
  }

  /**
   * Removes the repository the confirmation dialog is asking about.
   *
   * The dialog stays open until the removal settles, and closes only on success. It used to close
   * first and then run, which made every failure ownerless — Convention 17 in
   * `COMPONENT_MIGRATION_PROCESS.md`. Cancel stays enabled whenever the removal is not in flight,
   * so a repository that cannot be removed does not trap the user in a dialog that keeps failing.
   */
  async function confirmRemoveRepository(): Promise<void> {
    if (repositoryToRemove === null || removingRepository) {
      return;
    }
    const repository = repositoryToRemove;
    setRemoveRepositoryError(null);
    setRemovingRepository(true);
    try {
      await appStore.removeRepository(repository);
      setRepositoryToRemove(null);
    } catch (error) {
      setRemoveRepositoryError(describeError(error));
    } finally {
      setRemovingRepository(false);
    }
  }

  async function openInShell(path: string): Promise<void> {
    const shell = preferencesStore.selectedShell;
    if (shell === null) {
      throw new Error("No terminal application is available");
    }
    await launchShell(shell, path);
  }

  async function openInExternalEditor(path: string): Promise<void> {
    const editor = preferencesStore.selectedEditor;
    if (editor === null) {
      throw new Error("No external editor is available");
    }
    await launchExternalEditor(path, editor);
  }

  /**
   * Runs a branch operation and refreshes what it can invalidate.
   *
   * Returns whether the operation itself succeeded, because the caller needs to know: the branch
   * form used to infer it from `branchStore.state.operationError`, which stopped being a reliable
   * signal once sidebar failures started going to the message store instead.
   */
  async function refreshAfterBranchChange(operation: () => Promise<boolean>): Promise<boolean> {
    const repository = appState.selectedRepository;
    if (repository === null) {
      return false;
    }
    if (!(await operation())) {
      return false;
    }
    if (!(await repositoryIsAvailable(repository))) {
      return true;
    }
    await Promise.all([
      remoteStore.load(repository.path),
      workingTreeStore.load(repository.path),
      conflictStore.load(repository.path),
    ]);
    if (repositoryView === "history") {
      await historyStore.load(repository.path);
    }
    return true;
  }

  async function refreshAfterFetch(): Promise<void> {
    const repository = appStore.state.selectedRepository;
    if (
      repository === null ||
      !(await remoteStore.fetch()) ||
      !(await repositoryIsAvailable(repository))
    ) {
      return;
    }
    await branchStore.load(repository.path);
    if (historyStore.state.repositoryPath === repository.path) {
      await historyStore.load(repository.path);
    }
  }

  async function refreshAfterPush(): Promise<void> {
    const repository = appStore.state.selectedRepository;
    if (
      repository === null ||
      !(await remoteStore.push()) ||
      !(await repositoryIsAvailable(repository))
    ) {
      return;
    }
    await Promise.all([
      branchStore.load(repository.path),
      conflictStore.load(repository.path),
      workingTreeStore.load(repository.path),
    ]);
    if (historyStore.state.repositoryPath === repository.path) {
      await historyStore.load(repository.path);
    }
  }

  async function refreshAfterPull(): Promise<void> {
    const repository = appStore.state.selectedRepository;
    if (repository === null) {
      return;
    }
    await remoteStore.pull();
    if (!(await repositoryIsAvailable(repository))) {
      return;
    }
    await Promise.all([
      branchStore.load(repository.path),
      conflictStore.load(repository.path),
      workingTreeStore.load(repository.path),
    ]);
    if (historyStore.state.repositoryPath === repository.path) {
      await historyStore.load(repository.path);
    }
  }

  async function stageResolvedConflict(path: string): Promise<void> {
    const repository = appState.selectedRepository;
    if (repository !== null && (await conflictStore.stageResolvedFile(path))) {
      await workingTreeStore.load(repository.path);
    }
  }

  const discardFile =
    workingTreeState.workingDirectory?.files.find((file) => file.id === discardFileID) ?? null;
  function requestDiscard(fileID: string, selection: boolean): void {
    if (selection || preferencesStore.state.confirmDiscardChanges) {
      const selectedLines = selection ? workingTreeStore.getSelectedLinesDiscard() : null;
      if (selection && selectedLines === null) {
        return;
      }
      setDiscardOptOut(false);
      setDiscardFileID(fileID);
      setDiscardSelection(selection);
      setSelectedLinesDiscard(selectedLines);
      setPermanentlyDiscard(false);
      return;
    }
    void discardWholeFile(fileID, false);
  }

  async function discardWholeFile(fileID: string, permanent: boolean): Promise<void> {
    setDiscarding(true);
    let result = await workingTreeStore.discardFile(fileID, permanent);
    if (result === "trash-failed" && !preferencesStore.state.confirmDiscardChangesPermanently) {
      result = await workingTreeStore.discardFile(fileID, true);
    }
    setDiscarding(false);
    if (result === "discarded") {
      setDiscardFileID(null);
      setPermanentlyDiscard(false);
      setSelectedLinesDiscard(null);
    } else if (result === "trash-failed") {
      setDiscardFileID(fileID);
      setPermanentlyDiscard(true);
      setDiscardSelection(false);
      setSelectedLinesDiscard(null);
    }
  }

  /**
   * Write the "do not show this message again" choice, if the user made one.
   *
   * Called from the confirm paths only. The permanent variant has its own preference because it is
   * the more dangerous of the two and worth switching off separately.
   */
  function applyDiscardOptOut(permanent: boolean): void {
    if (!discardOptOut) {
      return;
    }
    if (permanent) {
      preferencesStore.setConfirmDiscardChangesPermanently(false);
    } else {
      preferencesStore.setConfirmDiscardChanges(false);
    }
  }

  async function confirmDiscard() {
    if (discardFile === null) {
      return;
    }
    applyDiscardOptOut(permanentlyDiscard);
    if (discardSelection) {
      setDiscarding(true);
      const discarded = await workingTreeStore.discardSelectedLines(selectedLinesDiscard);
      setDiscarding(false);
      if (discarded) {
        setDiscardFileID(null);
        setDiscardSelection(false);
        setSelectedLinesDiscard(null);
      }
      return;
    }
    await discardWholeFile(discardFile.id, permanentlyDiscard);
  }

  function cancelDiscard(): void {
    if (discarding) {
      return;
    }
    setDiscardFileID(null);
    setPermanentlyDiscard(false);
    setDiscardSelection(false);
    setSelectedLinesDiscard(null);
    setDiscardAll(null);
  }

  function requestDiscardAll(permanent: boolean): void {
    // The native menu controller is installed once, so a render-time read here would be the
    // working tree as it looked at first mount — empty, before any repository was selected — and
    // the menu item would silently do nothing.
    const files = workingTreeStore.state.workingDirectory?.files ?? [];
    if (files.length === 0) {
      return;
    }
    const shouldConfirm = permanent
      ? preferencesStore.state.confirmDiscardChangesPermanently
      : preferencesStore.state.confirmDiscardChanges;
    if (shouldConfirm) {
      setDiscardOptOut(false);
      setDiscardAll({ permanent, paths: files.map((file) => file.path) });
      return;
    }
    void discardAllWorkingChanges(permanent);
  }

  async function discardAllWorkingChanges(permanent: boolean): Promise<void> {
    setDiscarding(true);
    let result = await workingTreeStore.discardAllChanges(permanent);
    if (result === "trash-failed" && !preferencesStore.state.confirmDiscardChangesPermanently) {
      result = await workingTreeStore.discardAllChanges(true);
    }
    setDiscarding(false);
    if (result === "discarded") {
      setDiscardAll(null);
    } else if (result === "trash-failed") {
      // Re-read the working tree rather than reusing the first list: the failed trash attempt may
      // already have removed some files, so the earlier snapshot is stale.
      const remaining = workingTreeStore.state.workingDirectory?.files ?? [];
      setDiscardAll({ permanent: true, paths: remaining.map((file) => file.path) });
    }
  }

  async function confirmDiscardAll(): Promise<void> {
    if (discardAll === null) {
      return;
    }
    applyDiscardOptOut(discardAll.permanent);
    await discardAllWorkingChanges(discardAll.permanent);
  }

  function cancelDiscardAll(): void {
    if (discarding) {
      return;
    }
    setDiscardAll(null);
  }

  function requestRename(branch: Branch): void {
    setBranchToRename(branch);
    setRenameName(branch.name);
  }

  function renameCurrentBranch(): void {
    const current = branchStore.state.currentBranch;
    if (current === null) {
      return;
    }
    const branch = branchStore.state.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === current,
    );
    if (branch !== undefined) {
      requestRename(branch);
    }
  }

  async function confirmRename(): Promise<void> {
    if (branchToRename === null) {
      return;
    }
    const branch = branchToRename;
    await refreshAfterBranchChange(() => branchStore.renameBranch(branch.name, renameName));
    if (branchStore.state.dialogError === null) {
      setBranchToRename(null);
      setRenameName("");
    }
  }

  function cancelRename(): void {
    if (branchStore.state.operation !== null) {
      return;
    }
    setBranchToRename(null);
    setRenameName("");
  }

  function deleteCurrentBranch(): void {
    const current = branchStore.state.currentBranch;
    if (current === null) {
      return;
    }
    const branch = branchStore.state.branches.find(
      (branch) => branch.type === BranchType.Local && branch.name === current,
    );
    if (branch !== undefined) {
      void requestDelete(branch);
    }
  }

  async function requestDelete(branch: Branch): Promise<void> {
    if (branch.name === branchState.currentBranch || branch.name === branchState.defaultBranch) {
      setDeleteRefusal(
        branch.name === branchState.currentBranch
          ? `You cannot delete the current branch '${branch.name}'.`
          : `You cannot delete the default branch '${branch.name}'.`,
      );
      return;
    }
    const repository = appState.selectedRepository;
    setDeleteRefusal(null);
    setDeletePruneTrackingRef(false);
    setDeleteUnmerged(false);
    if (repository !== null && branchState.currentBranch !== null) {
      try {
        const merged = await getMergedBranches(repository.path, branchState.currentBranch);
        setDeleteUnmerged(!merged.has(`refs/heads/${branch.name}`));
      } catch {
        setDeleteUnmerged(false);
      }
    }
    setBranchToDelete(branch);
  }

  async function confirmDelete(): Promise<void> {
    if (branchToDelete === null) {
      return;
    }
    const branch = branchToDelete;
    await refreshAfterBranchChange(() =>
      branchStore.deleteBranch(branch.name, {
        pruneTrackingRef: deletePruneTrackingRef,
      }),
    );
    if (branchStore.state.dialogError === null) {
      setBranchToDelete(null);
      setDeleteUnmerged(false);
      setDeletePruneTrackingRef(false);
    }
  }

  function cancelDelete(): void {
    if (branchStore.state.operation !== null) {
      return;
    }
    setBranchToDelete(null);
    setDeleteRefusal(null);
    setDeleteUnmerged(false);
    setDeletePruneTrackingRef(false);
  }

  async function openBranchContextMenu(branch: Branch, x: number, y: number) {
    const current = branch.name === branchState.currentBranch;
    const defaultBranch = branch.name === branchState.defaultBranch;
    const canDelete = !current && !defaultBranch;
    dismissAllTooltips();
    await showContextMenu(
      [
        {
          text: "Rename…",
          action: () => requestRename(branch),
        },
        {
          text: "Delete…",
          enabled: canDelete,
          action: () => {
            void requestDelete(branch);
          },
        },
      ],
      { x, y },
    );
  }

  async function openCommitContextMenu(
    commit: import("../../../models/commit").Commit,
    x: number,
    y: number,
  ) {
    const repository = appState.selectedRepository;
    if (repository === null) {
      return;
    }
    dismissAllTooltips();
    await showContextMenu(
      [
        {
          text: "Cherry-pick commit",
          enabled: !operationStateForRepositoryActive(),
          action: () => {
            void cherryPick(repository.path, [{ sha: commit.sha, summary: commit.summary }]);
          },
        },
        {
          text: "Revert commit",
          enabled: !operationStateForRepositoryActive(),
          action: () => {
            void revertCommit(repository.path, commit.sha, commit.parentSHAs.length);
          },
        },
      ],
      { x, y },
    );
  }

  function operationStateForRepositoryActive(): boolean {
    const operation = operationStore.state.operation;
    return operation !== null && !isTerminalOperation(operation.state);
  }

  async function continueHistoryRecovery(): Promise<void> {
    const repository = appState.selectedRepository;
    const operation = operationStore.state.operation;
    const recoveryOperation = operation?.operation ?? conflictState.recoveryOperation;
    if (repository === null || recoveryOperation !== "cherryPick") {
      return;
    }
    const files = conflictStore.state.files.map((file) => [file.path, file.status] as const);
    await continueCherryPick(repository.path, files);
  }

  async function abortHistoryRecovery(): Promise<void> {
    const repository = appState.selectedRepository;
    const operation = operationStore.state.operation;
    if (repository === null) {
      return;
    }
    const recoveryOperation = operation?.operation ?? conflictState.recoveryOperation;
    if (recoveryOperation === "cherryPick") {
      await abortCherryPick(repository.path);
    } else if (recoveryOperation === "revert") {
      await abortRevert(repository.path);
    }
  }

  async function continueRebaseRecovery(): Promise<void> {
    const repository = appState.selectedRepository;
    if (repository === null || !conflictState.rebaseInProgress || conflictState.files.length > 0) {
      return;
    }
    await continueRebase(repository.path, []);
    await conflictStore.load(repository.path);
  }

  async function abortRebaseRecovery(): Promise<void> {
    const repository = appState.selectedRepository;
    if (repository === null || !conflictState.rebaseInProgress) {
      return;
    }
    await abortRebase(repository.path);
    await conflictStore.load(repository.path);
  }

  async function abortMergeRecovery(): Promise<void> {
    const repository = appState.selectedRepository;
    if (repository === null || !conflictState.mergeInProgress) {
      return;
    }
    await abortMerge(repository.path);
    await conflictStore.load(repository.path);
  }

  async function squashSelectedCommits(commits: ReadonlyArray<Commit>): Promise<void> {
    const repository = appState.selectedRepository;
    if (repository === null || commits.length < 2 || operationStateForRepositoryActive()) {
      return;
    }
    const ordered = orderSelectedCommits(historyState.commits, commits);
    if (!isContiguousSelection(historyState.commits, commits)) {
      window.alert("Select a contiguous history range to squash.");
      return;
    }
    const squashOnto = ordered.at(-1);
    if (squashOnto === undefined) {
      return;
    }
    const lastRetained =
      historyState.commits[
        historyState.commits.findIndex((commit) => commit.sha === squashOnto.sha) + 1
      ]?.sha ?? null;
    if (!window.confirm(`Squash ${ordered.length} commits into ${squashOnto.summary}?`)) {
      return;
    }
    await squash(
      repository.path,
      ordered.slice(0, -1).map((commit) => commit.sha),
      squashOnto.sha,
      lastRetained,
    );
  }

  async function reorderSelectedCommits(
    commits: ReadonlyArray<Commit>,
    before: Commit | null,
  ): Promise<void> {
    const repository = appState.selectedRepository;
    if (repository === null || commits.length === 0 || operationStateForRepositoryActive()) {
      return;
    }
    const ordered = orderSelectedCommits(historyState.commits, commits);
    const lastSelected = ordered.at(-1);
    if (lastSelected === undefined) {
      return;
    }
    if (before !== null && commits.some((commit) => commit.sha === before.sha)) {
      return;
    }
    if (
      !window.confirm(
        `Move ${ordered.length} selected commits ${before === null ? "to the end of history" : `before ${before.summary}`}?`,
      )
    ) {
      return;
    }
    await reorder(
      repository.path,
      ordered.map((commit) => commit.sha),
      before?.sha ?? null,
      lastSelected.parentSHAs[0] ?? null,
    );
  }

  // Reactive merge preview: when mergeTarget changes, check mergeability and commit count
  useEffect(() => {
    if (!mergePickerOpen || mergeTarget === "") {
      setMergeStatus(null);
      setMergeCommitCount(0);
      setMergePreviewError(null);
      return;
    }

    // Stub branches exist only in the renderer, so git has nothing to compute from. Canned answers
    // keep every outcome reachable from Help -> Show Dialog, which is what that menu is for.
    if (isDebugStateInjected()) {
      const preview = debugMergePreview(mergeTarget);
      if (preview !== null) {
        setMergePreviewError(null);
        setMergeStatus(preview.status);
        setMergeCommitCount(preview.commitCount);
        return;
      }
    }

    const repository = appState.selectedRepository;
    if (repository === null) {
      return;
    }

    const currentBranch = branchState.currentBranch;
    if (currentBranch === null) {
      return;
    }

    let disposed = false;
    setMergePreviewError(null);
    setMergeStatus({ kind: ComputedAction.Loading });

    void determineMergeability(repository.path, currentBranch, mergeTarget)
      .then(async (status) => {
        if (disposed) return;
        if (status.kind === ComputedAction.Invalid) {
          setMergeStatus(status);
          return;
        }
        const range = revSymmetricDifference("", mergeTarget);
        const aheadBehind = await getAheadBehind(repository.path, range);
        if (disposed) return;
        setMergeCommitCount(aheadBehind ? aheadBehind.behind : 0);
        setMergeStatus(status);
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        // Previously this reported ComputedAction.Clean, which with a zero commit count rendered as
        // "<current> is already up to date with <branch>" — a confident, wrong statement about the
        // user's repository whenever the lookup merely failed. Say what actually happened instead,
        // and refuse the merge rather than starting one on an unverified assumption.
        log.error("Failed to determine mergeability", error instanceof Error ? error : undefined);
        setMergeStatus(null);
        setMergeCommitCount(0);
        setMergePreviewError("Could not determine whether these branches can be combined.");
      });

    return () => {
      disposed = true;
    };
  }, [mergePickerOpen, mergeTarget, appState.selectedRepository, branchState.currentBranch]);

  function requestMerge(): void {
    setMergeStrategy(preferencesStore.state.defaultMergeStrategy);
    setMergeTarget("");
    setMergeMessage(null);
    setMergeStatus(null);
    setMergeCommitCount(0);
    setMergePreviewError(null);
    setMergedBranches(new Map());
    setMergePickerOpen(true);

    // Branches already contained in the current branch cannot produce a merge, so they are dropped
    // from the candidates rather than offered and then refused. One call, and a failure just means
    // nothing is filtered — the per-branch preview still catches it on selection.
    if (isDebugStateInjected()) {
      setMergedBranches(debugMergedBranches());
      return;
    }

    const repository = appStore.state.selectedRepository;
    const current = branchStore.state.currentBranch;
    if (repository !== null && current !== null) {
      void getMergedBranches(repository.path, current)
        .then(setMergedBranches)
        .catch((error: unknown) => {
          log.error("Failed to list merged branches", error instanceof Error ? error : undefined);
        });
    }
  }

  function mergeMessageFor(result: MergeInitiationResult, target: string): string {
    switch (result) {
      case "up-to-date":
        return `${target} is already up to date with the current branch.`;
      case "invalid":
        return "These branches do not share a common ancestor and cannot be merged.";
      case "dirty":
        return "Clean the working tree before merging.";
      case "failed":
        return "The merge failed.";
      case "merged":
      case "conflict":
        return "";
    }
  }

  async function confirmMerge(): Promise<void> {
    if (mergeTarget === "" || mergeRunning) {
      return;
    }
    setMergeRunning(true);
    setMergeMessage(null);
    const target = mergeTarget;
    const workingTreeDirty = (workingTreeState.workingDirectory?.files.length ?? 0) > 0;
    try {
      const result = await branchStore.initiateMerge(target, {
        workingTreeDirty,
        squash: mergeStrategy === "squash",
      });
      if (result === "merged" || result === "conflict") {
        await refreshAfterBranchChange(() => Promise.resolve(true));
        setMergePickerOpen(false);
        return;
      }
      setMergeMessage(mergeMessageFor(result, target));
    } catch {
      setMergeMessage("The merge failed.");
    } finally {
      setMergeRunning(false);
    }
  }

  function cancelMerge(): void {
    if (mergeRunning) {
      return;
    }
    setMergePickerOpen(false);
    setMergeMessage(null);
    setMergeTarget("");
    setMergeStatus(null);
    setMergeCommitCount(0);
  }

  // Reactive rebase preview: when rebaseTarget changes, work out how far the current branch is
  // from the base, mirroring desktop-plus's updateRebasePreview. `ahead` is the current branch's
  // own commits (the ones a rebase replays); `behind` is the base's commits the current branch is
  // missing, and a rebase can only start when it is positive.
  useEffect(() => {
    if (!rebasePickerOpen || rebaseTarget === "") {
      setRebasePreview(null);
      setRebasePreviewError(null);
      return;
    }

    // Stub branches have no ancestry, so git has nothing to compute from. Canned answers keep
    // every outcome reachable from Help -> Show Dialog, which is what that menu is for.
    if (isDebugStateInjected()) {
      const preview = debugRebasePreview(rebaseTarget);
      if (preview !== null) {
        setRebasePreviewError(null);
        setRebasePreview(preview);
        return;
      }
    }

    const repository = appState.selectedRepository;
    const current = branchState.currentBranch;
    if (repository === null || current === null) {
      return;
    }

    let disposed = false;
    setRebasePreviewError(null);
    setRebasePreview({ kind: ComputedAction.Loading });
    void getAheadBehind(repository.path, revSymmetricDifference(current, rebaseTarget))
      .then((result) => {
        if (disposed) {
          return;
        }
        // A ref in the range vanished; desktop-plus treats the same case as Invalid.
        if (result === null) {
          setRebasePreview({ kind: ComputedAction.Invalid });
          return;
        }
        setRebasePreview({
          kind: ComputedAction.Clean,
          commitsAhead: result.ahead,
          commitsBehind: result.behind,
        });
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        log.error("Failed to preview rebase", error instanceof Error ? error : undefined);
        setRebasePreview(null);
        setRebasePreviewError("Could not determine whether these branches can be combined.");
      });

    return () => {
      disposed = true;
    };
  }, [rebasePickerOpen, rebaseTarget, appState.selectedRepository, branchState.currentBranch]);

  function requestRebase(): void {
    setRebaseTarget("");
    setRebaseMessage(null);
    setRebasePreview(null);
    setRebasePreviewError(null);
    setRebasePickerOpen(true);
  }

  function rebaseMessageFor(result: RebaseInitiationResult): string {
    switch (result) {
      case "completed":
        return "";
      case "conflict":
        // A rebase conflict writes .git/rebase-merge/, which rdc's conflict recovery (tracked on
        // mergeInProgress) does not see, so closing the dialog into that void would strand the user.
        // Stay openly in the dialog and state the boundary rather than pretend recovery exists.
        return "The rebase stopped on conflicts. Resolve them, then continue or abort the rebase from a terminal.";
      case "up-to-date":
        return "The current branch is already up to date with the selected base.";
      case "dirty":
        return "Clean the working tree before rebasing.";
      case "failed":
        return "The rebase failed.";
    }
  }

  async function confirmRebase(): Promise<void> {
    if (rebaseTarget === "" || rebaseRunning) {
      return;
    }
    setRebaseRunning(true);
    setRebaseMessage(null);
    const target = rebaseTarget;
    const workingTreeDirty = (workingTreeState.workingDirectory?.files.length ?? 0) > 0;
    try {
      const result = await branchStore.rebaseBranch(target, { workingTreeDirty });
      if (result === "completed") {
        await refreshAfterBranchChange(() => Promise.resolve(true));
        setRebasePickerOpen(false);
        return;
      }
      setRebaseMessage(rebaseMessageFor(result));
    } catch {
      setRebaseMessage("The rebase failed.");
    } finally {
      setRebaseRunning(false);
    }
  }

  function cancelRebase(): void {
    if (rebaseRunning) {
      return;
    }
    setRebasePickerOpen(false);
    setRebaseMessage(null);
    setRebaseTarget("");
    setRebasePreview(null);
  }

  function requestManageRemotes(): void {
    setRemoteFilter("");
    setManageRemoteError(null);
    setShowManageRemotes(true);
  }

  function closeManageRemotes(): void {
    if (manageRunning) {
      return;
    }
    setShowManageRemotes(false);
    setShowAddRemote(false);
    setRemoteFilter("");
    setManageRemoteError(null);
  }

  function openAddRemote(): void {
    setAddRemoteName("");
    setAddRemoteURL("");
    setManageRemoteError(null);
    setShowAddRemote(true);
  }

  function closeAddRemote(): void {
    if (manageRunning) {
      return;
    }
    setShowAddRemote(false);
    setManageRemoteError(null);
  }

  async function confirmAddRemote(): Promise<void> {
    if (manageRunning) {
      return;
    }
    const name = addRemoteName.trim();
    const url = addRemoteURL.trim();
    setManageRemoteError(null);
    if (name.length === 0 || /\s/.test(name)) {
      setManageRemoteError("Remote names cannot be empty or contain spaces.");
      return;
    }
    if (url.length === 0) {
      setManageRemoteError("Enter a remote URL.");
      return;
    }
    if (remoteState.remotes.some((remote) => remote.name === name)) {
      setManageRemoteError(`A remote named "${name}" already exists.`);
      return;
    }
    const repository = appState.selectedRepository;
    if (repository === null) {
      return;
    }
    setManageRunning(true);
    const added = await remoteStore.addRemote(name, url);
    setManageRunning(false);
    if (added) {
      setShowAddRemote(false);
      setAddRemoteName("");
      setAddRemoteURL("");
      await branchStore.load(repository.path);
    } else if (remoteStore.state.managementError !== null) {
      setManageRemoteError(remoteStore.state.managementError);
    }
  }

  async function confirmRemoveRemote(name: string): Promise<void> {
    if (manageRunning) {
      return;
    }
    const repository = appState.selectedRepository;
    if (repository === null) {
      return;
    }
    setManageRunning(true);
    setManageRemoteError(null);
    const removed = await remoteStore.removeRemote(name);
    setManageRunning(false);
    if (removed) {
      await branchStore.load(repository.path);
    } else if (remoteStore.state.managementError !== null) {
      setManageRemoteError(remoteStore.state.managementError);
    }
  }

  function toggleSidebarSection(section: SidebarSectionID): void {
    setExpandedSidebarSections((current) => {
      return current.has(section)
        ? new Set<SidebarSectionID>()
        : new Set<SidebarSectionID>([section]);
    });
  }

  function activateSidebarSection(section: SidebarSectionID): void {
    setSidebarCollapsed(false);
    setExpandedSidebarSections(new Set<SidebarSectionID>([section]));
  }

  function showBranches(): void {
    activateSidebarSection("branches");
    requestAnimationFrame(() => document.getElementById("sidebar-branches-heading")?.focus());
  }

  function goToCommitMessage(): void {
    if (activeRepositoryView.current !== "changes") {
      selectRepositoryView("changes");
    }
    requestAnimationFrame(() => document.getElementById("commit-message")?.focus());
  }

  function increaseActiveResizableWidth(): void {
    setSidebarCollapsed(false);
    setSidebarWidth((width) => Math.min(width + 16, 640));
  }

  function decreaseActiveResizableWidth(): void {
    setSidebarWidth((width) => Math.max(width - 16, 125));
  }

  function createBranch(): void {
    setShowBranchCreation(true);
    activateSidebarSection("branches");
    requestAnimationFrame(() => document.getElementById("new-branch-name")?.focus());
  }

  function selectRepositoryView(view: RepositoryView): void {
    if (view === "changes") {
      repositoryViewTransitionID.current++;
      pendingRepositoryView.current = null;
      if (activeRepositoryView.current !== "changes") {
        activeRepositoryView.current = "changes";
        setActiveRepositoryView("changes");
      }
      return;
    }
    if (activeRepositoryView.current === "history" || pendingRepositoryView.current === "history") {
      return;
    }

    const repository = appStore.state.selectedRepository;
    if (repository === null) {
      return;
    }
    const transitionID = ++repositoryViewTransitionID.current;
    pendingRepositoryView.current = "history";

    void historyStore.load(repository.path).then(() => {
      if (
        repositoryViewTransitionID.current === transitionID &&
        appStore.state.selectedRepository?.path === repository.path
      ) {
        pendingRepositoryView.current = null;
        activeRepositoryView.current = "history";
        setActiveRepositoryView("history");
      }
    });
  }

  useQaStateDriver({
    applyTheme: (theme) => preferencesStore.setTheme(theme),
    setRepositoryView: (view) => selectRepositoryView(view),
    setSidebarCollapsed,
    selectRepositoryByPath: async (path) => {
      const existing = appStore.state.repositories.find(
        (repository) =>
          repository.path === path ||
          repository.path.replace(/\/+$/, "") === path.replace(/\/+$/, ""),
      );
      if (existing !== undefined) {
        await appStore.selectRepository(existing);
        return true;
      }
      await appStore.addRepository(path);
      return true;
    },
    startHistoryOperation: async ({ kind, commit, summary, parentCount }) => {
      const repository = appStore.state.selectedRepository;
      if (repository === null) {
        return;
      }
      if (kind === "cherryPick") {
        await cherryPick(repository.path, [{ sha: commit, summary: summary ?? "QA cherry-pick" }]);
      } else {
        await revertCommit(repository.path, commit, parentCount ?? 1);
      }
    },
  });

  return {
    appState,
    operationState,
    operationStore,
    branchState,
    branchStore,
    cloneState,
    cloneStore,
    conflictState,
    conflictStore,
    historyState,
    historyStore,
    messageState,
    messageStore,
    preferencesState,
    preferencesStore,
    remoteState,
    workingTreeState,
    workingTreeStore,
    repositoryView,
    setRepositoryView: selectRepositoryView,
    sidebarCollapsed,
    setSidebarCollapsed,
    expandedSidebarSections,
    commitMessage,
    setCommitMessage,
    bypassHooks,
    setBypassHooks,
    commitTerminalOutput,
    showWindowDragRegion,
    newBranchName,
    setNewBranchName,
    cloneURL,
    setCloneURL,
    clonePath,
    setClonePath,
    showCloneDialog,
    repositoryToRemove,
    setRepositoryToRemove,
    removeRepositoryError,
    removingRepository,
    cancelRemoveRepository,
    showAboutDialog,
    setShowAboutDialog,
    appArchitecture,
    showPreferencesDialog,
    setShowPreferencesDialog,
    discardFile,
    permanentlyDiscard,
    discardSelection,
    discarding,
    createRepository,
    addExistingRepository,
    openCloneDialog,
    dismissCloneDialog,
    chooseCloneDestination,
    submitClone,
    selectRepository,
    openRepositoryContextMenu,
    requestRemoveRepository,
    runRepositoryAction,
    confirmRemoveRepository,
    openInShell,
    openInExternalEditor,
    refreshAfterBranchChange,
    refreshAfterFetch,
    refreshAfterPush,
    refreshAfterPull,
    stageResolvedConflict,
    requestDiscard,
    confirmDiscard,
    cancelDiscard,
    discardAll,
    discardOptOut,
    setDiscardOptOut,
    requestDiscardAll,
    confirmDiscardAll,
    cancelDiscardAll,
    branchToRename,
    renameName,
    setRenameName,
    confirmRename,
    cancelRename,
    branchToDelete,
    deleteRefusal,
    deleteUnmerged,
    deletePruneTrackingRef,
    setDeletePruneTrackingRef,
    confirmDelete,
    cancelDelete,
    requestRename,
    requestDelete,
    renameCurrentBranch,
    deleteCurrentBranch,
    openBranchContextMenu,
    openCommitContextMenu,
    continueHistoryRecovery,
    abortHistoryRecovery,
    continueRebaseRecovery,
    abortRebaseRecovery,
    abortMergeRecovery,
    squashSelectedCommits,
    reorderSelectedCommits,
    mergePickerOpen,
    mergeTarget,
    setMergeTarget,
    mergeMessage,
    mergeRunning,
    mergeStatus,
    mergeCommitCount,
    mergeStrategy,
    setMergeStrategy,
    mergePreviewError,
    mergedBranches,
    confirmMerge,
    cancelMerge,
    requestMerge,
    rebasePickerOpen,
    rebaseTarget,
    setRebaseTarget,
    rebaseMessage,
    rebaseRunning,
    rebasePreview,
    rebasePreviewError,
    confirmRebase,
    cancelRebase,
    requestRebase,
    showManageRemotes,
    remoteFilter,
    setRemoteFilter,
    showAddRemote,
    addRemoteName,
    setAddRemoteName,
    addRemoteURL,
    setAddRemoteURL,
    manageRemoteError,
    manageRunning,
    openAddRemote,
    closeAddRemote,
    confirmAddRemote,
    confirmRemoveRemote,
    closeManageRemotes,
    requestManageRemotes,
    toggleSidebarSection,
    activateSidebarSection,
    showBranches,
    goToCommitMessage,
    increaseActiveResizableWidth,
    decreaseActiveResizableWidth,
    createBranch,
    sidebarWidth,
    setSidebarWidth,
    showBranchCreation,
    setShowBranchCreation,
  };
}

export type AppController = ReturnType<typeof useAppController>;
