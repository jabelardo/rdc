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

import { Repository } from "@/models/repository";
import { Branch, BranchType } from "@/models/branch";
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
  WorkingDirectoryStatus,
} from "@/models/status";
import { DiffSelection, DiffSelectionType } from "@/models/diff/diff-selection";
import { getDefaultAppStore } from "@/lib/stores/default-app-store";
import { getDefaultWorkingTreeStore } from "@/lib/stores/default-working-tree-store";
import { getDefaultBranchStore } from "@/lib/stores/default-branch-store";
import { getDefaultRemoteStore } from "@/lib/stores/default-remote-store";
import { ComputedAction } from "@/models/computed-action";
import type { IRemote } from "@/models/remote";
import type { MergeTreeResult } from "@/models/merge";
import type { RebasePreview } from "@/models/rebase-preview";
import { getDefaultCloneStore } from "@/lib/stores/default-clone-store";
import { getDefaultPreferencesStore } from "@/lib/stores/default-preferences-store";

// ── Stub data factories ──────────────────────────────────────────────

/** A stable, distinct 40-hex SHA per branch name. */
function stubShaFor(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)!) % 0xffff_ffff;
  }
  return hash.toString(16).padStart(8, "0").repeat(5);
}

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

function stubFileChange(path: string): WorkingDirectoryFileChange {
  return new WorkingDirectoryFileChange(
    path,
    { kind: AppFileStatusKind.Modified },
    DiffSelection.fromInitialSelection(DiffSelectionType.All),
  );
}

// ── Remote list stubs ─────────────────────────────────────────────────

/** Two remotes: what most repositories look like, and what the list's minimum height is sized for. */
const DebugRemotes: ReadonlyArray<IRemote> = [
  { name: "origin", url: "https://github.com/debug/debug-repo.git" },
  { name: "upstream", url: "https://github.com/upstream/debug-repo.git" },
];

/**
 * A remote list long enough to overflow, with the two rows that can break the layout.
 *
 * The dialog's list is a fixed-height scroll region precisely so that a repository with many
 * remotes does not resize the dialog, and two remotes cannot show that. The entries are not
 * padding: each row gives the name a `shrink-0` truncate and the URL the remaining space, so a
 * very long name is the case that can squeeze the URL to nothing, and a very long URL is the case
 * that decides whether truncation reads as truncation. Both are here, along with enough ordinary
 * rows to push them past the scroll boundary.
 */
const DebugManyRemotes: ReadonlyArray<IRemote> = [
  { name: "origin", url: "https://github.com/debug/debug-repo.git" },
  { name: "upstream", url: "https://github.com/upstream/debug-repo.git" },
  { name: "fork", url: "git@github.com:debug/debug-repo.git" },
  { name: "backup", url: "/Volumes/Backup/mirrors/debug-repo.git" },
  { name: "release", url: "https://git.example.com/release/debug-repo.git" },
  { name: "staging", url: "https://git.example.com/staging/debug-repo.git" },
  { name: "vendor", url: "https://vendor.example.net/scm/vendor/debug-repo.git" },
  { name: "security", url: "https://security.example.org/mirror/debug-repo.git" },
  {
    name: "a-remote-with-a-deliberately-long-name",
    url: "https://github.com/debug/debug-repo.git",
  },
  {
    name: "deep",
    url: "https://git.internal.example.com/organisation/department/team/subproject/debug-repo-with-a-very-long-path.git",
  },
  { name: "mirror", url: "https://gitlab.example.com/debug/debug-repo.git" },
  { name: "archive", url: "https://archive.example.com/debug/debug-repo.git" },
];

// ── Merge preview stubs ───────────────────────────────────────────────
//
// Mergeability is normally computed by git from the repository, so stub branches would otherwise
// produce no state at all and the merge dialog could not be reviewed from the debug menu. These
// canned answers exist so every outcome the dialog distinguishes is reachable there.

export type DebugMergePreview = {
  readonly status: MergeTreeResult;
  readonly commitCount: number;
};

/** Each stub branch is deliberately in a different state, so one pass covers the whole dialog. */
const DebugMergePreviews: ReadonlyMap<string, DebugMergePreview> = new Map<
  string,
  DebugMergePreview
