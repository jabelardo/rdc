import { RefreshCw, Search, Settings, Trash2 } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import { DiffLineType, DiffType } from "@/models/diff";
import type { ConflictStore } from "@/lib/stores/conflict-store";
import type { WorkingTreeState, WorkingTreeStore } from "@/lib/stores/working-tree-store";
import { HorizontalResizer } from "@/components/horizontal-resizer";
import { WorkingTreeFileRow } from "@/components/mvp-list-rows";
import { Tooltip } from "@/components/tooltip";
import { VirtualList } from "@/components/virtual-list";

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

type ChangesWorkspaceProps = {
  readonly visible: boolean;
  readonly repositoryPath: string;
  readonly state: WorkingTreeState;
  readonly store: WorkingTreeStore;
  readonly conflictStore: ConflictStore;
  readonly commitMessage: string;
  readonly bypassHooks: boolean;
  readonly onCommitMessageChange: (message: string) => void;
  readonly onBypassHooksChange: (enabled: boolean) => void;
  readonly onDiscard: (fileID: string, selection: boolean) => void;
};

function splitCommitMessage(message: string): {
  readonly summary: string;
  readonly description: string;
} {
  const newline = message.indexOf("\n");
  if (newline === -1) {
    return { summary: message, description: "" };
  }
  return {
    summary: message.slice(0, newline),
    description: message.slice(newline + 1).replace(/^\n/, ""),
  };
}

function joinCommitMessage(summary: string, description: string): string {
  return description.length === 0 ? summary : `${summary}\n\n${description}`;
}

