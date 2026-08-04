import { describe, expect, it } from 'vitest'
import type { AppFileStatus } from '../models/status'
import {
  AppFileStatusKind,
  GitStatusEntry,
  UnmergedEntrySummary,
  isConflictWithMarkers,
  isManualConflict,
} from '../models/status'
import { mapStatus } from './status'
import {
  MergeResult,
  RebaseResult,
  type IRebaseSnapshot,
  type IStatusResult,
} from './git-ipc'
import snapshot from './__generated__/wire-snapshot.json'
import type {
  ICheckoutProgress,
  IMultiCommitOperationProgress,
} from '../models/progress'

/**
 * Proves the Rust wire shape is usable by the ported domain model.
 *
 * Two contract tests already existed and both missed a real bug.
 * `crates/git-ops/tests/wire_contract.rs` pins Rust against JSON written in that same file, and
 * `App.test.tsx` pins the `invoke` call. A conflict shape satisfied both while being impossible for
 * `src/lib/status.ts` to consume, because the Rust and its expectations were wrong together.
 *
 * The missing link was a check against `src/models/**`. This file is it, and the chain has no
 * hand-copied JSON in it:
 *
 * 1. `wire-snapshot.json` is **emitted by Rust** from the real serializer, not typed out here.
 * 2. The fixtures below are annotated with the ported types, so `tsc` rejects any shape the domain
 *    model would not accept.
 * 3. Each fixture is asserted equal to its snapshot entry.
 *
 * So a Rust change that drifts from the ported model fails step 3, and a fixture edited to match a
 * bad shape fails step 2. Neither can pass alone.
 *
 * Regenerate the snapshot after a deliberate shape change:
 *
 *     UPDATE_WIRE_SNAPSHOT=1 cargo test -p git-ops --test wire_contract
 *
 * Note this is also why the fixtures are typed rather than cast. `as AppFileStatus` would assert the
 * shape instead of checking it, which defeats the entire purpose of step 2.
 */

// --- fixtures: annotated with the ported types, compared to Rust's own output ---

const modified: AppFileStatus = {
  kind: AppFileStatusKind.Modified,
}

const modifiedSubmodule: AppFileStatus = {
  kind: AppFileStatusKind.Modified,
  submoduleStatus: {
    commitChanged: false,
    modifiedChanges: true,
    untrackedChanges: false,
  },
}

const renamed: AppFileStatus = {
  kind: AppFileStatusKind.Renamed,
  oldPath: 'before',
  renameIncludesModifications: true,
}

const textConflict: AppFileStatus = {
  kind: AppFileStatusKind.Conflicted,
  entry: {
    kind: 'conflicted',
    action: UnmergedEntrySummary.BothModified,
    us: GitStatusEntry.UpdatedButUnmerged,
    them: GitStatusEntry.UpdatedButUnmerged,
  },
  conflictMarkerCount: 3,
}

const resolvedTextConflict: AppFileStatus = {
  kind: AppFileStatusKind.Conflicted,
  entry: {
    kind: 'conflicted',
    action: UnmergedEntrySummary.BothAdded,
    us: GitStatusEntry.Added,
    them: GitStatusEntry.Added,
  },
  conflictMarkerCount: 0,
}

const manualConflict: AppFileStatus = {
  kind: AppFileStatusKind.Conflicted,
  entry: {
    kind: 'conflicted',
    action: UnmergedEntrySummary.DeletedByThem,
    us: GitStatusEntry.UpdatedButUnmerged,
    them: GitStatusEntry.Deleted,
  },
}

const statusResult: IStatusResult = {
  currentBranch: 'main',
  currentUpstreamBranch: 'origin/main',
  currentTip: 'abc123',
  branchAheadBehind: { ahead: 2, behind: 1 },
  mergeHeadFound: false,
  squashMsgFound: false,
  isCherryPickingHeadFound: false,
  files: [
    {
      path: 'src/thing.ts',
      status: { kind: AppFileStatusKind.Modified },
      startsUnselected: false,
    },
  ],
  doConflictedFilesExist: false,
}

const emptyStatusResult: IStatusResult = {
  mergeHeadFound: false,
  squashMsgFound: false,
  isCherryPickingHeadFound: false,
  files: [],
  doConflictedFilesExist: false,
}

const mergeResult: MergeResult = MergeResult.AlreadyUpToDate
const rebaseResult: RebaseResult = RebaseResult.ConflictsEncountered
const checkoutProgress: ICheckoutProgress = {
  kind: 'checkout',
  value: 0.5,
  title: 'Checking out branch topic',
  description: 'Checking out files:  50% (1/2)',
  target: 'topic',
}
const multiCommitOperationProgress: IMultiCommitOperationProgress = {
  kind: 'multiCommitOperation',
  value: 0.5,
  position: 1,
  totalCommitCount: 2,
  currentCommitSummary: 'First',
}
const rebaseSnapshot: IRebaseSnapshot = {
  progress: multiCommitOperationProgress,
  commits: [
    {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      summary: 'First',
    },
    {
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      summary: 'Second',
    },
  ],
}

