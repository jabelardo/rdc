import { useRef, useState, type CSSProperties } from "react";
import { DiffLineType, DiffType } from "@/models/diff";
import { formatRelative } from "@/utils/format-relative";
import type { HistoryState, HistoryStore } from "@/features/history/stores/history-store";
import type { Commit } from "@/models/commit";
import { handleListNavigation } from "@/utils/list-navigation";
import { HorizontalResizer } from "@/components/horizontal-resizer";
import { FileStatusIcon } from "@/components/mvp-list-rows";
import { Tooltip } from "@/components/tooltip";
import { isContiguousSelection } from "@/features/history/history-operation-selection";

function diffLineClassName(type: DiffLineType): string {
  switch (type) {
    case DiffLineType.Add:
      return "diff-line-add";
    case DiffLineType.Delete:
      return "diff-line-delete";
    case DiffLineType.Hunk:
      return "diff-line-hunk";
    case DiffLineType.Context:
      return "diff-line-context";
  }
}

type HistoryWorkspaceProps = {
  readonly visible: boolean;
  readonly state: HistoryState;
  readonly store: HistoryStore;
  readonly onCommitContextMenu?: (commit: Commit, x: number, y: number) => void;
  readonly onSquashSelected?: (commits: ReadonlyArray<Commit>) => void;
  readonly onReorderSelected?: (commits: ReadonlyArray<Commit>, before: Commit | null) => void;
};