>([
  // Clean, ordinary — the common case, and the only one that should read as unremarkable.
  [
    "feature/add-user-authentication-flow",
    { status: { kind: ComputedAction.Clean }, commitCount: 4 },
  ],
  // Clean and singular, so the "1 commit" wording is exercised rather than assumed.
  ["hotfix/critical-security-patch", { status: { kind: ComputedAction.Clean }, commitCount: 1 }],
  // Large enough to show thousands separators.
  [
    "bugfix/resolve-navigation-issue",
    { status: { kind: ComputedAction.Clean }, commitCount: 1284 },
  ],
  // Conflicts — offered anyway, because a conflict is an outcome to resolve, not a refusal.
  [
    "feature/update-dashboard-layout",
    { status: { kind: ComputedAction.Conflicts, conflictedFiles: 3 }, commitCount: 7 },
  ],
  // Unrelated histories — refused, with the button disabled.
  ["release/v2.0.0", { status: { kind: ComputedAction.Invalid }, commitCount: 0 }],
  // A remote branch that merges cleanly, so remotes are covered too.
  ["origin/develop", { status: { kind: ComputedAction.Clean }, commitCount: 2 }],
  // Reachable only by defeating the filter: a branch already contained in the current one.
  ["develop", { status: { kind: ComputedAction.Clean }, commitCount: 0 }],
  // The truncated row, so the tooltip's full name has something to reveal.
  [
    "feature/consolidate-address-module-backend-validation-and-error-reporting-pipeline",
    { status: { kind: ComputedAction.Clean }, commitCount: 9 },
  ],
]);

/** The canned preview for a stub branch, or null when the branch is not part of the debug set. */
export function debugMergePreview(branchName: string): DebugMergePreview | null {
  return DebugMergePreviews.get(branchName) ?? null;
}

/**
 * The stub equivalent of `git branch --merged`, so the candidate filter has something to remove.
 *
 * `develop` and its remote counterpart share a commit here, which is what makes the SHA half of the
 * filter observable: only `develop` is named, yet both disappear from the list.
 */
export function debugMergedBranches(): ReadonlyMap<string, string> {
  return new Map([["refs/heads/develop", stubShaFor("develop")]]);
}

// ── Rebase preview stubs ───────────────────────────────────────────────
//
// Like mergeability, the rebase relationship is normally computed by git from the two branches'
// ancestry. Stub branches have no ancestry, so these canned answers let every outcome the rebase
// dialog renders be reviewed from Help → Show Dialog.

/** Each stub branch maps to a preview in a different state, so one pass covers the whole dialog. */
const DebugRebasePreviews: ReadonlyMap<string, RebasePreview> = new Map<string, RebasePreview>([
  // Diverged and both ahead and behind — the ordinary rebase: replay the current branch's commits
  // on top of the base.
  ["develop", { kind: ComputedAction.Clean, commitsAhead: 3, commitsBehind: 2 }],
  // One commit to replay, so the singular "commit" wording is exercised.
  [
    "feature/add-user-authentication-flow",
    { kind: ComputedAction.Clean, commitsAhead: 1, commitsBehind: 3 },
  ],
  // Fast-forward: the current branch is a strict ancestor of the base, so it just moves forward.
  [
    "hotfix/critical-security-patch",
    { kind: ComputedAction.Clean, commitsAhead: 0, commitsBehind: 4 },
  ],
  // Fast-forward large enough to show the thousands separator.
  [
    "bugfix/resolve-navigation-issue",
    { kind: ComputedAction.Clean, commitsAhead: 0, commitsBehind: 1284 },
  ],
  // A remote base that rebases cleanly, so remotes are covered too.
  ["origin/develop", { kind: ComputedAction.Clean, commitsAhead: 1, commitsBehind: 2 }],
  // Unrelated histories — refused, with the button disabled.
  ["release/v2.0.0", { kind: ComputedAction.Invalid }],
  // The current branch is already past this base, so a rebase would be a no-op.
  [
    "feature/update-dashboard-layout",
    { kind: ComputedAction.Clean, commitsAhead: 2, commitsBehind: 0 },
  ],
  // The truncated row, so the tooltip's full name has something to reveal.
  [
    "feature/consolidate-address-module-backend-validation-and-error-reporting-pipeline",
    { kind: ComputedAction.Clean, commitsAhead: 5, commitsBehind: 3 },
  ],
]);

/** The canned rebase preview for a stub branch, or null when it is not part of the debug set. */
export function debugRebasePreview(branchName: string): RebasePreview | null {
  return DebugRebasePreviews.get(branchName) ?? null;
}

// ── Clone progress stub ─────────────────────────────────────────────────
//
// A clone cannot actually run from the debug menu (no network, no destination), yet the progress
// dialog still needs to be reviewable. These inject a mock in-flight clone into the clone store so
// the Clone dialog renders its category-1 progress step ("Cloning in progress") from Help → Show
// Dialog → Clone in progress…. The controller drives the bar 0→100 frame by frame with
// `injectCloneProgress`, so the preview exercises the live updates rather than a static value.

/** Publish a single mock clone progress frame, replacing the previous one. */
export function injectCloneProgress(value: number, description: string): void {
  setStoreState(getDefaultCloneStore(), {
    operation: "clone",
    progress: {
      kind: "clone",
      title: "Cloning into /tmp/mock-repo",
      value,
      description,
    },
    error: null,
    nativeOperation: null,
  });
}

