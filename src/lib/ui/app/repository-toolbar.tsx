import {
  ArrowDownToLine,
  CloudDownload,
  CloudUpload,
  Code,
  Copy,
  FolderOpen,
  FolderPlus,
  History,
  ListChecks,
  Plus,
  Terminal,
} from "lucide-react";
import type { RemoteState } from "../../stores/remote-store";
import type { OperationProgressViewModel } from "../../operation-presentation";
import { OperationProgressBody } from "../dialogs/operation-progress-dialog";
import { Tooltip } from "../tooltip";

type RepositoryToolbarProps = {
  readonly remoteState: RemoteState;
  readonly canFetch: boolean;
  readonly canPush: boolean;
  readonly canPull: boolean;
  /** A repository-scoped operation is active in this window or a peer window. */
  readonly operationLockActive?: boolean;
  /** Summary shown when this window is observing a peer operation. */
  readonly operationPeerMessage?: string;
  /** Native Fetch progress rendered in the non-modal toolbar surface. */
  readonly operationViewModel?: OperationProgressViewModel;
  /** Prevents switching to stale history while a history-moving operation owns the repository. */
  readonly historyOperationActive?: boolean;
  readonly hasEditor: boolean;
  readonly hasShell: boolean;
  readonly repositoryView: "changes" | "history";
  readonly onCreateRepository: () => void;
  readonly onAddExistingRepository: () => void;
  readonly onCloneRepository: () => void;
  readonly onShowFiles: () => void;
  readonly onOpenEditor: () => void;
  readonly onOpenShell: () => void;
  readonly onFetch: () => void;
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onSelectView: (view: "changes" | "history") => void;
};