/** Changed-file list, selectable diff, and commit form for the active repository. */
export function ChangesWorkspace({
  visible,
  repositoryPath,
  state,
  store,
  conflictStore,
  commitMessage,
  bypassHooks,
  onCommitMessageChange,
  onBypassHooksChange,
  onDiscard,
}: ChangesWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [changesPaneWidth, setChangesPaneWidth] = useState(352);
  const files = state.workingDirectory?.files ?? [];
  const normalizedFilter = fileFilter.trim().toLocaleLowerCase();
  const filteredFiles =
    normalizedFilter.length === 0
      ? files
      : files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedFilter));
  const selectedFile = files.find((file) => file.id === state.selectedFileID) ?? null;
  const hasSelectedDiffLines =
    state.diff?.kind === DiffType.Text &&
    selectedFile !== null &&
    state.diff.hunks.some((hunk) =>
      hunk.lines.some(
        (line, index) =>
          line.isIncludeableLine() &&
          selectedFile.selection.isSelected(hunk.unifiedDiffStart + index),
      ),
    );
  const changedFileCount = files.length;
  const includedFileCount = files.filter((file) => file.isIncludedInCommit()).length;
  const allFilesIncluded = changedFileCount > 0 && includedFileCount === changedFileCount;
  const { summary, description } = splitCommitMessage(commitMessage);

  return (
    <div
      ref={workspaceRef}
      className="changes-workspace grid min-h-0 min-w-0 overflow-hidden bg-[var(--card)]"
      hidden={!visible}
      style={
        {
          "--changes-pane-width": `${changesPaneWidth}px`,
        } as CSSProperties
      }
    >
      <HorizontalResizer
        ariaLabel="Resize Changes file pane"
        className="changes-resizer"
        containerRef={workspaceRef}
        minimum={190}
        oppositeMinimum={300}
        value={changesPaneWidth}
        onResize={setChangesPaneWidth}
      />
      <section
        className="working-tree min-h-0 min-w-0 overflow-hidden border-r border-[var(--border)] text-left"
        aria-label="Changes"
        aria-busy={state.loading || state.commitLoading}
      >
        <header className="working-tree-header">
          <div className="working-tree-tools">
            <label className="working-tree-filter">
              <Search aria-hidden="true" />
              <span className="sr-only">Filter changed files</span>
              <input
                type="search"
                value={fileFilter}
                placeholder="Filter changed files"
                onChange={(event) => setFileFilter(event.currentTarget.value)}
              />
            </label>
            <Tooltip label="Refresh changed files">
              <button
                type="button"
                className="working-tree-refresh"
                aria-label="Refresh changes"
                disabled={state.loading}
                onClick={() => {
                  void Promise.all([
                    store.load(repositoryPath),
                    conflictStore.load(repositoryPath),
                  ]);
                }}
              >
                <RefreshCw aria-hidden="true" />
                <span className="sr-only">Refresh changes</span>
              </button>
            </Tooltip>
          </div>
          <label className="working-tree-summary">
            <input
              type="checkbox"
              aria-label="Include all changed files"
              checked={allFilesIncluded}
              disabled={changedFileCount === 0 || state.commitLoading}
              ref={(element) => {
                if (element !== null) {
                  element.indeterminate = includedFileCount > 0 && !allFilesIncluded;
                }
              }}
              onChange={(event) => store.setAllFilesIncluded(event.currentTarget.checked)}
            />
            <span>
              {changedFileCount} {changedFileCount === 1 ? "changed file" : "changed files"}
            </span>
          </label>
        </header>
        {state.loading ? (
          <p>Loading changes…</p>
        ) : state.loadFailed ? (
          // The failure itself is a message, announced once; this only stops the pane claiming
          // there are no local changes over a working directory it could not read.
          <p>Changed files are unavailable.</p>
        ) : state.workingDirectory === null || state.workingDirectory.files.length === 0 ? (
          <p>No local changes.</p>
        ) : filteredFiles.length === 0 ? (
          <p className="working-tree-filter-empty">No changed files match this filter.</p>
        ) : (
          <VirtualList
            items={filteredFiles}
            className="working-tree-files"
            ariaLabel="Changed files"
            estimateSize={() => 42}
            gap={5}
            getItemKey={(file) => file.id}
          >
            {(file, index, row) => (
              <WorkingTreeFileRow
                file={file}
                files={filteredFiles}
                index={index}
                row={row}
                selectedFileID={state.selectedFileID}
                onDiscard={(fileID) => onDiscard(fileID, false)}
                onSelect={(fileID) => void store.selectFile(fileID)}
                onSetIncluded={(fileID, included) => store.setFileIncluded(fileID, included)}
              />
            )}
          </VirtualList>
        )}
      </section>

      <section
        className="working-tree-diff min-h-0 min-w-0 overflow-hidden bg-[var(--background)] text-left"
        aria-label="File diff"
      >
        <header className="working-tree-diff-header">
          <Tooltip label={selectedFile?.path ?? "File diff"}>
            <strong>{selectedFile?.path ?? "File diff"}</strong>
          </Tooltip>
          {state.diff?.kind === DiffType.Text && (
            <Tooltip label="Discard selected diff lines">
              <button
                type="button"
                className="discard-selected-lines"
                aria-label="Discard selected lines"
                disabled={!hasSelectedDiffLines}
                onClick={() => {
                  if (selectedFile !== null) {
                    onDiscard(selectedFile.id, true);
                  }
                }}
              >
                <Trash2 aria-hidden="true" />
                <span className="sr-only">Discard selected lines</span>
              </button>
            </Tooltip>
          )}
        </header>
        <div className="working-tree-diff-content">
          {state.diffLoading ? (
            <p>Loading diff…</p>
          ) : state.diffFailed ? (
            <p className="working-tree-diff-empty">This file&apos;s diff is unavailable.</p>
          ) : state.diff === null ? (
            <p className="working-tree-diff-empty">Select a changed file to inspect its diff.</p>
          ) : state.diff.kind === DiffType.Text ? (
            <div
              className="working-tree-diff-lines"
              role="table"
              aria-label="Selectable diff lines"
            >
              {state.diff.hunks.flatMap((hunk, hunkIndex) =>
                hunk.lines.map((line, lineIndex) => {
                  const absoluteIndex = hunk.unifiedDiffStart + lineIndex;
                  const includeable = line.isIncludeableLine();
                  return (
                    <div
                      className={`working-tree-diff-line ${diffLineClassName(line.type)}`}
                      role="row"
                      key={`${hunkIndex}-${absoluteIndex}`}
                      data-diff-line-index={absoluteIndex}
                    >
                      {includeable && selectedFile !== null ? (
                        <input
                          type="checkbox"
                          aria-label={`Include diff line ${absoluteIndex}: ${line.content}`}
                          checked={selectedFile.selection.isSelected(absoluteIndex)}
                          disabled={state.commitLoading}
                          onChange={(event) =>
                            store.setLineIncluded(absoluteIndex, event.currentTarget.checked)
                          }
                        />
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      <span className="diff-line-number">{line.oldLineNumber ?? ""}</span>
                      <span className="diff-line-number">{line.newLineNumber ?? ""}</span>
                      <code>{line.text}</code>
                    </div>
                  );
                }),
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

      {visible && state.workingDirectory !== null && state.workingDirectory.files.length > 0 && (
        <form
          className="commit-form grid min-h-0 min-w-0 border-t border-r border-[var(--border)] bg-[var(--secondary)] text-left"
          aria-label="Commit changes"
          onSubmit={(event) => {
            event.preventDefault();
            void store.commit(commitMessage, bypassHooks).then((sha) => {
              if (sha !== null) {
                onCommitMessageChange("");
              }
            });
          }}
        >
          <label className="sr-only" htmlFor="commit-message">
            Commit summary
          </label>
          <input
            id="commit-message"
            placeholder="Summary (required)"
            value={summary}
            onChange={(event) =>
              onCommitMessageChange(joinCommitMessage(event.currentTarget.value, description))
            }
          />
          <label className="sr-only" htmlFor="commit-description">
            Commit description
          </label>
          <textarea
            id="commit-description"
            placeholder="Description"
            rows={3}
            value={description}
            onChange={(event) =>
              onCommitMessageChange(joinCommitMessage(summary, event.currentTarget.value))
            }
          />
          <div className="commit-form-footer">
            <div className="commit-form-options">
              <details>
                <Tooltip label="Commit options">
                  <summary aria-label="Commit options">
                    <Settings aria-hidden="true" />
                    <span className="sr-only">Commit options</span>
                  </summary>
                </Tooltip>
                <div className="commit-options-panel">
                  <label className="commit-option">
                    <input
                      type="checkbox"
                      checked={bypassHooks}
                      disabled={state.commitLoading}
                      onChange={(event) => onBypassHooksChange(event.currentTarget.checked)}
                    />
                    Bypass hooks
                  </label>
                </div>
              </details>
            </div>
            <button type="submit" disabled={state.commitLoading}>
              {state.commitLoading
                ? "Committing…"
                : `Commit ${includedFileCount} ${includedFileCount === 1 ? "file" : "files"}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
