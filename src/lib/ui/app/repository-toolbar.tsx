import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowsDownToLine,
  faCloudArrowDown,
  faCloudArrowUp,
  faClone,
  faCode,
  faClockRotateLeft,
  faFolderPlus,
  faFolderOpen,
  faListCheck,
  faPlus,
  faTerminal,
} from '@fortawesome/free-solid-svg-icons'
import type { RemoteState } from '../../stores/remote-store'
import { Tooltip } from '../tooltip'

type RepositoryToolbarProps = {
  readonly remoteState: RemoteState
  readonly hasEditor: boolean
  readonly hasShell: boolean
  readonly repositoryView: 'changes' | 'history'
  readonly onCreateRepository: () => void
  readonly onAddExistingRepository: () => void
  readonly onCloneRepository: () => void
  readonly onShowFiles: () => void
  readonly onOpenEditor: () => void
  readonly onOpenShell: () => void
  readonly onFetch: () => void
  readonly onPull: () => void
  readonly onPush: () => void
  readonly onSelectView: (view: 'changes' | 'history') => void
}

/** Current-repository identity, local shortcuts, and remote synchronization actions. */
export function RepositoryToolbar({
  remoteState,
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
      : `${remoteState.progress.title ?? 'Fetching'}${
          remoteState.progress.description
            ? ` — ${remoteState.progress.description}`
            : ''
        } (${Math.round(remoteState.progress.value * 100)}%)`
  const status = remoteState.operationError ?? remoteState.error ?? progress
  const statusIsError =
    remoteState.operationError !== null || remoteState.error !== null
  const statusElement = (
    <p
      className={`repository-toolbar-status${statusIsError ? ' is-error' : ''}`}
      role={statusIsError ? 'alert' : 'status'}
    >
      {status}
    </p>
  )

  return (
    <header
      className="repository-toolbar flex min-w-0 items-center border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3"
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
            <button
              type="button"
              aria-label="New repository"
              onClick={onCreateRepository}
            >
              <FontAwesomeIcon icon={faPlus} aria-hidden="true" />
              <span className="sr-only">New repository</span>
            </button>
          </Tooltip>
          <Tooltip label="Add local repository">
            <button
              type="button"
              aria-label="Add local repository"
              onClick={onAddExistingRepository}
            >
              <FontAwesomeIcon icon={faFolderPlus} aria-hidden="true" />
              <span className="sr-only">Add local repository</span>
            </button>
          </Tooltip>
          <Tooltip label="Clone repository">
            <button
              type="button"
              aria-label="Clone repository"
              onClick={onCloneRepository}
            >
              <FontAwesomeIcon icon={faClone} aria-hidden="true" />
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
              <FontAwesomeIcon icon={faFolderOpen} aria-hidden="true" />
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
              <FontAwesomeIcon icon={faCode} aria-hidden="true" />
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
              <FontAwesomeIcon icon={faTerminal} aria-hidden="true" />
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
              disabled={
                remoteState.loading ||
                remoteState.currentRemote === null ||
                remoteState.operation !== null
              }
              onClick={onFetch}
            >
              <FontAwesomeIcon
                icon={faArrowsDownToLine}
                spin={remoteState.operation === 'fetch'}
                aria-hidden="true"
              />
              <span className="sr-only">
                {remoteState.operation === 'fetch' ? 'Fetching…' : 'Fetch'}
              </span>
            </button>
          </Tooltip>
          <Tooltip label="Pull from remote">
            <button
              type="button"
              aria-label="Pull"
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
          </Tooltip>
          <Tooltip label="Push to remote">
            <button
              type="button"
              aria-label="Push"
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
          </Tooltip>
        </div>
      </section>
      <nav
        className="repository-view-navigation flex items-center gap-1.5"
        aria-label="Repository views"
      >
        <Tooltip label="Show changes">
          <button
            type="button"
            aria-current={repositoryView === 'changes' ? 'page' : undefined}
            aria-label="Changes"
            onClick={() => onSelectView('changes')}
          >
            <FontAwesomeIcon icon={faListCheck} aria-hidden="true" />
            <span className="repository-view-label">Changes</span>
          </button>
        </Tooltip>
        <Tooltip label="Show history">
          <button
            type="button"
            aria-current={repositoryView === 'history' ? 'page' : undefined}
            aria-label="History"
            onClick={() => onSelectView('history')}
          >
            <FontAwesomeIcon icon={faClockRotateLeft} aria-hidden="true" />
            <span className="repository-view-label">History</span>
          </button>
        </Tooltip>
      </nav>
      {status === null ? (
        statusElement
      ) : (
        <Tooltip label={status}>{statusElement}</Tooltip>
      )}
    </header>
  )
}
