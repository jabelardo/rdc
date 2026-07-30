import { useEffect, useState } from 'react'
import {
  getStatus,
  isCommandError,
  type IStatusResult,
} from './lib/git-ipc'
import { AppFileStatusKind } from './models/status'
import { installApplicationMenu } from './lib/menu/application-menu'
import { showContextualMenu } from './lib/menu/context-menu'
import { showOpenDialog } from './lib/platform/dialogs'
import { installDefaultCloseRequestHandler } from './lib/platform/lifetime'
import {
  closeWindow,
  openRepositoryInNewWindow,
  sendReady,
} from './lib/platform/window'
import type { OpenRepositoryAction } from './models/cli-action'
import './App.css'

const rendererStartTime = performance.now()

/**
 * A deliberately plain harness for the first end-to-end IPC slice.
 *
 * Its job is to prove the boundary works with real data — Rust runs git, the typed result crosses
 * IPC, React renders it — not to be the eventual UI. The real interface arrives in Phase 7, ported
 * from `desktop-plus/app/src/ui/**`.
 */
function App() {
  const [path, setPath] = useState('')
  const [status, setStatus] = useState<IStatusResult | null>(null)
  const [notARepository, setNotARepository] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [contextMenuResult, setContextMenuResult] = useState(
    'No contextual-menu selection'
  )
  const [dialogResult, setDialogResult] = useState('No directory selected')
  const [startupAction, setStartupAction] =
    useState<OpenRepositoryAction | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void installDefaultCloseRequestHandler()
      .then(cleanup => {
        if (disposed) {
          cleanup()
        } else {
          unlisten = cleanup
        }
      })
      .catch(error => {
        log.error('Failed to install the native close handler', error)
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let dispose: (() => void) | undefined
    void installApplicationMenu()
      .then(controller => {
        if (disposed) {
          controller.dispose()
        } else {
          dispose = () => controller.dispose()
        }
      })
      .catch(error => {
        log.error('Failed to install the application menu', error)
      })

    return () => {
      disposed = true
      dispose?.()
    }
  }, [])

  useEffect(() => {
    void sendReady(performance.now() - rendererStartTime)
      .then(action => {
        if (action?.kind === 'open-repository') {
          setStartupAction(action)
        }
      })
      .catch(error => {
        log.error('Failed to complete the renderer-ready handshake', error)
      })
  }, [])

  async function load(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    setStatus(null)
    setNotARepository(false)

    try {
      const result = await getStatus(path)
      if (result === null) {
        // A path that isn't a repository is a normal answer, not a failure.
        setNotARepository(true)
      } else {
        setStatus(result)
      }
    } catch (e) {
      // Errors arrive as the serialized CommandError, carrying a classified `kind` the UI could
      // branch on. Showing the message is enough for a harness.
      setError(isCommandError(e) ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function openContextMenu() {
    setContextMenuResult('No contextual-menu selection')
    let selected = false
    await showContextualMenu([
      {
        label: 'Select first item',
        action: () => {
          selected = true
          setContextMenuResult('Selected first item')
        },
      },
      {
        label: 'More',
        submenu: [
          {
            label: 'Select nested item',
            action: () => {
              selected = true
              setContextMenuResult('Selected nested item')
            },
          },
        ],
      },
    ])
    if (!selected) {
      setContextMenuResult('Contextual menu dismissed')
    }
  }

  async function openDirectoryDialog() {
    const selected = await showOpenDialog({
      title: 'Choose a repository directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    setDialogResult(selected ?? 'Directory dialog dismissed')
  }

  async function requestApplicationClose() {
    try {
      await closeWindow()
    } catch (error) {
      log.error('Failed to request application close', error)
    }
  }

  async function openRepositoryWindow() {
    try {
      await openRepositoryInNewWindow(path)
    } catch (error) {
      log.error('Failed to open repository in a new window', error)
    }
  }

  return (
    <main className="container">
      <h1>rdc</h1>
      <p>Repository status, read by Rust and rendered here.</p>

      <form className="row" onSubmit={load}>
        <input
          value={path}
          onChange={e => setPath(e.currentTarget.value)}
          placeholder="/path/to/a/git/repository"
          style={{ minWidth: '22rem' }}
        />
        <button type="submit" disabled={loading || path.trim() === ''}>
          {loading ? 'Reading…' : 'Read status'}
        </button>
      </form>

      <section aria-label="Native integration harness">
        <button type="button" onClick={() => void openContextMenu()}>
          Open contextual menu
        </button>
        <output aria-live="polite">{contextMenuResult}</output>
      </section>

      <section aria-label="Native dialog harness">
        <button type="button" onClick={() => void openDirectoryDialog()}>
          Open directory dialog
        </button>
        <output aria-live="polite">{dialogResult}</output>
      </section>

      <section aria-label="Repository window harness">
        <button
          type="button"
          disabled={path.trim() === ''}
          onClick={() => void openRepositoryWindow()}
        >
          Open repository in new window
        </button>
        <output aria-live="polite">
          {startupAction === null
            ? 'No startup repository'
            : `Open repository: ${startupAction.path}; persist selection: ${String(startupAction.persistSelection)}`}
        </output>
      </section>

      <section aria-label="Application lifetime harness">
        <button type="button" onClick={() => void requestApplicationClose()}>
          Request application close
        </button>
      </section>

      {error !== null && <p style={{ color: 'crimson' }}>{error}</p>}
      {notARepository && <p>That path is not a git repository.</p>}

      {status !== null && (
        <div style={{ textAlign: 'left', display: 'inline-block' }}>
          <p>
            <strong>{status.currentBranch ?? '(detached)'}</strong>
            {status.currentUpstreamBranch !== undefined && (
              <> → {status.currentUpstreamBranch}</>
            )}
            {status.branchAheadBehind !== undefined && (
              <>
                {' '}
                (ahead {status.branchAheadBehind.ahead}, behind{' '}
                {status.branchAheadBehind.behind})
              </>
            )}
          </p>

          {status.mergeHeadFound && <p>A merge is in progress.</p>}
          {status.rebaseInternalState !== undefined && (
            <p>Rebasing {status.rebaseInternalState.targetBranch}.</p>
          )}

          {status.files.length === 0 ? (
            <p>No changes.</p>
          ) : (
            <ul>
              {status.files.map(file => (
                <li key={file.path}>
                  <code>{describe(file.status.kind)}</code> {file.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  )
}

/** A short label for a file's status. */
function describe(kind: AppFileStatusKind): string {
  switch (kind) {
    case AppFileStatusKind.New:
      return 'new'
    case AppFileStatusKind.Modified:
      return 'modified'
    case AppFileStatusKind.Deleted:
      return 'deleted'
    case AppFileStatusKind.Copied:
      return 'copied'
    case AppFileStatusKind.Renamed:
      return 'renamed'
    case AppFileStatusKind.Conflicted:
      return 'conflicted'
    case AppFileStatusKind.Untracked:
      return 'untracked'
  }
}

export default App