/** The initial frame: a clone that has just started. */
export function injectCloneInProgress(): void {
  injectCloneProgress(0, "Cloning into '/tmp/mock-repo'...");
}

/**
 * Whether stub state has been injected in this session.
 *
 * Set once and never cleared: the injected state is not reversible either, and every caller is
 * behind the test-only menu.
 */
let debugStateInjected = false;

export function isDebugStateInjected(): boolean {
  return debugStateInjected;
}

// ── Store injection ───────────────────────────────────────────────────

/**
 * Directly set a store's private currentState field and fire its listeners.
 * Bypasses the private update() method entirely — works regardless of whether
 * update is accessible via `as any`.
 *
 * The generic is load-bearing rather than decoration. This writes a private field, so nothing else
 * checks the shape, and when this took `unknown` every store-field rename rotted these stubs
 * silently: they went on setting `error`/`operationError`/`diffError` long after those fields were
 * replaced, and the previewed dialogs were rendering against state the app no longer produces.
 * Inferring the state type from the store's own `state` getter makes the next rename a compile
 * error here, which is the only place it can be caught.
 */
function setStoreState<S>(store: { readonly state: S }, state: S): void {
  const s = store as unknown as Record<string, unknown>;
  s["currentState"] = state;
  const listeners = s["listeners"] as Set<(state: S) => void> | undefined;
  if (listeners) {
    for (const listener of listeners) {
      listener(state);
    }
  }
}

/**
 * Puts a failure on the preferences store, or clears one, without disturbing the loaded state.
 *
 * The spread is deliberate, and the exception to this module's no-spread rule: everything else here
 * builds a stub from nothing, where a spread would carry stale fields across loads. Preferences are
 * real — the editors and shells the dialog lists were read from the machine — so replacing them
 * with a stub would preview a dialog nobody has. Only the failure is injected.
 *
 * Clearing has to be possible for the same reason the hook failure is opt-in: this error lives in
 * the store and nothing but a reload clears it, so without an explicit reset the *plain*
 * Preferences entry would keep showing a failure injected by the other one.
 */
export function injectPreferencesFailure(message: string | null): void {
  const store = getDefaultPreferencesStore();
  setStoreState(store, { ...store.state, error: message });
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
  /** Whether the remote list should be long enough to overflow its scroll region. */
  readonly manyRemotes?: boolean;
};

/**
 * Inject minimal stub state into every store the dialogs read from.
 * Sets COMPLETE state (no spread) to avoid stale fields from previous loads.
 * Returns the stub repository for use by controller-level state setters.
 */
export function injectDebugState(options: DebugStateOptions = {}): Repository {
  debugStateInjected = true;
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
    sameCommitAs?: string,
  ): Branch {
    return new Branch(
      name,
      null,
      // Distinct per branch. They shared one SHA, which is not a state git can produce for
      // unrelated branches and which any SHA-based comparison reads as "the same commit".
      { sha: stubShaFor(sameCommitAs ?? name), author: { date } },
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
      // Long enough that the row must truncate it, which is the case the tooltip exists for.
      stubBranchWithDate(
        "feature/consolidate-address-module-backend-validation-and-error-reporting-pipeline",
      ),
      stubBranchWithDate("origin/main", BranchType.Remote, weekAgo),
      // Same commit as local `develop`, so filtering by SHA removes it even though
      // `git branch --merged` would only ever name the local ref.
      stubBranchWithDate("origin/develop", BranchType.Remote, threeDaysAgo, "develop"),
      stubBranchWithDate("origin/feature/add-user-authentication-flow", BranchType.Remote),
    ],
    recentBranches: ["feature/update-dashboard-layout", "hotfix/critical-security-patch"],
    loading: false,
    loadFailed: false,
    operation: null,
    progress: null,
    dialogError: null,
  });

  // ── RemoteStore ──
  setStoreState(getDefaultRemoteStore(), {
    repositoryPath: repo.path,
    remotes: options.manyRemotes ? DebugManyRemotes : DebugRemotes,
    currentRemote: null,
    currentBranch: null,
    loading: false,
    managementError: null,
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
    diffFailed: false,
    commitLoading: false,
    hookFailure:
      options.hookFailure === true
        ? {
            hook: "pre-commit",
            terminalOutput:
              "$ npm run lint\n\n> rdc@0.0.0 lint\n> oxlint src/\n\nsrc/utils.ts:42:5 error: unexpected unused variable `x`\n\n1 problem (1 error, 0 warnings)\n\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n",
          }
        : null,
    runningHook: null,
    loading: false,
    loadFailed: false,
    discardError: null,
    mergeHeadFound: false,
  });

  return repo;
}
