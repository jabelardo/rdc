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
import type { IRemote } from "../../models/remote";
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
 * Inject minimal stub state into every store the dialogs read from.
 * Returns the stub repository for use by controller-level state setters.
 */
export function injectDebugState(): Repository {
  const repo = stubRepo();

  // ── AppStore ──
  // AppStore stores fields separately (not a single currentState), so we
  // set them directly then call emitUpdate() to notify React listeners.
  const appStore = getDefaultAppStore() as unknown as {
    repositories: Repository[];
    selectedRepository: Repository | null;
    emitUpdate: () => void;
  };
  appStore.repositories = [repo];
  appStore.selectedRepository = repo;
  appStore.emitUpdate();

  // ── BranchStore ──
  // BranchStore has private update(state) that takes the full BranchState.
  const branchStore = getDefaultBranchStore() as unknown as {
    currentState: Record<string, unknown>;
    update: (state: Record<string, unknown>) => void;
  };
  branchStore.update({
    ...branchStore.currentState,
    repositoryPath: repo.path,
    currentBranch: "main",
    defaultBranch: "main",
    branches: [
      stubBranch("main"),
      stubBranch("feature/fix"),
      stubBranch("origin/main", BranchType.Remote),
    ],
  });

  // ── RemoteStore ──
  // RemoteStore has private update(state) that takes the full RemoteState.
  const remoteStore = getDefaultRemoteStore() as unknown as {
    currentState: Record<string, unknown>;
    update: (state: Record<string, unknown>) => void;
  };
  const stubRemotes: IRemote[] = [
    { name: "origin", url: "https://github.com/debug/debug-repo.git" },
    { name: "upstream", url: "https://github.com/upstream/debug-repo.git" },
  ];
  remoteStore.update({
    ...remoteStore.currentState,
    repositoryPath: repo.path,
    remotes: stubRemotes,
  });

  // ── WorkingTreeStore ──
  // WorkingTreeStore has private update(state) that takes the full WorkingTreeState.
  const workingTreeStore = getDefaultWorkingTreeStore() as unknown as {
    currentState: Record<string, unknown>;
    update: (state: Record<string, unknown>) => void;
  };
  const stubFiles = [
    stubFileChange("src/app.ts"),
    stubFileChange("README.md"),
    stubFileChange("untracked-file.txt"),
  ];
  workingTreeStore.update({
    ...workingTreeStore.currentState,
    repositoryPath: repo.path,
    workingDirectory: WorkingDirectoryStatus.fromFiles(stubFiles),
    hookFailure: {
      hook: "pre-commit",
      terminalOutput:
        "$ npm run lint\n\n> rdc@0.0.0 lint\n> oxlint src/\n\nsrc/utils.ts:42:5 error: unexpected unused variable `x`\n\n1 problem (1 error, 0 warnings)\n\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n",
    },
  });

  return repo;
}
