import { CommittedFileChange } from './status'

export interface IStashEntry {
  /** The fully qualified name of the entry i.e., `refs/stash@{0}` */
  readonly name: string

  /** The name of the branch at the time the entry was created. */
  readonly branchName: string

  /** The user-provided name of the entry, if any. */
  readonly customName: string | null

  /** The SHA of the commit object created as a result of stashing. */
  readonly stashSha: string

  /** The date when the stash entry was created. */
  readonly createdAt: Date

  /** The list of files this stash touches */
  readonly files: StashedFileChanges

  readonly tree: string
  readonly parents: ReadonlyArray<string>
}

/** Whether file changes for a stash entry are loaded or not */
export enum StashedChangesLoadStates {
  NotLoaded = 'NotLoaded',
  Loading = 'Loading',
  Loaded = 'Loaded',
}

/**
 * The status of stashed file changes
 *
 * When the status us `Loaded` all the files associated
 * with the stash are made available.
 */
export type StashedFileChanges =
  | {
      readonly kind:
        | StashedChangesLoadStates.NotLoaded
        | StashedChangesLoadStates.Loading
    }
  | {
      readonly kind: StashedChangesLoadStates.Loaded
      readonly files: ReadonlyArray<CommittedFileChange>
    }

export type StashCallback = (stashEntry: IStashEntry) => Promise<void>

export function entryToString(stashEntry: IStashEntry): string {
  if (stashEntry.customName !== null) {
    return stashEntry.customName
  }
  if (stashEntry.files.kind !== StashedChangesLoadStates.Loaded) {
    return `${stashEntry.name} | Loading...`
  }
  if (stashEntry.files.files.length === 0) {
    return `${stashEntry.name} | No changes`
  }
  const firstFileBaseName = baseName(stashEntry.files.files[0].path)
  if (stashEntry.files.files.length === 1) {
    return firstFileBaseName
  }
  return `${firstFileBaseName} + ${stashEntry.files.files.length - 1} more`
}

function baseName(filePath: string): string {
  const separator = __WIN32__ ? '\\' : '/'
  return filePath.split(separator).pop() || ''
}
