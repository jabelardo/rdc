import { useState } from 'react'
import {
  getStatus,
  isCommandError,
  type IStatusResult,
} from './lib/git-ipc'
import { AppFileStatusKind } from './models/status'
import './App.css'

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
