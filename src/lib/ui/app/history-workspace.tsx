import { DiffLineType, DiffType } from '../../../models/diff'
import { mapStatus } from '../../status'
import type { HistoryState, HistoryStore } from '../../stores/history-store'
import { handleListNavigation } from '../list-navigation'

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

type HistoryWorkspaceProps = {
  readonly visible: boolean
  readonly state: HistoryState
  readonly store: HistoryStore
}

/** Commit list, details, changed files, and the selected historical diff. */
export function HistoryWorkspace({
  visible,
  state,
  store,
}: HistoryWorkspaceProps) {
  const selectedCommit =
    state.commits.find(commit => commit.sha === state.selectedCommitSHA) ?? null
  const selectedFile =
    state.changeset?.files.find(file => file.id === state.selectedFileID) ??
    null

  return (
    <section
      className="history grid min-h-0 min-w-0 overflow-hidden bg-[var(--color-surface)] text-left"
      aria-label="History"
      aria-busy={state.loading || state.detailsLoading || state.diffLoading}
      hidden={!visible}
    >
      <div className="history-list-pane min-h-0 min-w-0 overflow-auto border-r border-[var(--color-border)] p-4">
        <h3>History</h3>
        {state.loading ? (
          <p>Loading history…</p>
        ) : state.error !== null ? (
          <p className="application-error" role="alert">
            {state.error}
          </p>
        ) : state.commits.length === 0 ? (
          <p>No commits yet.</p>
        ) : (
          <ul
            className="history-commits"
            aria-label="Commits"
            data-keyboard-list
          >
            {state.commits.map((commit, index) => (
              <li key={commit.sha}>
                <button
                  type="button"
                  data-commit-sha={commit.sha}
                  data-keyboard-list-item
                  aria-current={
                    state.selectedCommitSHA === commit.sha ? 'true' : undefined
                  }
                  tabIndex={
                    state.selectedCommitSHA === commit.sha ||
                    (state.selectedCommitSHA === null && index === 0)
                      ? 0
                      : -1
                  }
                  onClick={() => void store.selectCommit(commit.sha)}
                  onKeyDown={event =>
                    handleListNavigation(
                      event,
                      index,
                      state.commits.length,
                      targetIndex => {
                        void store.selectCommit(state.commits[targetIndex].sha)
                      }
                    )
                  }
                >
                  <code>{commit.shortSha}</code>
                  <strong>{commit.summary}</strong>
                  <small>{commit.author.name}</small>
                  <time dateTime={commit.author.date.toISOString()}>
                    {commit.author.date.toLocaleDateString()}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedCommit !== null && (
        <section
          className="history-details min-h-0 min-w-0 overflow-auto bg-[var(--color-canvas)] p-5"
          aria-label="Selected commit details"
        >
          <header>
            <div>
              <h4>{selectedCommit.summary}</h4>
              <code>{selectedCommit.sha}</code>
            </div>
            <p>
              {selectedCommit.author.name} &lt;{selectedCommit.author.email}&gt;
            </p>
          </header>
          {selectedCommit.bodyNoCoAuthors.trim().length > 0 && (
            <pre className="history-commit-body">
              {selectedCommit.bodyNoCoAuthors}
            </pre>
          )}
          {state.detailsLoading ? (
            <p>Loading commit details…</p>
          ) : state.detailsError !== null ? (
            <p className="application-error" role="alert">
              {state.detailsError}
            </p>
          ) : state.changeset === null ? null : (
            <>
              <p className="history-change-summary">
                {state.changeset.files.length}{' '}
                {state.changeset.files.length === 1
                  ? 'changed file'
                  : 'changed files'}
                <span>+{state.changeset.linesAdded}</span>
                <span>−{state.changeset.linesDeleted}</span>
              </p>
              {state.changeset.files.length === 0 ? (
                <p>No files in commit.</p>
              ) : (
                <ul
                  className="history-files"
                  aria-label="Commit files"
                  data-keyboard-list
                >
                  {state.changeset.files.map((file, index) => (
                    <li key={file.id}>
                      <button
                        type="button"
                        aria-label={file.path}
                        data-keyboard-list-item
                        aria-current={
                          state.selectedFileID === file.id ? 'true' : undefined
                        }
                        tabIndex={
                          state.selectedFileID === file.id ||
                          (state.selectedFileID === null && index === 0)
                            ? 0
                            : -1
                        }
                        onClick={() => void store.selectFile(file.id)}
                        onKeyDown={event =>
                          handleListNavigation(
                            event,
                            index,
                            state.changeset?.files.length ?? 0,
                            targetIndex => {
                              const target = state.changeset?.files[targetIndex]
                              if (target !== undefined) {
                                void store.selectFile(target.id)
                              }
                            }
                          )
                        }
                      >
                        <span>{file.path}</span>
                        <small>{mapStatus(file.status)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <section className="history-diff" aria-label="Commit file diff">
            {state.diffLoading ? (
              <p>Loading diff…</p>
            ) : state.diffError !== null ? (
              <p className="application-error" role="alert">
                {state.diffError}
              </p>
            ) : state.diff === null || selectedFile === null ? null : state.diff
                .kind === DiffType.Text ? (
              <div
                className="working-tree-diff-lines"
                role="table"
                aria-label={`Diff for ${selectedFile.path}`}
              >
                {state.diff.hunks.flatMap((hunk, hunkIndex) =>
                  hunk.lines.map((line, lineIndex) => (
                    <div
                      className={`working-tree-diff-line ${diffLineClassName(
                        line.type
                      )}`}
                      role="row"
                      key={`${hunkIndex}-${hunk.unifiedDiffStart + lineIndex}`}
                    >
                      <span aria-hidden="true" />
                      <span className="diff-line-number">
                        {line.oldLineNumber ?? ''}
                      </span>
                      <span className="diff-line-number">
                        {line.newLineNumber ?? ''}
                      </span>
                      <code>{line.text}</code>
                    </div>
                  ))
                )}
              </div>
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
        </section>
      )}
    </section>
  )
}
