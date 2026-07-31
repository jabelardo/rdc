import {
  DiffSelection,
  DiffSelectionType,
  DiffType,
  type IDiff,
  type ITextDiff,
} from '../../models/diff'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
  WorkingDirectoryStatus,
} from '../../models/status'
import { caseInsensitiveCompare } from '../compare'
import {
  discardChanges as discardWorkingTreeChanges,
  TrashDiscardError,
} from '../discard-changes'
import {
  discardChangesFromSelection,
  getWorkingDirectoryDiff,
} from '../diff-ipc'
import {
  createCommit,
  getStatus,
  type IFileToStage,
  type IStatusResult,
} from '../git-ipc'
import type { HookFailureResolution } from '../hook-ipc'
import { TerminalOutputBuffer } from './terminal-output-buffer'

export type HookFailureState = {
  readonly hook: string
  readonly terminalOutput: string
}

export type WorkingTreeState = {
  readonly repositoryPath: string | null
  readonly workingDirectory: WorkingDirectoryStatus | null
  readonly selectedFileID: string | null
  readonly diff: IDiff | null
  readonly diffLoading: boolean
  readonly diffError: string | null
  readonly commitLoading: boolean
  readonly commitError: string | null
  readonly hookFailure: HookFailureState | null
  readonly loading: boolean
  readonly error: string | null
}

export type DiscardFileResult = 'discarded' | 'trash-failed' | 'failed'

export type SelectedLinesDiscard = {
  readonly repositoryPath: string
  readonly filePath: string
  readonly diff: ITextDiff
  readonly selectedLines: ReadonlyArray<number>
}

type WorkingTreeStoreDependencies = {
  readonly getStatus: typeof getStatus
  readonly getWorkingDirectoryDiff: typeof getWorkingDirectoryDiff
  readonly createCommit: typeof createCommit
  readonly discardChanges: typeof discardWorkingTreeChanges
  readonly discardChangesFromSelection: typeof discardChangesFromSelection
}

const defaultDependencies: WorkingTreeStoreDependencies = {
  getStatus,
  getWorkingDirectoryDiff,
  createCommit,
  discardChanges: discardWorkingTreeChanges,
  discardChangesFromSelection,
}

const EmptyState: WorkingTreeState = {
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
}

function workingDirectoryFromStatus(
  status: IStatusResult | null,
  previous: WorkingDirectoryStatus | null
): WorkingDirectoryStatus {
  const files = (status?.files ?? [])
    .map(file => {
      const next = new WorkingDirectoryFileChange(
        file.path,
        file.status,
        DiffSelection.fromInitialSelection(
          file.startsUnselected ? DiffSelectionType.None : DiffSelectionType.All
        )
      )
      const existing = previous?.findFileWithID(next.id)
      return existing === null || existing === undefined
        ? next
        : next.withSelection(existing.selection)
    })
    .sort((left, right) => caseInsensitiveCompare(left.path, right.path))

  return WorkingDirectoryStatus.fromFiles(files)
}

function fileToStage(file: WorkingDirectoryFileChange): IFileToStage {
  const selectionType = file.selection.getSelectionType()
  if (file.status.kind === AppFileStatusKind.Conflicted) {
    throw new Error('Resolve conflicted files before committing.')
  }
  const partial = selectionType === DiffSelectionType.Partial

  return {
    path: file.path,
    ...(partial
      ? {
          partial: {
            status: file.status,
            selectedLines: file.selection.getSelectedLines(),
          },
        }
      : {}),
    ...(!partial &&
    (file.status.kind === AppFileStatusKind.Renamed ||
      file.status.kind === AppFileStatusKind.Copied)
      ? { oldPath: file.status.oldPath }
      : {}),
    ...(!partial && file.status.kind === AppFileStatusKind.Deleted
      ? { deleted: true }
      : {}),
  }
}

function selectableLineIndices(diff: IDiff): Set<number> {
  const selectable = new Set<number>()
  if (diff.kind !== DiffType.Text && diff.kind !== DiffType.LargeText) {
    return selectable
  }

  for (const hunk of diff.hunks) {
    hunk.lines.forEach((line, index) => {
      if (line.isIncludeableLine()) {
        selectable.add(hunk.unifiedDiffStart + index)
      }
    })
  }
  return selectable
}

/**
 * Own the Phase 7b working-tree view state for the selected repository.
 *
 * Rust reports Git facts. Inclusion and partial-diff selection remain in the
 * frontend, matching upstream and preventing view state from becoming an IPC
 * contract.
 */
export class WorkingTreeStore {
  private currentState = EmptyState
  private requestID = 0
  private diffRequestID = 0
  private hookFailureResolver:
    | ((resolution: HookFailureResolution) => void)
    | null = null
  private readonly commitTerminalOutput = new TerminalOutputBuffer()
  private readonly dependencies: WorkingTreeStoreDependencies
  private readonly listeners = new Set<(state: WorkingTreeState) => void>()