/** Current-repository identity, local shortcuts, and remote synchronization actions. */
export function RepositoryToolbar({
  remoteState,
  canFetch,
  canPush,
  canPull,
  operationLockActive = false,
  operationPeerMessage,
  operationViewModel,
  historyOperationActive = false,
  hasEditor,
  hasShell,
  repositoryView,
  onCreateRepository,
  onAddExistingRepository,
  onCloneRepository,
  onShowFiles,
  onOpenEditor,
  onOpenShell,
  onFetch,
  onPull,
  onPush,
  onSelectView,
}: RepositoryToolbarProps) {
  const progress =
    remoteState.progress === null
      ? null
      : `${remoteState.progress.title ?? "Fetching"}${
          remoteState.progress.description ? ` — ${remoteState.progress.description}` : ""
        } (${Math.round(remoteState.progress.value * 100)}%)`;
  const nativeRemoteOperation =
    operationViewModel?.operation === "fetch" ||
    operationViewModel?.operation === "push" ||
    operationViewModel?.operation === "pull";
  const displayedRemoteOperation = nativeRemoteOperation
    ? operationViewModel.operation
    : remoteState.operation;
  const status =
    remoteState.operationError ??
    remoteState.error ??
    (nativeRemoteOperation ? null : progress);
  const statusIsError = remoteState.operationError !== null || remoteState.error !== null;
  const statusElement = (
    <p
      className={`repository-toolbar-status${statusIsError ? " is-error" : ""}`}
      role={statusIsError ? "alert" : "status"}
    >
      {status}
    </p>
  );

  return (
    <header
      data-tooltip-boundary=""
      className="repository-toolbar flex min-w-0 items-center border-b border-[var(--border)] bg-[var(--secondary)] px-3"
      role="toolbar"
      aria-label="Repository actions"
    >
      <div className="repository-local-actions flex items-center">
        <div
          className="repository-creation-actions flex items-center gap-1.5"
          role="group"
          aria-label="Repository creation"
        >
          <Tooltip label="New repository">
            <button type="button" aria-label="New repository" onClick={onCreateRepository}>
              <Plus aria-hidden="true" />
              <span className="sr-only">New repository</span>
            </button>
          </Tooltip>
          <Tooltip label="Add local repository">
            <button
              type="button"
              aria-label="Add local repository"
              onClick={onAddExistingRepository}
            >
              <FolderPlus aria-hidden="true" />
              <span className="sr-only">Add local repository</span>
            </button>
          </Tooltip>
          <Tooltip label="Clone repository">
            <button type="button" aria-label="Clone repository" onClick={onCloneRepository}>
              <Copy aria-hidden="true" />
              <span className="sr-only">Clone repository</span>
            </button>
          </Tooltip>
        </div>
        <div
          className="repository-toolbar-actions flex items-center gap-1.5"
          role="group"
          aria-label="Repository tools"
        >
          <Tooltip label="Show in file manager">
            <button type="button" aria-label="Show files" onClick={onShowFiles}>
              <FolderOpen aria-hidden="true" />
              <span className="sr-only">Show files</span>
            </button>
          </Tooltip>
          <Tooltip label="Open in configured editor">
            <button
              type="button"
              aria-label="Open in editor"
              disabled={!hasEditor}
              onClick={onOpenEditor}
            >
              <Code aria-hidden="true" />
              <span className="sr-only">Open in editor</span>
            </button>
          </Tooltip>
          <Tooltip label="Open in terminal">
            <button
              type="button"
              aria-label="Open in terminal"
              disabled={!hasShell}
              onClick={onOpenShell}
            >
              <Terminal aria-hidden="true" />
              <span className="sr-only">Open in terminal</span>
            </button>
          </Tooltip>
        </div>
      </div>
      <section
        className="remote-controls flex items-center gap-1.5"
        aria-label="Remote synchronization"
        aria-busy={remoteState.loading || remoteState.operation !== null}
      >
        <div className="remote-actions flex items-center gap-1.5">
          <Tooltip label="Fetch from remote">
            <button
              type="button"
              aria-label="Fetch"
              disabled={!canFetch || operationLockActive}
              onClick={onFetch}
            >
              <ArrowDownToLine
                className={displayedRemoteOperation === "fetch" ? "animate-spin" : undefined}
                aria-hidden="true"
              />
              <span className="sr-only">
                {displayedRemoteOperation === "fetch" ? "Fetching…" : "Fetch"}
              </span>
            </button>
          </Tooltip>
          <Tooltip label="Pull from remote">
            <button
              type="button"
              aria-label="Pull"
              disabled={!canPull || operationLockActive}
              onClick={onPull}
            >
              <CloudDownload
                className={displayedRemoteOperation === "pull" ? "animate-bounce" : undefined}
                aria-hidden="true"
              />
              <span className="sr-only">
                {displayedRemoteOperation === "pull" ? "Pulling…" : "Pull"}
              </span>
            </button>
          </Tooltip>
          <Tooltip label="Push to remote">
            <button
              type="button"
              aria-label="Push"
              disabled={!canPush || operationLockActive}
              onClick={onPush}
            >
              <CloudUpload
                className={displayedRemoteOperation === "push" ? "animate-bounce" : undefined}
                aria-hidden="true"
              />
              <span className="sr-only">
                {displayedRemoteOperation === "push" ? "Pushing…" : "Push"}
              </span>
            </button>
          </Tooltip>
        </div>
        {operationPeerMessage !== undefined && (
          <p className="repository-toolbar-status" role="status">
            {operationPeerMessage}
          </p>
        )}
        {nativeRemoteOperation && operationViewModel !== undefined && (
          <div
            className="repository-toolbar-progress min-w-40 max-w-64"
            aria-label={`${operationViewModel.operation} progress`}
          >
            <OperationProgressBody viewModel={operationViewModel} />
          </div>
        )}
      </section>
      <nav
        className="repository-view-navigation flex items-center gap-1.5"
        aria-label="Repository views"
      >
        <Tooltip label="Show changes">
          <button
            type="button"
            aria-current={repositoryView === "changes" ? "page" : undefined}
            aria-label="Changes"
            onClick={() => onSelectView("changes")}
          >
            <ListChecks aria-hidden="true" />
            <span className="repository-view-label">Changes</span>
          </button>
        </Tooltip>
        <Tooltip label="Show history">
          <button
            type="button"
            aria-current={repositoryView === "history" ? "page" : undefined}
            aria-label="History"
            disabled={historyOperationActive}
            onClick={() => onSelectView("history")}
          >
            <History aria-hidden="true" />
            <span className="repository-view-label">History</span>
          </button>
        </Tooltip>
      </nav>
      {status !== null &&
        (status === progress ? <Tooltip label={status}>{statusElement}</Tooltip> : statusElement)}
    </header>
  );
}
