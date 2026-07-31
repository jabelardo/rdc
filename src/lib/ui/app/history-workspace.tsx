import { DiffLineType, DiffType } from '../../../models/diff'
import { formatRelative } from '../../format-relative'
import type { HistoryState, HistoryStore } from '../../stores/history-store'
import { handleListNavigation } from '../list-navigation'
import { FileStatusIcon } from '../mvp-list-rows'

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
      <div className="history-list-pane min-h-0 min-w-0 overflow-auto border-r border-[var(--color-border)]">
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
                  <strong>{commit.summary}</strong>
                  <small>
                    {commit.author.name}
                    <span aria-hidden="true"> · </span>
                    <time
                      dateTime={commit.author.date.toISOString()}
                      title={commit.author.date.toLocaleString()}
                    >
                      {formatRelative(commit.author.date.getTime() - Date.now())}
                    </time>
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section
        className="history-details min-h-0 min-w-0 overflow-hidden bg-[var(--color-canvas)]"
        aria-label="Selected commit details"
      >
        {selectedCommit === null ? (
          <p className="history-details-empty">
            Select a commit to inspect its files and diff.
          </p>
        ) : (
          <>
            <header className="history-details-header">
              <h4>{selectedCommit.summary}</h4>
            </header>
            {selectedCommit.bodyNoCoAuthors.trim().length > 0 && (
              <pre className="history-commit-body">
                {selectedCommit.bodyNoCoAuthors}
              </pre>
            )}
            <p className="history-commit-meta">
              <span>{selectedCommit.author.name}</span>
              <span aria-hidden="true">·</span>
              <code title={selectedCommit.sha}>{selectedCommit.shortSha}</code>
              {state.changeset !== null && (
                <>
                  <span className="history-lines-added">
                    +{state.changeset.linesAdded}
                  </span>
                  <span className="history-lines-deleted">
                    −{state.changeset.linesDeleted}
                  </span>
                </>
              )}
            </p>
            <div className="history-change-workspace">
              <section
                className="history-file-section"
                aria-label="Changed files"
              >
                {state.detailsLoading ? (
                  <p className="history-details-status">
                    Loading commit details…
                  </p>
                ) : state.detailsError !== null ? (
                  <p className="application-error" role="alert">
                    {state.detailsError}
                  </p>
                ) : state.changeset === null ? (
                  <p className="history-details-status">
                    Commit details are unavailable.
                  </p>
                ) : (
                  <>
                    <p className="history-change-summary">
                      <span className="history-change-count">
                        {state.changeset.files.length}{' '}
                        changed{' '}
                        {state.changeset.files.length === 1 ? 'file' : 'files'}
                      </span>
                    </p>
                    {state.changeset.files.length === 0 ? (
                      <p className="history-details-status">
                        No files in commit.
                      </p>
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
                                state.selectedFileID === file.id
                                  ? 'true'
                                  : undefined
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
                                    const target =
                                      state.changeset?.files[targetIndex]
                                    if (target !== undefined) {
                                      void store.selectFile(target.id)
                                    }
                                  }
                                )
                              }
                            >
                              <span>{file.path}</span>
                              <FileStatusIcon
                                status={file.status}
                                className="history-file-status"
                              />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
              <section className="history-diff" aria-label="Commit file diff">
                <header className="history-diff-header">
                  <strong title={selectedFile?.path}>
                    {selectedFile?.path ?? 'File diff'}
                  </strong>
                </header>
                <div className="history-diff-content">
                  {state.diffLoading ? (
                    <p>Loading diff…</p>
                  ) : state.diffError !== null ? (
                    <p className="application-error" role="alert">
                      {state.diffError}
                    </p>
                  ) : state.diff === null || selectedFile === null ? (
                    <p className="history-details-status">
                      Select a changed file to inspect its diff.
                    </p>
                  ) : state.diff.kind === DiffType.Text ? (
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
                </div>
              </section>
            </div>
          </>
        )}
      </section>
    </section>
  )
}
