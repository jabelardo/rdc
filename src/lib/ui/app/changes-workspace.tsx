import { DiffLineType, DiffType } from '../../../models/diff'
import type { ConflictStore } from '../../stores/conflict-store'
import type {
  WorkingTreeState,
  WorkingTreeStore,
} from '../../stores/working-tree-store'
import { WorkingTreeFileRow } from '../mvp-list-rows'
import { VirtualList } from '../virtual-list'

function diffLineClassName(type: DiffLineType): string {
  switch (type) {
    case DiffLineType.Add:
      return 'diff-line-add'
    case DiffLineType.Delete:
      return 'diff-line-delete'
    case DiffLineType.Hunk:
      return 'diff-line-hunk'
    case DiffLineType.Context:
      return 'diff-line-context'
  }
}

type ChangesWorkspaceProps = {
  readonly visible: boolean
  readonly repositoryPath: string
  readonly state: WorkingTreeState
  readonly store: WorkingTreeStore
  readonly conflictStore: ConflictStore
  readonly commitMessage: string
  readonly useShellHookEnvironment: boolean
  readonly commitTerminalOutput: string
  readonly onCommitMessageChange: (message: string) => void
  readonly onUseShellHookEnvironmentChange: (enabled: boolean) => void
  readonly onDiscard: (fileID: string, selection: boolean) => void
}