describe('the git IPC wire shape', () => {
  it('matches what Rust actually serializes', () => {
    // The fixtures are type-checked against src/models/**; the snapshot comes from the Rust
    // serializer. Equality here is what ties the two together.
    const cases: ReadonlyArray<[string, unknown]> = [
      ['modified', modified],
      ['modifiedSubmodule', modifiedSubmodule],
      ['renamed', renamed],
      ['textConflict', textConflict],
      ['resolvedTextConflict', resolvedTextConflict],
      ['manualConflict', manualConflict],
      ['statusResult', statusResult],
      ['emptyStatusResult', emptyStatusResult],
      ['checkoutProgress', checkoutProgress],
      ['multiCommitOperationProgress', multiCommitOperationProgress],
      ['rebaseSnapshot', rebaseSnapshot],
      ['mergeResult', mergeResult],
      ['rebaseResult', rebaseResult],
    ]

    for (const [name, fixture] of cases) {
      expect(snapshot[name as keyof typeof snapshot], name).toEqual(fixture)
    }
  })

  it('covers every case the snapshot contains', () => {
    // Guards against a new Rust case being added to the snapshot without a typed fixture here,
    // which would otherwise silently skip the type check for it.
    expect(Object.keys(snapshot).sort()).toEqual([
      'addedImageDiff',
      // The frontend-owned application menu — covered by menu/menu-wire.test.ts.
      'appMenu',
      // The image diffs — covered by diff-ipc.test.ts (hydrated into the Image class).
      'binaryDiff',
      // The branch shapes — covered by branch-ipc.test.ts (hydrated into Branch).
      'branch',
      // Covered by log-ipc.test.ts (hydrated into CommittedFileChange).
      'changesetData',
      'checkoutProgress',
      // Stash, cherry-pick and submodules — covered by stash-ipc.test.ts.
      'cherryPickResult',
      // The remote shapes — covered by remote-ipc.test.ts.
      'cloneProgress',
      // Covered by log-ipc.test.ts (hydrated into Commit).
      'commit',
      // The custom integration validation shape — covered by platform/editors.test.ts.
      'customIntegrationPathValidation',
      'emptyStatusResult',
      'fetchProgress',
      // The platform editor shape — covered by platform/editors.test.ts.
      'foundEditor',
      // The platform shell shape — covered by platform/shells.test.ts.
      'foundShell',
      'goneBranch',
      // Covered by hook-ipc.test.ts.
      'hookProgress',
      'imageDiff',
      // Covered by diff-ipc.test.ts.
      'indexChanges',
      // The structured menu binding map — covered by platform/keybindings.test.ts.
      'keybindings',
      'largeTextDiff',
      'manualConflict',
      'mergeResult',
      // Mergeability, repository state, worktrees and trailers — covered by misc-ipc.test.ts.
      'mergeTreeClean',
      'mergeTreeConflicts',
      'modified',
      'modifiedSubmodule',
      'multiCommitOperationProgress',
      // Covered by diff-ipc.test.ts (hydrated into the models/diff classes).
      'parsedDiff',
      'pullProgress',
      'pushProgress',
      'pushProgressInitial',
      'rebaseResult',
      'rebaseSnapshot',
      'remote',
      'remoteBranch',
      'renamed',
      'repositoryTypeMissing',
      'repositoryTypeRegular',
      'repositoryTypeUnsafe',
      'resolvedTextConflict',
      // Covered by misc-ipc.test.ts.
      'revertProgress',
      'stashEntryWithoutCustomName',
      'stashResult',
      'statusResult',
      'submoduleDiff',
      'submoduleEntry',
      'svgImageDiff',
      'textConflict',
      // The IDiff union — covered by diff-ipc.test.ts.
      'textDiff',
      'textDiffWithLineEndingsChange',
      'trackingBranch',
      'trailer',
      'uninitializedSubmoduleEntry',
      'unrenderableDiff',
      // The window startup action — covered by models/cli-action.test.ts.
      'windowStartupAction',
      // Covered by worktree-ipc.test.ts.
      'worktreeEntry',
    ])
  })

  it('omits absent optionals rather than sending null', () => {
    // TypeScript optional properties and `T | null` are different types; Rust uses
    // skip_serializing_if to produce the former.
    expect('submoduleStatus' in snapshot.modified).toBe(false)
    expect('currentBranch' in snapshot.emptyStatusResult).toBe(false)
  })

  it('is consumable by the ported mapStatus', () => {
    expect(mapStatus(modified)).toBe('Modified')
    expect(mapStatus(renamed)).toBe('Renamed')
  })

  it('lets the ported type-guards discriminate the two conflict shapes', () => {
    // The original discriminated on the *presence* of conflictMarkerCount rather than a tag, so
    // this is what breaks first if the untagged representation is ever changed.
    expect(isConflictWithMarkers(textConflict)).toBe(true)
    expect(isManualConflict(textConflict)).toBe(false)

    expect(isConflictWithMarkers(manualConflict)).toBe(false)
    expect(isManualConflict(manualConflict)).toBe(true)
  })

  it('distinguishes an unresolved conflict from a resolved one by the marker count', () => {
    // mapStatus reaches through to `conflictMarkerCount`, so a flattened or renamed field would
    // silently report every conflict as unresolved.
    expect(mapStatus(textConflict)).toBe('Conflicted')
    expect(mapStatus(resolvedTextConflict)).toBe('Resolved')
    expect(mapStatus(manualConflict)).toBe('Conflicted')
  })
})