  public constructor(dependencies: Partial<WorkingTreeStoreDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  public get state(): WorkingTreeState {
    return this.currentState
  }

  public onDidUpdate(listener: (state: WorkingTreeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public onCommitTerminalOutput(
    listener: (output: string) => void
  ): () => void {
    return this.commitTerminalOutput.subscribe(listener)
  }

  public async load(repositoryPath: string): Promise<void> {
    this.resolveHookFailure('abort')
    const requestID = ++this.requestID
    const previousWorkingDirectory =
      this.currentState.repositoryPath === repositoryPath
        ? this.currentState.workingDirectory
        : null
    const previousSelectedFileID =
      this.currentState.repositoryPath === repositoryPath
        ? this.currentState.selectedFileID
        : null
    this.update({
      repositoryPath,
      workingDirectory: null,
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      loading: true,
      error: null,
    })

    try {
      const status = await this.dependencies.getStatus(repositoryPath, true)
      if (requestID !== this.requestID) {
        return
      }
      const workingDirectory = workingDirectoryFromStatus(
        status,
        previousWorkingDirectory
      )
      const selectedFileID =
        workingDirectory.findFileWithID(previousSelectedFileID ?? '')?.id ??
        workingDirectory.files[0]?.id ??
        null
      this.update({
        repositoryPath,
        workingDirectory,
        selectedFileID,
        diff: null,
        diffLoading: false,
        diffError: null,
        commitLoading: false,
        commitError: null,
        hookFailure: null,
        loading: false,
        error: null,
      })
      await this.loadSelectedDiff(requestID)
    } catch (error) {
      if (requestID !== this.requestID) {
        return
      }
      this.update({
        repositoryPath,
        workingDirectory: null,
        selectedFileID: null,
        diff: null,
        diffLoading: false,
        diffError: null,
        commitLoading: false,
        commitError: null,
        hookFailure: null,
        loading: false,
        error: String(error),
      })
    }
  }

  public clear(): void {
    this.requestID++
    this.diffRequestID++
    this.resolveHookFailure('abort')
    this.commitTerminalOutput.clear()
    this.update(EmptyState)
  }

  public async selectFile(fileID: string): Promise<void> {
    const file =
      this.currentState.workingDirectory?.findFileWithID(fileID) ?? null
    if (file === null) {
      return
    }
    this.update({
      ...this.currentState,
      selectedFileID: fileID,
      diff: null,
      diffLoading: false,
      diffError: null,
    })
    await this.loadSelectedDiff(this.requestID)
  }

  public setFileIncluded(fileID: string, include: boolean): void {
    const workingDirectory = this.currentState.workingDirectory
    if (
      workingDirectory === null ||
      workingDirectory.findFileWithID(fileID) === null
    ) {
      return
    }
    const files = workingDirectory.files.map(file =>
      file.id === fileID ? file.withIncludeAll(include) : file
    )
    this.update({
      ...this.currentState,
      workingDirectory: WorkingDirectoryStatus.fromFiles(files),
    })
  }

  public setLineIncluded(lineIndex: number, include: boolean): void {
    const state = this.currentState
    const workingDirectory = state.workingDirectory
    const file =
      workingDirectory?.findFileWithID(state.selectedFileID ?? '') ?? null
    if (
      file === null ||
      state.diff === null ||
      !selectableLineIndices(state.diff).has(lineIndex)
    ) {
      return
    }

    const updatedFile = file.withSelection(
      file.selection.withLineSelection(lineIndex, include)
    )
    const files = workingDirectory!.files.map(candidate =>
      candidate.id === updatedFile.id ? updatedFile : candidate
    )
    this.update({
      ...state,
      workingDirectory: WorkingDirectoryStatus.fromFiles(files),
    })
  }

  public async discardFile(
    fileID: string,
    permanentlyDelete = false
  ): Promise<DiscardFileResult> {
    const state = this.currentState
    const file = state.workingDirectory?.findFileWithID(fileID) ?? null
    if (state.repositoryPath === null || file === null) {
      return 'failed'
    }

    try {
      await this.dependencies.discardChanges(state.repositoryPath, [file], {
        permanentlyDelete,
      })
      await this.load(state.repositoryPath)
      return 'discarded'
    } catch (error) {
      if (error instanceof TrashDiscardError) {
        return 'trash-failed'
      }
      this.update({
        ...this.currentState,
        loading: false,
        error: String(error),
      })
      return 'failed'
    }
  }

  public getSelectedLinesDiscard(): SelectedLinesDiscard | null {
    const state = this.currentState
    const file =
      state.workingDirectory?.findFileWithID(state.selectedFileID ?? '') ?? null
    if (
      state.repositoryPath === null ||
      file === null ||
      state.diff?.kind !== DiffType.Text
    ) {
      return null
    }
    const selectedLines = file.selection.getSelectedLines()
    if (selectedLines.length === 0) {
      return null
    }

    return {
      repositoryPath: state.repositoryPath,
      filePath: file.path,
      diff: state.diff,
      selectedLines,
    }
  }

  public async discardSelectedLines(
    discard = this.getSelectedLinesDiscard()
  ): Promise<boolean> {
    if (discard === null) {
      return false
    }

    try {
      await this.dependencies.discardChangesFromSelection(
        discard.repositoryPath,
        discard.filePath,
        discard.diff,
        discard.selectedLines
      )
      await this.load(discard.repositoryPath)
      return true
    } catch (error) {
      this.update({
        ...this.currentState,
        loading: false,
        error: String(error),
      })
      return false
    }
  }

  public resolveHookFailure(resolution: HookFailureResolution): void {
    const resolver = this.hookFailureResolver
    this.hookFailureResolver = null
    if (resolver === null) {
      return
    }
    this.update({
      ...this.currentState,
      hookFailure: null,
    })
    resolver(resolution)
  }

  public async commit(
    message: string,
    interceptHooks = false
  ): Promise<string | null> {
    const state = this.currentState
    if (state.repositoryPath === null || state.workingDirectory === null) {
      return null
    }
    const trimmedMessage = message.trim()
    if (trimmedMessage.length === 0) {
      this.update({
        ...state,
        commitError: 'Enter a commit message.',
      })
      return null
    }

    try {
      const files = state.workingDirectory.files
        .filter(
          file => file.selection.getSelectionType() !== DiffSelectionType.None
        )
        .map(fileToStage)
      if (files.length === 0) {
        this.update({
          ...state,
          commitError: 'Include at least one file.',
        })
        return null
      }

      this.update({
        ...state,
        commitLoading: true,
        commitError: null,
        hookFailure: null,
      })
      this.commitTerminalOutput.clear()
      const sha = await this.dependencies.createCommit(
        state.repositoryPath,
        trimmedMessage,
        files,
        undefined,
        interceptHooks
          ? {
              interceptHooks: true,
              onHookFailure: (hook, terminalOutput) =>
                new Promise<HookFailureResolution>(resolve => {
                  this.hookFailureResolver = resolve
                  this.update({
                    ...this.currentState,
                    hookFailure: { hook, terminalOutput },
                  })
                }),
            }
          : undefined,
        chunk => this.commitTerminalOutput.push(chunk)
      )
      await this.load(state.repositoryPath)
      return sha
    } catch (error) {
      this.update({
        ...this.currentState,
        commitLoading: false,
        commitError: String(error),
      })
      return null
    } finally {
      this.hookFailureResolver = null
      this.commitTerminalOutput.clear()
    }
  }

  private async loadSelectedDiff(statusRequestID: number): Promise<void> {
    const state = this.currentState
    const selectedFile =
      state.workingDirectory?.findFileWithID(state.selectedFileID ?? '') ?? null
    if (
      state.repositoryPath === null ||
      selectedFile === null ||
      statusRequestID !== this.requestID
    ) {
      return
    }

    const diffRequestID = ++this.diffRequestID
    this.update({
      ...state,
      diff: null,
      diffLoading: true,
      diffError: null,
    })
    try {
      const diff = await this.dependencies.getWorkingDirectoryDiff(
        state.repositoryPath,
        selectedFile.path,
        selectedFile.status,
        false
      )
      if (
        diffRequestID !== this.diffRequestID ||
        statusRequestID !== this.requestID ||
        this.currentState.selectedFileID !== selectedFile.id
      ) {
        return
      }
      const currentWorkingDirectory = this.currentState.workingDirectory
      const currentFile =
        currentWorkingDirectory?.findFileWithID(selectedFile.id) ?? null
      const workingDirectory =
        currentWorkingDirectory === null || currentFile === null
          ? currentWorkingDirectory
          : WorkingDirectoryStatus.fromFiles(
              currentWorkingDirectory.files.map(file =>
                file.id === currentFile.id
                  ? file.withSelection(
                      file.selection.withSelectableLines(
                        selectableLineIndices(diff)
                      )
                    )
                  : file
              )
            )
      this.update({
        ...this.currentState,
        workingDirectory,
        diff,
        diffLoading: false,
        diffError: null,
      })
    } catch (error) {
      if (
        diffRequestID !== this.diffRequestID ||
        statusRequestID !== this.requestID ||
        this.currentState.selectedFileID !== selectedFile.id
      ) {
        return
      }
      this.update({
        ...this.currentState,
        diff: null,
        diffLoading: false,
        diffError: String(error),
      })
    }
  }

  private update(state: WorkingTreeState): void {
    this.currentState = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
