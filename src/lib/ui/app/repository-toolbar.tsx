import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowUpRightFromSquare,
  faArrowsRotate,
  faCloudArrowDown,
  faCloudArrowUp,
  faCode,
  faClockRotateLeft,
  faFolderOpen,
  faListCheck,
  faTerminal,
} from '@fortawesome/free-solid-svg-icons'
import type { Repository } from '../../../models/repository'
import type { RemoteState } from '../../stores/remote-store'

type RepositoryToolbarProps = {
  readonly repository: Repository
  readonly remoteState: RemoteState
  readonly hasEditor: boolean
  readonly hasShell: boolean
  readonly repositoryView: 'changes' | 'history'
  readonly onShowFiles: () => void
  readonly onOpenEditor: () => void
  readonly onOpenShell: () => void
  readonly onOpenNewWindow: () => void
  readonly onFetch: () => void
  readonly onPull: () => void
  readonly onPush: () => void
  readonly onSelectView: (view: 'changes' | 'history') => void
}

/** Current-repository identity, local shortcuts, and remote synchronization actions. */
export function RepositoryToolbar({
  repository,
  remoteState,
  hasEditor,
  hasShell,
  repositoryView,
  onShowFiles,
  onOpenEditor,
  onOpenShell,
  onOpenNewWindow,
  onFetch,
  onPull,
  onPush,
  onSelectView,
}: RepositoryToolbarProps) {
  const remoteName = remoteState.currentRemote?.name ?? 'the remote'
  const branchName = remoteState.currentBranch?.name ?? 'the current branch'
  const progress =
    remoteState.progress === null
      ? null
      : `${remoteState.progress.title ?? 'Fetching'}${
          remoteState.progress.description
            ? ` — ${remoteState.progress.description}`
            : ''
        } (${Math.round(remoteState.progress.value * 100)}%)`
  const status = remoteState.operationError ?? remoteState.error ?? progress
  const statusIsError =
    remoteState.operationError !== null || remoteState.error !== null

  return (
    <header
      className="repository-toolbar flex min-w-0 items-center border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3"
      role="toolbar"
      aria-label="Repository actions"
    >
      <div
        className="repository-toolbar-actions flex items-center gap-1.5"
        role="group"
        aria-label="Repository tools"
      >
        <button
          type="button"
          aria-label="Show files"
          title={`Show ${repository.name} in the file manager`}
          onClick={onShowFiles}
        >
          <FontAwesomeIcon icon={faFolderOpen} aria-hidden="true" />
          <span className="sr-only">Show files</span>
        </button>
        <button
          type="button"
          aria-label="Open in editor"
          title={`Open ${repository.name} in the configured editor`}
          disabled={!hasEditor}
          onClick={onOpenEditor}
        >
          <FontAwesomeIcon icon={faCode} aria-hidden="true" />
          <span className="sr-only">Open in editor</span>
        </button>
        <button
          type="button"
          aria-label="Open in terminal"
          title={`Open a terminal at ${repository.name}`}
          disabled={!hasShell}
          onClick={onOpenShell}
        >
          <FontAwesomeIcon icon={faTerminal} aria-hidden="true" />
          <span className="sr-only">Open in terminal</span>
        </button>
        <button
          type="button"
          aria-label="Open in new window"
          title={`Open ${repository.name} in a new window`}
          onClick={onOpenNewWindow}
        >
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} aria-hidden="true" />
          <span className="sr-only">Open in new window</span>
        </button>
      </div>
      <section
        className="remote-controls flex items-center gap-1.5"
        aria-label="Remote synchronization"
        aria-busy={remoteState.loading || remoteState.operation !== null}
      >
        <div className="remote-actions flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Fetch"
            title={`Fetch from ${remoteName}`}
            disabled={
              remoteState.loading ||
              remoteState.currentRemote === null ||
              remoteState.operation !== null
            }
            onClick={onFetch}
          >
            <FontAwesomeIcon
              icon={faArrowsRotate}
              spin={remoteState.operation === 'fetch'}
              aria-hidden="true"
            />
            <span className="sr-only">
              {remoteState.operation === 'fetch' ? 'Fetching…' : 'Fetch'}
            </span>
          </button>
          <button
            type="button"
            aria-label="Pull"
            title={`Pull ${remoteName} into ${branchName}`}
            disabled={
              remoteState.loading ||
              remoteState.currentRemote === null ||
              remoteState.currentBranch === null ||
              remoteState.currentBranch.upstream === null ||
              remoteState.operation !== null
            }
            onClick={onPull}
          >
            <FontAwesomeIcon
              icon={faCloudArrowDown}
              bounce={remoteState.operation === 'pull'}
              aria-hidden="true"
            />
            <span className="sr-only">
              {remoteState.operation === 'pull' ? 'Pulling…' : 'Pull'}
            </span>
          </button>
          <button
            type="button"
            aria-label="Push"
            title={`Push ${branchName} to ${remoteName}`}
            disabled={
              remoteState.loading ||
              remoteState.currentRemote === null ||
              remoteState.currentBranch === null ||
              remoteState.operation !== null
            }
            onClick={onPush}
          >
            <FontAwesomeIcon
              icon={faCloudArrowUp}
              bounce={remoteState.operation === 'push'}
              aria-hidden="true"
            />
            <span className="sr-only">
              {remoteState.operation === 'push' ? 'Pushing…' : 'Push'}
            </span>
          </button>
        </div>
      </section>
      <nav
        className="repository-view-navigation flex items-center gap-1.5"
        aria-label="Repository views"
      >
        <button
          type="button"
          aria-current={repositoryView === 'changes' ? 'page' : undefined}
          aria-label="Changes"
          title="Show changes"
          onClick={() => onSelectView('changes')}
        >
          <FontAwesomeIcon icon={faListCheck} aria-hidden="true" />
          <span className="repository-view-label">Changes</span>
        </button>
        <button
          type="button"
          aria-current={repositoryView === 'history' ? 'page' : undefined}
          aria-label="History"
          title="Show history"
          onClick={() => onSelectView('history')}
        >
          <FontAwesomeIcon icon={faClockRotateLeft} aria-hidden="true" />
          <span className="repository-view-label">History</span>
        </button>
      </nav>
      <p
        className={`repository-toolbar-status${statusIsError ? ' is-error' : ''}`}
        role={statusIsError ? 'alert' : 'status'}
        title={status ?? undefined}
      >
        {status}
      </p>
    </header>
  )
}