/** Commit list, details, changed files, and the selected historical diff. */
export function HistoryWorkspace({
  visible,
  state,
  store,
  onCommitContextMenu,
  onSquashSelected,
  onReorderSelected,
}: HistoryWorkspaceProps) {
  const historyRef = useRef<HTMLElement>(null);
  const changeWorkspaceRef = useRef<HTMLDivElement>(null);
  const [commitListWidth, setCommitListWidth] = useState(270);
  const [changedFilesWidth, setChangedFilesWidth] = useState(240);
  const [copyStatus, setCopyStatus] = useState("");
  const [selectedCommitSHAs, setSelectedCommitSHAs] = useState<ReadonlySet<string>>(new Set());
  const [reorderBeforeSHA, setReorderBeforeSHA] = useState("");
  const selectedCommit =
    state.commits.find((commit) => commit.sha === state.selectedCommitSHA) ?? null;
  const selectedFile =
    state.changeset?.files.find((file) => file.id === state.selectedFileID) ?? null;
  const selectedCommits = state.commits.filter((commit) => selectedCommitSHAs.has(commit.sha));

  return (
    <section
      className="history grid min-h-0 min-w-0 overflow-hidden bg-[var(--card)] text-left"
      aria-label="History"
      aria-busy={state.loading || state.detailsLoading || state.diffLoading}
      hidden={!visible}
      ref={historyRef}
      style={
        {
          "--history-list-width": `${commitListWidth}px`,
        } as CSSProperties
      }
    >
      <div className="history-list-pane min-h-0 min-w-0 overflow-auto border-r border-[var(--border)]">
        {state.loading ? (
          <p>Loading history…</p>
        ) : state.loadFailed ? (
          // The failure itself is a message, announced once; this only stops the pane claiming
          // there are no commits over a history it could not read.
          <p>History is unavailable.</p>
        ) : state.commits.length === 0 ? (
          <p>No commits yet.</p>
        ) : (
          <>
            {selectedCommits.length > 0 && (
              <div className="flex gap-2 p-2" role="toolbar" aria-label="History operations">
                {onSquashSelected !== undefined && (
                  <button
                    type="button"
                    disabled={!isContiguousSelection(state.commits, selectedCommits)}
                    onClick={() => onSquashSelected(selectedCommits)}
                  >
                    Squash selected
                  </button>
                )}
                {onReorderSelected !== undefined && (
                  <>
                    <select
                      aria-label="Move selected before"
                      value={reorderBeforeSHA}
                      onChange={(event) => setReorderBeforeSHA(event.target.value)}
                    >
                      <option value="">End of history</option>
                      {state.commits
                        .filter((commit) => !selectedCommitSHAs.has(commit.sha))
                        .map((commit) => (
                          <option key={commit.sha} value={commit.sha}>
                            Before {commit.summary}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        onReorderSelected(
                          selectedCommits,
                          state.commits.find((commit) => commit.sha === reorderBeforeSHA) ?? null,
                        )
                      }
                    >
                      Reorder selected
                    </button>
                  </>
                )}
              </div>
            )}
            <ul className="history-commits" aria-label="Commits" data-keyboard-list>
              {state.commits.map((commit, index) => (
                <li key={commit.sha}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`Select ${commit.summary}`}
                      checked={selectedCommitSHAs.has(commit.sha)}
                      onChange={(event) => {
                        setSelectedCommitSHAs((current) => {
                          const next = new Set(current);
                          if (event.target.checked) {
                            next.add(commit.sha);
                          } else {
                            next.delete(commit.sha);
                          }
                          return next;
                        });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    data-commit-sha={commit.sha}
                    data-keyboard-list-item
                    aria-current={state.selectedCommitSHA === commit.sha ? "true" : undefined}
                    tabIndex={
                      state.selectedCommitSHA === commit.sha ||
                      (state.selectedCommitSHA === null && index === 0)
                        ? 0
                        : -1
                    }
                    onClick={() => void store.selectCommit(commit.sha)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onCommitContextMenu?.(commit, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) =>
                      handleListNavigation(event, index, state.commits.length, (targetIndex) => {
                        void store.selectCommit(state.commits[targetIndex].sha);
                      })
                    }
                  >
                    <strong>{commit.summary}</strong>
                    <small>
                      {commit.author.name}
                      <span aria-hidden="true"> · </span>
                      <Tooltip label={commit.author.date.toLocaleString()}>
                        <time dateTime={commit.author.date.toISOString()}>
                          {formatRelative(commit.author.date.getTime() - Date.now())}
                        </time>
                      </Tooltip>
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <HorizontalResizer
        ariaLabel="Resize History commit list"
        className="history-list-resizer"
        containerRef={historyRef}
        minimum={190}
        oppositeMinimum={370}
        value={commitListWidth}
        onResize={setCommitListWidth}
      />

      <section
        className="history-details min-h-0 min-w-0 overflow-hidden bg-[var(--background)]"
        aria-label="Selected commit details"
      >
        {selectedCommit === null ? (
          <p className="history-details-empty">Select a commit to inspect its files and diff.</p>
        ) : (
          <>
            <header className="history-details-header">
              <h4>{selectedCommit.summary}</h4>
            </header>
            {selectedCommit.bodyNoCoAuthors.trim().length > 0 && (
              <pre className="history-commit-body">{selectedCommit.bodyNoCoAuthors}</pre>
            )}
            <p className="history-commit-meta">
              <span>{selectedCommit.author.name}</span>
              <span aria-hidden="true">·</span>
              <Tooltip label={selectedCommit.sha}>
                <button
                  type="button"
                  className="history-commit-sha"
                  aria-label="Copy full commit hash"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(selectedCommit.sha)
                      .then(() => setCopyStatus("Full commit hash copied."))
                      .catch(() => setCopyStatus("Unable to copy the full commit hash."));
                  }}
                >
                  <code>{selectedCommit.shortSha}</code>
                </button>
              </Tooltip>
              <span className="sr-only" role="status" aria-live="polite">
                {copyStatus}
              </span>
              {state.changeset !== null && (
                <>
                  <span className="history-lines-added">+{state.changeset.linesAdded}</span>
                  <span className="history-lines-deleted">−{state.changeset.linesDeleted}</span>
                </>
              )}
            </p>
            <div
              className="history-change-workspace"
              ref={changeWorkspaceRef}
              style={
                {
                  "--history-files-width": `${changedFilesWidth}px`,
                } as CSSProperties
              }
            >
              <section className="history-file-section" aria-label="Changed files">
                {state.detailsLoading ? (
                  <p className="history-details-status">Loading commit details…</p>
                ) : state.changeset === null ? (
                  <p className="history-details-status">Commit details are unavailable.</p>
                ) : (
                  <>
                    <p className="history-change-summary">
                      <span className="history-change-count">
                        {state.changeset.files.length} changed{" "}
                        {state.changeset.files.length === 1 ? "file" : "files"}
                      </span>
                    </p>
                    {state.changeset.files.length === 0 ? (
                      <p className="history-details-status">No files in commit.</p>
                    ) : (
                      <ul className="history-files" aria-label="Commit files" data-keyboard-list>
                        {state.changeset.files.map((file, index) => (
                          <li key={file.id}>
                            <button
                              type="button"
                              aria-label={file.path}
                              data-keyboard-list-item
                              aria-current={state.selectedFileID === file.id ? "true" : undefined}
                              tabIndex={
                                state.selectedFileID === file.id ||
                                (state.selectedFileID === null && index === 0)
                                  ? 0
                                  : -1
                              }
                              onClick={() => void store.selectFile(file.id)}
                              onKeyDown={(event) =>
                                handleListNavigation(
                                  event,
                                  index,
                                  state.changeset?.files.length ?? 0,
                                  (targetIndex) => {
                                    const target = state.changeset?.files[targetIndex];
                                    if (target !== undefined) {
                                      void store.selectFile(target.id);
                                    }
                                  },
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
              <HorizontalResizer
                ariaLabel="Resize History changed files"
                className="history-files-resizer"
                containerRef={changeWorkspaceRef}
                minimum={150}
                oppositeMinimum={220}
                value={changedFilesWidth}
                onResize={setChangedFilesWidth}
              />
              <section className="history-diff" aria-label="Commit file diff">
                <header className="history-diff-header">
                  <Tooltip label={selectedFile?.path ?? "File diff"}>
                    <strong>{selectedFile?.path ?? "File diff"}</strong>
                  </Tooltip>
                </header>
                <div className="history-diff-content">
                  {state.diffLoading ? (
                    <p>Loading diff…</p>
                  ) : state.diffFailed ? (
                    <p className="history-details-status">This file&apos;s diff is unavailable.</p>
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
                            className={`working-tree-diff-line ${diffLineClassName(line.type)}`}
                            role="row"
                            key={`${hunkIndex}-${hunk.unifiedDiffStart + lineIndex}`}
                          >
                            <span aria-hidden="true" />
                            <span className="diff-line-number">{line.oldLineNumber ?? ""}</span>
                            <span className="diff-line-number">{line.newLineNumber ?? ""}</span>
                            <code>{line.text}</code>
                          </div>
                        )),
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
  );
}
