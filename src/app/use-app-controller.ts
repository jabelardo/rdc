import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Branch } from "@/models/branch";
import type { Commit } from "@/models/commit";
import { nameOf, type Repository } from "@/models/repository";
import {
  isContiguousSelection,
  orderSelectedCommits,
} from "@/features/history/history-operation-selection";
import { abortRebase, continueRebase, initRepository } from "@/lib/ipc/git-ipc";
import { abortRevert, getRepositoryType, revertCommit } from "@/lib/ipc/misc-ipc";
import { repositoryAvailability } from "@/features/repositories/repository-availability";
import { reportErrorMessage } from "@/lib/messages/report";
import {
  abortCherryPick,
  cherryPick,
  continueCherryPick,
  reorder,
  squash,
} from "@/lib/ipc/stash-ipc";
import { installApplicationMenu } from "@/app/menu/application-menu";
import { showContextMenu } from "@/platform/menu";
import { dismissAllTooltips } from "@/components/tooltip/tooltip";
import { currentMenuPlatform } from "@/models/menu-platform";
import { buildRepositoryMenu, createRepositoryMenuEventExecutor } from "@/app/menu/repository-menu";
import { getMainProcessConfig } from "@/platform/config";
import { showOpenDialog, showSaveDialog } from "@/platform/dialogs";
import { launchExternalEditor } from "@/platform/editors";
import {
  debugMergePreview,
  debugMergedBranches,
  debugRebasePreview,
  isDebugStateInjected,
  injectCloneProgress,
  injectDebugState,
  injectPreferencesFailure,
} from "@/testing/inject-test-state";
import { deleteBranchRefusal } from "@/features/branches/delete-branch-refusal";
import { showFolderContents } from "@/platform/files";
import { getAppArchitecture, type Architecture } from "@/platform/paths";
import { installDefaultCloseRequestHandler } from "@/platform/lifetime";
import { launchShell } from "@/platform/shells";
import { onNativeThemeUpdated } from "@/platform/theme";
import { useQaStateDriver } from "@/testing/use-qa-state-driver";
import {
  getCurrentWindowLabel,
  onWindowFocusChanged,
  openRepositoryInNewWindow,
  sendReady,
  setWindowTitle,
} from "@/platform/window";
import { shouldShowWindowDragRegion } from "@/platform/window-drag-region";
import { setWindowZoomFactor } from "@/platform/window";
import type { AppStoreState } from "@/features/repositories/stores/app-store";
import type { BranchState } from "@/features/branches/stores/branch-store";
import type { CloneState } from "@/features/remotes/stores/clone-store";
import type { ConflictState } from "@/features/conflicts/stores/conflict-store";
import { getDefaultAppStore } from "@/features/repositories/stores/default-app-store";
import { getDefaultBranchStore } from "@/features/branches/stores/default-branch-store";
import { getDefaultCloneStore } from "@/features/remotes/stores/default-clone-store";
import { reportError } from "@/lib/messages/report";
import { getDefaultConflictStore } from "@/features/conflicts/stores/default-conflict-store";
import { getDefaultHistoryStore } from "@/features/history/stores/default-history-store";
import { getDefaultMessageStore } from "@/lib/messages/default-message-store";
import { getDefaultPreferencesStore } from "@/features/preferences/stores/default-preferences-store";
import { getDefaultRemoteStore } from "@/features/remotes/stores/default-remote-store";
import { useRemoteDialogs } from "@/features/remotes/use-remote-dialogs";
import { useDiscardDialogs } from "@/features/changes/use-discard-dialogs";
import { useBranchNameDialogs } from "@/features/branches/use-branch-name-dialogs";
import { useMergeRebaseDialogs } from "@/features/branches/use-merge-rebase-dialogs";
import { useCloneDialog } from "@/features/remotes/use-clone-dialog";
import { useAbortMergeDialog } from "@/features/conflicts/use-abort-merge-dialog";
import { useRemoveRepositoryDialog } from "@/features/repositories/use-remove-repository-dialog";
import { getDefaultWorkingTreeStore } from "@/features/changes/stores/default-working-tree-store";
import type { HistoryState } from "@/features/history/stores/history-store";
import type { MessageState } from "@/lib/messages/message-store";
import type { PreferencesState } from "@/features/preferences/stores/preferences-store";
import type { RemoteState } from "@/features/remotes/stores/remote-store";
import type { WorkingTreeState } from "@/features/changes/stores/working-tree-store";
import type { SidebarSectionID } from "@/app/sidebar/sidebar-sections";
import { OperationStore } from "@/lib/operations/operation-store";
import {
  isTerminalOperation,
  operationProgressViewModel,
} from "@/lib/operations/operation-presentation";
import {
  operationPreviewRecord,
  type OperationPreviewState,
} from "@/testing/operation-progress-preview";
import type {
  GitOperationKind,
  OperationPresentationRole,
  OperationRecord,
} from "@/models/operation";

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
  const {
    renameDialog,
    deleteDialog,
    requestRename,
    renameCurrentBranch,
    requestDelete,
    deleteCurrentBranch,
    showDeleteRefusal,
  } = useBranchNameDialogs({
    repositoryPath: appState.selectedRepository?.path ?? null,
    branchState,
    branchStore,
    refreshAfterBranchChange,
  });

  // Distinct from a status: "we could not work out whether this can merge" is not the same claim as
  // any ComputedAction, and collapsing it into one was reporting failures as "already up to date".
  // `git branch --merged`'s ref-to-SHA map for the current branch. One call on open, not one per
  // branch — and keeping the SHAs is what lets a remote branch on an already-merged commit be
  // recognised, since --merged itself reports only local refs.
  // Distinct from a preview: "we could not work out how far apart these branches are" is not the
  // same claim as any ComputedAction, and collapsing it into one reported failures as "up to date".
  const { discardDialog, requestDiscard, requestDiscardAll, showDiscardFilePreview } =
    useDiscardDialogs({
      repositoryPath: appState.selectedRepository?.path ?? null,
      workingTreeState,
      workingTreeStore,
      confirmations: {
        beforeDiscard: () => preferencesStore.state.confirmDiscardChanges,
        beforePermanentDiscard: () => preferencesStore.state.confirmDiscardChangesPermanently,
        stopAskingBeforeDiscard: () => preferencesStore.setConfirmDiscardChanges(false),
        stopAskingBeforePermanentDiscard: () =>
          preferencesStore.setConfirmDiscardChangesPermanently(false),
      },
    });

  const {
    manageRemotesDialog,
    addRemoteDialog,
    manageRemoteError,
    manageRunning,
    requestManageRemotes,
    openAddRemote,
    showManageRemotesFailure,
  } = useRemoteDialogs({
    repositoryPath: appState.selectedRepository?.path ?? null,
    remotes: remoteState.remotes,
    remoteStore,
    onRemotesChanged: (repositoryPath) => branchStore.load(repositoryPath),
  });

  // Stable across renders: the preview effects depend on this, and a fresh object each render
  // would re-run them on every keystroke. The three functions are module-level and the injected
  // flag only ever flips once, at the moment a debug entry stubs the stores.
  const debugPreviews = useMemo(
    () => ({
      mergePreview: (branchName: string) =>
        isDebugStateInjected() ? debugMergePreview(branchName) : null,
      rebasePreview: (branchName: string) =>
        isDebugStateInjected() ? debugRebasePreview(branchName) : null,
      mergedBranches: () => (isDebugStateInjected() ? debugMergedBranches() : null),
    }),
    [],
  );

  const { mergeDialog, rebaseDialog, requestMerge, requestRebase } = useMergeRebaseDialogs({
    repositoryPath: appState.selectedRepository?.path ?? null,
    branchState,
    branchStore,
    defaultMergeStrategy: () => preferencesStore.state.defaultMergeStrategy,
    isWorkingTreeDirty: () => (workingTreeStore.state.workingDirectory?.files.length ?? 0) > 0,
    debugPreviews,
    refreshAfterBranchChange,
  });

  const { removeRepositoryDialog, requestRemoveRepository, showRemoveRepositoryPreview } =
    useRemoveRepositoryDialog({
      removeRepository: (repository) => appStore.removeRepository(repository),
      confirmBeforeRemoving: () => preferencesStore.state.confirmRepositoryRemoval,
      runUnconfirmed: (remove) => void runRepositoryAction(remove),
    });

  const { abortMergeDialog, requestAbortMerge, showAbortMergePreview } = useAbortMergeDialog({
    repositoryPath: appState.selectedRepository?.path ?? null,
    conflictState,
    conflictStore,
    onAborted: (path) => Promise.all([workingTreeStore.load(path), branchStore.load(path)]),
  });

  const { cloneDialog, openCloneDialog, setCloneDialogVisible } = useCloneDialog({
    cloneState,
    cloneStore,
    onCloned: (path) => appStore.addRepository(path),
  });

  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [debugProgressLauncher, setDebugProgressLauncher] = useState(false);
  const [debugProgressRecord, setDebugProgressRecord] = useState<OperationRecord | null>(null);
  const [debugProgressRole, setDebugProgressRole] = useState<OperationPresentationRole>("owner");
  // Resolved once and shown in About, where it exists so a version string can be pasted
  // into a bug report complete with the architecture it was running under.
  const [appArchitecture, setAppArchitecture] = useState<Architecture | null>(null);
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);
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
      abortMerge: requestAbortMerge,
      permanentlyDiscardAllChanges: () => requestDiscardAll(true),
      renameBranch: renameCurrentBranch,
      deleteBranch: deleteCurrentBranch,
      mergeBranch: requestMerge,
      manageRemotes: requestManageRemotes,
      showDiscardFileDialog: () => {
        injectDebugState();
        const firstFile = workingTreeStore.state.workingDirectory?.files[0];
        if (firstFile !== undefined) {
          showDiscardFilePreview(firstFile.id);
        }
      },
      showAddRemoteDialog: () => {
        injectDebugState();
        openAddRemote();
      },
      showRemoveRepositoryDialog: () => {
        injectDebugState();
        if (appStore.state.selectedRepository !== null) {
          showRemoveRepositoryPreview(appStore.state.selectedRepository);
        }
      },
      debugShowAboutDialog: () => setShowAboutDialog(true),
      debugShowPreferencesDialog: () => {
        // Clears a failure the "(failed)" entry may have left in the store, which nothing else
        // does — otherwise this entry would preview the other one's state.
        injectPreferencesFailure(null);
        setShowPreferencesDialog(true);
      },
      debugShowCloneDialog: () => openCloneDialog(),
      debugShowOperationProgressDialog: () => setDebugProgressLauncher(true),
      debugShowCloneProgressDialog: () => {
        // No real clone can run from the debug menu, so drive the category-1 progress step with a
        // canned clone that actually advances: value and git line moving 0→100 frame by frame over
        // a few seconds, then a synthetic finish. A static bar would never exercise the live
        // updates the dialog exists for, and an undismissable dialog that never ends would lock
        // the UI forever.
        setCloneDialogVisible(true);
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
            setCloneDialogVisible(false);
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
      // The notice, not the confirmation. `deleteCurrentBranch` above reaches the confirm dialog
      // because the injected state is not yet visible to this render's `branchState`, so the
      // refusal never fires there — which left the one `NoticeDialog` in the app unpreviewable.
      // The wording comes from the same function the real refusal uses, so it cannot drift.
      debugShowDeleteBranchRefusalDialog: () => {
        injectDebugState();
        const stub = branchStore.state;
        const refusal = deleteBranchRefusal(
          stub.currentBranch ?? "main",
          stub.currentBranch,
          stub.defaultBranch,
        );
        if (refusal !== null) {
          showDeleteRefusal(refusal);
        }
      },
      debugShowAbortMergeDialog: () => {
        injectDebugState();
        showAbortMergePreview(null);
      },
      // Convention 17's invariant is the thing to look at here: a dialog showing a failure must
      // still offer an enabled way out, or a retryable dialog becomes a trap.
      debugShowAbortMergeFailedDialog: () => {
        injectDebugState();
        showAbortMergePreview("fatal: There is no merge to abort (MERGE_HEAD missing).");
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
      // The same dialog over a list that overflows its scroll region, which two remotes cannot
      // show — the fixed height exists so the dialog does not resize as remotes are added.
      debugShowManageRemotesLongDialog: () => {
        injectDebugState({ manyRemotes: true });
        requestManageRemotes();
      },
      // `requestManageRemotes` clears the error on the way in, so the failure is set after it.
      debugShowManageRemotesFailedDialog: () => {
        injectDebugState();
        showManageRemotesFailure('Could not remove "upstream": remote is in use by a worktree.');
      },
      debugShowPreferencesFailedDialog: () => {
        injectPreferencesFailure("Could not save preferences: the settings file is read-only.");
        setShowPreferencesDialog(true);
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
    commit: import("@/models/commit").Commit,
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

  /** Opens the confirmation. Aborting throws away uncommitted resolution work, so it is destructive. */

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

  /**
   * The branch dialogs, each as one object that is `null` when its dialog is closed.
   *
   * Grouping is not cosmetic here. The flat form needed a separate `mergePickerOpen`-style flag
   * beside every dialog's fields, and a host that read the fields while the flag said closed was a
   * bug the types allowed. Nullability carries "is it open" instead, so the state and its openness
   * cannot disagree — and adding a field to one dialog stops widening the signature the others
   * share.
   */

  /** The remote dialogs, each `null` while closed — see the branch dialogs above for why. */

  /** The changes dialogs. Discarding is one dialog with two shapes; the commit's is not a decision. */

  const commitProgress = !workingTreeState.commitLoading
    ? null
    : {
        terminalOutput: commitTerminalOutput,
        runningHook: workingTreeState.runningHook,
        onStopHook: () => void workingTreeStore.stopHook(),
      };

  const hookFailureDialog =
    workingTreeState.hookFailure === null
      ? null
      : {
          failure: workingTreeState.hookFailure,
          onResolve: (resolution: "abort" | "ignore") =>
            workingTreeStore.resolveHookFailure(resolution),
        };

  /** The dialogs no feature owns, each `null` while closed — same shape as the feature hosts. */

  const aboutDialog = !showAboutDialog
    ? null
    : { architecture: appArchitecture, onDismiss: () => setShowAboutDialog(false) };

  const preferencesDialog = !showPreferencesDialog
    ? null
    : {
        state: preferencesState,
        store: preferencesStore,
        onDismiss: () => setShowPreferencesDialog(false),
      };

  return {
    abortMergeDialog,
    removeRepositoryDialog,
    aboutDialog,
    preferencesDialog,
    preferencesStore,
    discardDialog,
    commitProgress,
    hookFailureDialog,
    manageRemotesDialog,
    addRemoteDialog,
    cloneDialog,
    mergeDialog,
    rebaseDialog,
    renameDialog,
    deleteDialog,
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
    debugProgressLauncher,
    // The role is overridden rather than derived, so the window label is unused — the same shape
    // the toolbar's own call uses. A preview cannot conjure a second window to be an observer of.
    debugProgressViewModel:
      debugProgressRecord === null
        ? undefined
        : operationProgressViewModel(debugProgressRecord, "", debugProgressRole),
    onDebugShowOperationProgress: (
      state: OperationPreviewState,
      operation: GitOperationKind,
      role: OperationPresentationRole,
    ) => {
      setDebugProgressRecord(
        operationPreviewRecord(state, operation, role === "unowned" ? null : "main"),
      );
      setDebugProgressRole(role);
      setDebugProgressLauncher(false);
    },
    onDebugDismissOperationProgressLauncher: () => setDebugProgressLauncher(false),
    onDebugDismissOperationProgress: () => setDebugProgressRecord(null),
    createRepository,
    addExistingRepository,
    openCloneDialog,
    selectRepository,
    openRepositoryContextMenu,
    requestRemoveRepository,
    runRepositoryAction,
    openInShell,
    openInExternalEditor,
    refreshAfterBranchChange,
    refreshAfterFetch,
    refreshAfterPush,
    refreshAfterPull,
    stageResolvedConflict,
    requestDiscard,
    requestDiscardAll,
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
    requestAbortMerge,
    squashSelectedCommits,
    reorderSelectedCommits,
    requestMerge,
    requestRebase,
    manageRemoteError,
    manageRunning,
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