/** Changed-file list, selectable diff, and commit form for the active repository. */
export function ChangesWorkspace({
  visible,
  repositoryPath,
  state,
  store,
  conflictStore,
  commitMessage,
  useShellHookEnvironment,
  commitTerminalOutput,
  onCommitMessageChange,
  onUseShellHookEnvironmentChange,
  onDiscard,
}: ChangesWorkspaceProps) {
  const selectedFile =
    state.workingDirectory?.files.find(
      file => file.id === state.selectedFileID
    ) ?? null
  const hasSelectedDiffLines =
    state.diff?.kind === DiffType.Text &&
    selectedFile !== null &&
    state.diff.hunks.some(hunk =>
      hunk.lines.some(
        (line, index) =>
          line.isIncludeableLine() &&
          selectedFile.selection.isSelected(hunk.unifiedDiffStart + index)
      )
    )

  return (
    <div
      className="changes-workspace grid min-h-0 min-w-0 overflow-hidden bg-[var(--color-surface)]"
      hidden={!visible}
    >
      <section
        className="working-tree min-h-0 min-w-0 overflow-hidden border-r border-[var(--color-border)] p-4 text-left"
        aria-label="Changes"
        aria-busy={state.loading || state.commitLoading}
      >
        <header className="flex items-center justify-between gap-4">
          <h3>Changes</h3>
          <button
            type="button"
            disabled={state.loading}
            onClick={() => {
              void Promise.all([
                store.load(repositoryPath),
                conflictStore.load(repositoryPath),
              ])
            }}
          >
            Refresh changes
          </button>
        </header>
        {state.loading ? (
          <p>Loading changes…</p>
        ) : state.error !== null ? (
          <p className="application-error" role="alert">
            {state.error}
          </p>
        ) : state.workingDirectory === null ||
          state.workingDirectory.files.length === 0 ? (
          <p>No local changes.</p>
        ) : (
          <VirtualList
            items={state.workingDirectory.files}
            className="working-tree-files"
            ariaLabel="Changed files"
            estimateSize={() => 42}
            gap={5}
            getItemKey={file => file.id}
          >
            {(file, index, row) => (
              <WorkingTreeFileRow
                file={file}
                files={state.workingDirectory?.files ?? []}
                index={index}
                row={row}
                selectedFileID={state.selectedFileID}
                onDiscard={fileID => onDiscard(fileID, false)}
                onSelect={fileID => void store.selectFile(fileID)}
                onSetIncluded={(fileID, included) =>
                  store.setFileIncluded(fileID, included)
                }
              />
            )}
          </VirtualList>
        )}
      </section>

      <section
        className="working-tree-diff min-h-0 min-w-0 overflow-auto bg-[var(--color-canvas)] p-4 text-left"
        aria-label="File diff"
      >
        {state.diffLoading ? (
          <p>Loading diff…</p>
        ) : state.diffError !== null ? (
          <p className="application-error" role="alert">
            {state.diffError}
          </p>
        ) : state.diff === null ? null : state.diff.kind === DiffType.Text ? (
          <>
            <div
              className="working-tree-diff-lines"
              role="table"
              aria-label="Selectable diff lines"
            >
              {state.diff.hunks.flatMap((hunk, hunkIndex) =>
                hunk.lines.map((line, lineIndex) => {
                  const absoluteIndex = hunk.unifiedDiffStart + lineIndex
                  const includeable = line.isIncludeableLine()
                  return (
                    <div
                      className={`working-tree-diff-line ${diffLineClassName(
                        line.type
                      )}`}
                      role="row"
                      key={`${hunkIndex}-${absoluteIndex}`}
                      data-diff-line-index={absoluteIndex}
                    >
                      {includeable && selectedFile !== null ? (
                        <input
                          type="checkbox"
                          aria-label={`Include diff line ${absoluteIndex}: ${line.content}`}
                          checked={selectedFile.selection.isSelected(
                            absoluteIndex
                          )}
                          disabled={state.commitLoading}
                          onChange={event =>
                            store.setLineIncluded(
                              absoluteIndex,
                              event.currentTarget.checked
                            )
                          }
                        />
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      <span className="diff-line-number">
                        {line.oldLineNumber ?? ''}
                      </span>
                      <span className="diff-line-number">
                        {line.newLineNumber ?? ''}
                      </span>
                      <code>{line.text}</code>
                    </div>
                  )
                })
              )}
            </div>
            <button
              type="button"
              className="discard-selected-lines"
              disabled={!hasSelectedDiffLines}
              onClick={() => {
                if (selectedFile !== null) {
                  onDiscard(selectedFile.id, true)
                }
              }}
            >
              Discard selected lines
            </button>
          </>
        ) : state.diff.kind === DiffType.LargeText ? (
          <pre>{state.diff.text}</pre>
        ) : state.diff.kind === DiffType.Binary ? (
          <p>Binary file cannot be displayed.</p>
        ) : state.diff.kind === DiffType.Image ? (
          <p>Image preview is not available yet.</p>
        ) : state.diff.kind === DiffType.Submodule ? (
          <p>Submodule change.</p>
        ) : (
          <p>Diff cannot be displayed.</p>
        )}
      </section>

      {visible &&
        state.workingDirectory !== null &&
        state.workingDirectory.files.length > 0 && (
          <form
            className="commit-form grid min-w-0 gap-2 border-t border-r border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4 text-left"
            aria-label="Commit changes"
            onSubmit={event => {
              event.preventDefault()
              void store
                .commit(commitMessage, useShellHookEnvironment)
                .then(sha => {
                  if (sha !== null) {
                    onCommitMessageChange('')
                  }
                })
            }}
          >
            <label htmlFor="commit-message">Commit message</label>
            <input
              id="commit-message"
              value={commitMessage}
              onChange={event =>
                onCommitMessageChange(event.currentTarget.value)
              }
            />
            <label className="commit-option">
              <input
                type="checkbox"
                checked={useShellHookEnvironment}
                disabled={state.commitLoading}
                onChange={event =>
                  onUseShellHookEnvironmentChange(event.currentTarget.checked)
                }
              />
              Run hooks with the shell environment
            </label>
            <button type="submit" disabled={state.commitLoading}>
              {state.commitLoading ? 'Committing…' : 'Commit included files'}
            </button>
            {state.commitError !== null && (
              <p className="application-error" role="alert">
                {state.commitError}
              </p>
            )}
            {commitTerminalOutput.length > 0 && (
              <pre
                className="commit-terminal-output"
                aria-label="Commit terminal output"
              >
                {commitTerminalOutput}
              </pre>
            )}
          </form>
        )}
    </div>
  )
}
