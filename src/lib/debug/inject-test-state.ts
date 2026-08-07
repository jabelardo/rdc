/**
 * Debug-only stub-state injector for visual validation of dialogs.
 *
 * Every migrated dialog needs app state (selected repo, working tree files,
 * branches, remotes) that doesn't exist when the app launches empty. This
 * module injects minimal fake state into the stores so every dialog can be
 * opened from Help → Show Dialog without real data.
 *
 * Compiled only in dev builds (__DEV__ is false in production). The module
 * is never imported outside debug code paths.
 */

import { Repository } from "../../models/repository";
import { Branch, BranchType } from "../../models/branch";
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
  WorkingDirectoryStatus,
} from "../../models/status";
import { DiffSelection, DiffSelectionType } from "../../models/diff/diff-selection";
import { getDefaultAppStore } from "../stores/default-app-store";
import { getDefaultWorkingTreeStore } from "../stores/default-working-tree-store";
import { getDefaultBranchStore } from "../stores/default-branch-store";
import { getDefaultRemoteStore } from "../stores/default-remote-store";

// ── Stub data factories ──────────────────────────────────────────────

const stubSha = "a".repeat(40);

function stubRepo(): Repository {
  return new Repository(
    "/tmp/debug-repo",
    999_999,
    null,
    false,
    null,
    null,
    "main",
    {},
    null,
    false,
    null,
    undefined,
    null,
  );
}

function stubBranch(name: string, type: BranchType = BranchType.Local): Branch {
  return new Branch(
    name,
    null,
    { sha: stubSha, author: { date: new Date() } },
    type,
    type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/origin/${name}`,
    false,
  );
}

function stubFileChange(path: string): WorkingDirectoryFileChange {
  return new WorkingDirectoryFileChange(
    path,
    { kind: AppFileStatusKind.Modified },
    DiffSelection.fromInitialSelection(DiffSelectionType.All),
  );
}

// ── Store injection ───────────────────────────────────────────────────

/**
 * Directly set a store's private currentState field and fire its listeners.
 * Bypasses the private update() method entirely — works regardless of whether
 * update is accessible via `as any`.
 */
function setStoreState(store: unknown, state: unknown): void {
  const s = store as Record<string, unknown>;
  s["currentState"] = state;
  const listeners = s["listeners"] as Set<(state: unknown) => void> | undefined;
  if (listeners) {
    for (const listener of listeners) {
      listener(state);
    }
  }
}

type DebugStateOptions = {
  /**
   * Whether to leave a pending hook failure in the working-tree state.
   *
   * Opt-in, and off by default: the hook-failure dialog renders from working-tree state alone, so
   * injecting it unconditionally put it in front of every *other* dialog the debug menu tried to
   * preview — the whole Show Dialog submenu showed the pre-commit failure instead.
   */
  readonly hookFailure?: boolean;
};

/**
 * Inject minimal stub state into every store the dialogs read from.
 * Sets COMPLETE state (no spread) to avoid stale fields from previous loads.
 * Returns the stub repository for use by controller-level state setters.
 */
export function injectDebugState(options: DebugStateOptions = {}): Repository {
  const repo = stubRepo();

  // ── AppStore ──
  // Set the repository list but do NOT set selectedRepository — the
  // controller's useEffect loads store data when selectedRepository
  // changes, and that load immediately sets remotes: [] / branches: [],
  // overwriting our stub data before the dialog renders.
  const appStore = getDefaultAppStore() as unknown as {
    repositories: Repository[];
    selectedRepository: Repository | null;
    emitUpdate: () => void;
  };
  appStore.repositories = [repo];
  appStore.emitUpdate();

  // ── BranchStore ──
  const threeDaysAgo = new Date(Date.now() - 86_400_000 * 3);
  const weekAgo = new Date(Date.now() - 86_400_000 * 7);

  function stubBranchWithDate(
    name: string,
    type: BranchType = BranchType.Local,
    date: Date = new Date(),
  ): Branch {
    return new Branch(
      name,
      null,
      { sha: stubSha, author: { date } },
      type,
      type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/origin/${name}`,
      false,
    );
  }

  setStoreState(getDefaultBranchStore(), {
    repositoryPath: repo.path,
    currentBranch: "main",
    defaultBranch: "main",
    branches: [
      stubBranchWithDate("main", BranchType.Local, weekAgo),
      stubBranchWithDate("develop"),
      stubBranchWithDate("feature/add-user-authentication-flow"),
      stubBranchWithDate("feature/update-dashboard-layout"),
      stubBranchWithDate("hotfix/critical-security-patch"),
      stubBranchWithDate("bugfix/resolve-navigation-issue"),
      stubBranchWithDate("release/v2.0.0"),
      stubBranchWithDate("origin/main", BranchType.Remote, weekAgo),
      stubBranchWithDate("origin/develop", BranchType.Remote, threeDaysAgo),
      stubBranchWithDate("origin/feature/add-user-authentication-flow", BranchType.Remote),
    ],
    recentBranches: ["feature/update-dashboard-layout", "hotfix/critical-security-patch"],
    loading: false,
    error: null,
    operation: null,
    progress: null,
    operationError: null,
  });

  // ── RemoteStore ──
  setStoreState(getDefaultRemoteStore(), {
    repositoryPath: repo.path,
    remotes: [
      { name: "origin", url: "https://github.com/debug/debug-repo.git" },
      { name: "upstream", url: "https://github.com/upstream/debug-repo.git" },
    ],
    currentRemote: null,
    currentBranch: null,
    loading: false,
    error: null,
    operation: null,
    progress: null,
    operationError: null,
  });

  // ── WorkingTreeStore ──
  setStoreState(getDefaultWorkingTreeStore(), {
    repositoryPath: repo.path,
    workingDirectory: WorkingDirectoryStatus.fromFiles([
      stubFileChange("src/app.ts"),
      stubFileChange("README.md"),
      stubFileChange("untracked-file.txt"),
    ]),
    selectedFileID: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    commitLoading: false,
    commitError: null,
    hookFailure:
      options.hookFailure === true
        ? {
            hook: "pre-commit",
            terminalOutput:
              "$ npm run lint\n\n> rdc@0.0.0 lint\n> oxlint src/\n\nsrc/utils.ts:42:5 error: unexpected unused variable `x`\n\n1 problem (1 error, 0 warnings)\n\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n",
          }
        : null,
    loading: false,
    error: null,
    mergeHeadFound: false,
  });

  return repo;
}
