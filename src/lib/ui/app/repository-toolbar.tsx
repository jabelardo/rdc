import type { Repository } from '../../../models/repository'
import type { RemoteState } from '../../stores/remote-store'

type RepositoryToolbarProps = {
  readonly repository: Repository
  readonly remoteState: RemoteState
  readonly hasEditor: boolean
  readonly hasShell: boolean
  readonly onShowFiles: () => void
  readonly onOpenEditor: () => void
  readonly onOpenShell: () => void
  readonly onOpenNewWindow: () => void
  readonly onFetch: () => void
  readonly onPull: () => void
  readonly onPush: () => void
}

/** Current-repository identity, local shortcuts, and remote synchronization actions. */
export function RepositoryToolbar({
  repository,
  remoteState,
  hasEditor,
  hasShell,
  onShowFiles,
  onOpenEditor,
  onOpenShell,
  onOpenNewWindow,
  onFetch,
  onPull,
  onPush,
}: RepositoryToolbarProps) {
  return (
    <header
      className="repository-toolbar grid min-w-0 items-center gap-x-4 gap-y-3 border-b border-[var(--color-toolbar-border)] bg-[var(--color-toolbar)] px-4 py-[0.65rem] text-[var(--color-toolbar-text)]"
      role="toolbar"
      aria-label="Repository actions"
    >
      <div className="repository-toolbar-identity min-w-0">
        <p className="selected-repository-eyebrow">Repository</p>
        <h2>{repository.name}</h2>
        <p>{repository.path}</p>
      </div>
      <div className="repository-toolbar-actions flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onShowFiles}>
          Show files
        </button>
        <button type="button" disabled={!hasEditor} onClick={onOpenEditor}>
          Open in editor
        </button>
        <button type="button" disabled={!hasShell} onClick={onOpenShell}>
          Open in terminal
        </button>
        <button type="button" onClick={onOpenNewWindow}>
          Open in new window
        </button>
      </div>
      <section
        className="remote-controls grid min-w-0 items-center gap-x-4 gap-y-2"
        aria-label="Remote synchronization"
        aria-busy={remoteState.loading || remoteState.operation !== null}
      >
        <div>
          <h3>Remote</h3>
          <p>
            {remoteState.loading
              ? 'Loading remotes…'
              : remoteState.currentRemote === null
                ? 'No remote configured.'
                : `${remoteState.currentRemote.name} — ${remoteState.currentRemote.url}`}
          </p>
        </div>
        <div className="remote-actions flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={
              remoteState.loading ||
              remoteState.currentRemote === null ||
              remoteState.operation !== null
            }
            onClick={onFetch}
          >
            {remoteState.operation === 'fetch' ? 'Fetching…' : 'Fetch'}
          </button>
          <button
            type="button"
            disabled={
              remoteState.loading ||
              remoteState.currentRemote === null ||
              remoteState.currentBranch === null ||
              remoteState.currentBranch.upstream === null ||
              remoteState.operation !== null
            }
            onClick={onPull}
          >
            {remoteState.operation === 'pull' ? 'Pulling…' : 'Pull'}
          </button>
          <button
            type="button"
            disabled={
              remoteState.loading ||
              remoteState.currentRemote === null ||
              remoteState.currentBranch === null ||
              remoteState.operation !== null
            }
            onClick={onPush}
          >
            {remoteState.operation === 'push' ? 'Pushing…' : 'Push'}
          </button>
        </div>
        {remoteState.progress !== null && (
          <p className="remote-progress" role="status">
            {remoteState.progress.title ?? 'Fetching'}
            {remoteState.progress.description
              ? ` — ${remoteState.progress.description}`
              : ''}
            {` (${Math.round(remoteState.progress.value * 100)}%)`}
          </p>
        )}
        {remoteState.error !== null && (
          <p className="application-error" role="alert">
            {remoteState.error}
          </p>
        )}
        {remoteState.operationError !== null && (
          <p className="application-error" role="alert">
            {remoteState.operationError}
          </p>
        )}
      </section>
    </header>
  )
}
