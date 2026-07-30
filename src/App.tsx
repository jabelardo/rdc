import { useEffect, useState } from 'react'
import { installApplicationMenu } from './lib/menu/application-menu'
import { showContextualMenu } from './lib/menu/context-menu'
import { currentMenuPlatform } from './lib/menu/default-menu'
import {
  buildRepositoryMenu,
  createRepositoryMenuEventExecutor,
} from './lib/menu/repository-menu'
import { showOpenDialog } from './lib/platform/dialogs'
import { showFolderContents } from './lib/platform/files'
import { installDefaultCloseRequestHandler } from './lib/platform/lifetime'
import {
  openRepositoryInNewWindow,
  sendReady,
} from './lib/platform/window'
import {
  type AppStoreState,
} from './lib/stores/app-store'
import { getDefaultAppStore } from './lib/stores/default-app-store'
import { getDefaultWorkingTreeStore } from './lib/stores/default-working-tree-store'
import type { WorkingTreeState } from './lib/stores/working-tree-store'
import { mapStatus } from './lib/status'
import type { Repository } from './models/repository'
import { DiffType } from './models/diff'
import './App.css'

const rendererStartTime = performance.now()

function App() {
  const [appStore] = useState(getDefaultAppStore)
  const [workingTreeStore] = useState(getDefaultWorkingTreeStore)
  const [appState, setAppState] = useState<AppStoreState>(appStore.state)
  const [workingTreeState, setWorkingTreeState] =
    useState<WorkingTreeState>(workingTreeStore.state)
  const [error, setError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [useShellHookEnvironment, setUseShellHookEnvironment] =
    useState(false)
  const [commitTerminalOutput, setCommitTerminalOutput] = useState('')
  const [discardFileID, setDiscardFileID] = useState<string | null>(
    null
  )
  const [discarding, setDiscarding] = useState(false)
  const [permanentlyDiscard, setPermanentlyDiscard] = useState(false)
  const [discardSelection, setDiscardSelection] = useState(false)

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
    let controller:
      | Awaited<ReturnType<typeof installApplicationMenu>>
      | undefined
    let updatePending = false
    let latestState = appStore.state
    const platform = currentMenuPlatform()
    const executeMenuEvent = createRepositoryMenuEventExecutor(appStore, {
      addLocalRepository: addExistingRepository,
      chooseRepository: () => {
        document
          .querySelector<HTMLElement>(
            '[aria-label="Repositories"] [aria-current="true"]'
          )
          ?.focus()
      },
      openRepositoryInNewWindow,
      showFolderContents,
    })
    const unsubscribe = appStore.onDidUpdate(state => {
      latestState = state
      if (controller === undefined) {
        updatePending = true
        return
      }
      void controller
        .replaceMenu(buildRepositoryMenu(state, platform))
        .catch(error => {
          log.error('Failed to update the application menu', error)
        })
    })

    void installApplicationMenu({
      initialMenu: buildRepositoryMenu(latestState, platform),
      executeMenuEvent,
    })
      .then(async installedController => {
        if (disposed) {
          installedController.dispose()
        } else {
          controller = installedController
          if (updatePending) {
            updatePending = false
            await controller.replaceMenu(
              buildRepositoryMenu(latestState, platform)
            )
          }
        }
      })
      .catch(error => {
        log.error('Failed to install the application menu', error)
      })

    return () => {
      disposed = true
      unsubscribe()
      controller?.dispose()
    }
  }, [appStore])

  useEffect(() => {
    const unsubscribe = workingTreeStore.onDidUpdate(setWorkingTreeState)
    const repository = appState.selectedRepository
    setDiscardFileID(null)
    setDiscarding(false)
    setPermanentlyDiscard(false)
    setDiscardSelection(false)
    if (repository === null) {
      workingTreeStore.clear()
    } else {
      void workingTreeStore.load(repository.path)
    }
    return unsubscribe
  }, [appState.selectedRepository, workingTreeStore])

  useEffect(
    () =>
      workingTreeStore.onCommitTerminalOutput(
        setCommitTerminalOutput
      ),
    [workingTreeStore]
  )

  useEffect(() => {
    let disposed = false
    const unsubscribe = appStore.onDidUpdate(state => {
      if (!disposed) {
        setAppState(state)
      }
    })
    const load = appStore.load().catch(error => {
      log.error('Failed to load the repository list', error)
      if (!disposed) {
        setError(String(error))
      }
    })

    void sendReady(performance.now() - rendererStartTime)
      .then(async action => {
        if (action?.kind === 'open-repository') {
          await load
          await appStore.addRepository(
            action.path,
            action.persistSelection
          )
        }
      })
      .catch(error => {
        log.error('Failed to complete the renderer-ready handshake', error)
      })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [appStore])

  async function addExistingRepository() {
    const selected = await showOpenDialog({
      title: 'Choose a repository directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selected === null) {
      return
    }

    try {
      setError(null)
      await appStore.addRepository(selected)
    } catch (error) {
      setError(String(error))
    }
  }

  async function selectRepository(repository: Repository) {
    try {
      setError(null)
      await appStore.selectRepository(repository)
    } catch (error) {
      setError(String(error))
    }
  }

  async function openRepositoryContextMenu(repository: Repository) {
    if (appState.selectedRepository?.id !== repository.id) {
      await selectRepository(repository)
    }
    await showContextualMenu([
      {
        label: 'Open in New Window',
        action: () => {
          void runRepositoryAction(() =>
            openRepositoryInNewWindow(repository.path)
          )
        },
      },
      {
        label: 'Show in File Manager',
        action: () => {
          void runRepositoryAction(() =>
            showFolderContents(repository.path)
          )
        },
      },
      { type: 'separator' },
      {
        label: 'Remove',
        action: () => {
          void runRepositoryAction(() =>
            appStore.removeRepository(repository)
          )
        },
      },
    ])
  }

  async function runRepositoryAction(action: () => Promise<void>) {
    try {
      setError(null)
      await action()
    } catch (error) {
      setError(String(error))
    }
  }

  const discardFile =
    workingTreeState.workingDirectory?.files.find(
      file => file.id === discardFileID
    ) ?? null
  const selectedWorkingTreeFile =
    workingTreeState.workingDirectory?.files.find(
      file => file.id === workingTreeState.selectedFileID
    ) ?? null
  const hasSelectedDiffLines =
    workingTreeState.diff?.kind === DiffType.Text &&
    selectedWorkingTreeFile !== null &&
    workingTreeState.diff.hunks.some(hunk =>
      hunk.lines.some(
        (line, index) =>
          line.isIncludeableLine() &&
          selectedWorkingTreeFile.selection.isSelected(
            hunk.unifiedDiffStart + index
          )
      )
    )

  async function confirmDiscard() {
    if (discardFile === null) {
      return
    }
    setDiscarding(true)
    if (discardSelection) {
      const discarded = await workingTreeStore.discardSelectedLines()
      setDiscarding(false)
      if (discarded) {
        setDiscardFileID(null)
        setDiscardSelection(false)
      }
      return
    }
    const result = await workingTreeStore.discardFile(
      discardFile.id,
      permanentlyDiscard
    )
    setDiscarding(false)
    if (result === 'discarded') {
      setDiscardFileID(null)
      setPermanentlyDiscard(false)
    } else if (result === 'trash-failed') {
      setPermanentlyDiscard(true)
    }
  }

  return (
    <main className="application-shell">
      <aside className="repository-sidebar" aria-label="Repositories">
        <div className="repository-shell-heading">
          <h1>rdc</h1>
          <button
            type="button"
            aria-label="Add existing repository"
            title="Add existing repository"
            onClick={() => void addExistingRepository()}
          >
            Add
          </button>
        </div>
        {appState.repositories.length === 0 ? (
          <p className="repository-list-empty">No repositories yet.</p>
        ) : (
          <ul className="repository-list">
            {appState.repositories.map(repository => (
              <li
                key={repository.id}
                className="repository-list-item"
              >
                <button
                  type="button"
                  className="repository-list-selection"
                  data-repository-path={repository.path}
                  aria-label={`Select ${repository.name}`}
                  aria-current={
                    appState.selectedRepository?.id === repository.id
                      ? 'true'
                      : undefined
                  }
                  onClick={() => void selectRepository(repository)}
                  onContextMenu={event => {
                    event.preventDefault()
                    void openRepositoryContextMenu(repository)
                  }}
                >
                  <strong>{repository.name}</strong>
                  <span>{repository.path}</span>
                </button>
                <button
                  type="button"
                  className="repository-list-actions"
                  aria-label={`More actions for ${repository.name}`}
                  onClick={() =>
                    void openRepositoryContextMenu(repository)
                  }
                >
                  …
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="repository-workspace" aria-label="Selected repository">
        {appState.selectedRepository === null ? (
          <div className="repository-empty-state">
            <h2>Add a repository to get started</h2>
            <p>
              Open an existing Git repository from your computer.
            </p>
            <button
              type="button"
              onClick={() => void addExistingRepository()}
            >
              Add existing repository
            </button>
          </div>
        ) : (
          <div className="selected-repository">
            <p className="selected-repository-eyebrow">Repository</p>
            <h2>{appState.selectedRepository.name}</h2>
            <p>{appState.selectedRepository.path}</p>
            <button
              type="button"
              onClick={() =>
                void runRepositoryAction(() =>
                  openRepositoryInNewWindow(
                    appState.selectedRepository!.path
                  )
                )
              }
            >
              Open in new window
            </button>
            <section
              className="working-tree"
              aria-label="Changes"
            >
              <h3>Changes</h3>
              {workingTreeState.loading ? (
                <p>Loading changes…</p>
              ) : workingTreeState.error !== null ? (
                <p className="application-error" role="alert">
                  {workingTreeState.error}
                </p>
              ) : workingTreeState.workingDirectory === null ||
                workingTreeState.workingDirectory.files.length === 0 ? (
                <p>No local changes.</p>
              ) : (
                <ul className="working-tree-files">
                  {workingTreeState.workingDirectory.files.map(file => (
                    <li
                      key={file.id}
                      data-changed-file-path={file.path}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Include ${file.path}`}
                        checked={file.isIncludedInCommit()}
                        onChange={event =>
                          workingTreeStore.setFileIncluded(
                            file.id,
                            event.currentTarget.checked
                          )
                        }
                      />
                      <button
                        type="button"
                        className="working-tree-file-selection"
                        aria-current={
                          workingTreeState.selectedFileID === file.id
                            ? 'true'
                            : undefined
                        }
                        onClick={() =>
                          void workingTreeStore.selectFile(file.id)
                        }
                      >
                        <span>{file.path}</span>
                        <small>{mapStatus(file.status)}</small>
                      </button>
                      <button
                        type="button"
                        className="working-tree-file-discard"
                        aria-label={`Discard ${file.path}`}
                        onClick={() => {
                          setDiscardFileID(file.id)
                          setPermanentlyDiscard(false)
                          setDiscardSelection(false)
                        }}
                      >
                        Discard
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section
              className="working-tree-diff"
              aria-label="File diff"
            >
              {workingTreeState.diffLoading ? (
                <p>Loading diff…</p>
              ) : workingTreeState.diffError !== null ? (
                <p className="application-error" role="alert">
                  {workingTreeState.diffError}
                </p>
              ) : workingTreeState.diff === null ? null : workingTreeState
                  .diff.kind === DiffType.Text ? (
                <>
                  <div
                    className="working-tree-diff-lines"
                    role="table"
                    aria-label="Selectable diff lines"
                  >
                    {workingTreeState.diff.hunks.flatMap(
                      (hunk, hunkIndex) =>
                        hunk.lines.map((line, lineIndex) => {
                          const absoluteIndex =
                            hunk.unifiedDiffStart + lineIndex
                          const includeable = line.isIncludeableLine()
                          return (
                            <div
                              className="working-tree-diff-line"
                              role="row"
                              key={`${hunkIndex}-${absoluteIndex}`}
                              data-diff-line-index={absoluteIndex}
                            >
                              {includeable &&
                              selectedWorkingTreeFile !== null ? (
                                <input
                                  type="checkbox"
                                  aria-label={`Include diff line ${absoluteIndex}: ${line.content}`}
                                  checked={selectedWorkingTreeFile.selection.isSelected(
                                    absoluteIndex
                                  )}
                                  disabled={
                                    workingTreeState.commitLoading
                                  }
                                  onChange={event =>
                                    workingTreeStore.setLineIncluded(
                                      absoluteIndex,
                                      event.currentTarget.checked
                                    )
                                  }
                                />
                              ) : (
                                <span aria-hidden="true" />
                              )}
                              <span className="diff-line-number">
                                {line.oldLineNumber ?? ''}
                              </span>
                              <span className="diff-line-number">
                                {line.newLineNumber ?? ''}
                              </span>
                              <code>{line.text}</code>
                            </div>
                          )
                        })
                    )}
                  </div>
                  <button
                    type="button"
                    className="discard-selected-lines"
                    disabled={!hasSelectedDiffLines}
                    onClick={() => {
                      if (selectedWorkingTreeFile !== null) {
                        setDiscardFileID(selectedWorkingTreeFile.id)
                        setDiscardSelection(true)
                        setPermanentlyDiscard(false)
                      }
                    }}
                  >
                    Discard selected lines
                  </button>
                </>
              ) : workingTreeState.diff.kind === DiffType.LargeText ? (
                <pre>{workingTreeState.diff.text}</pre>
              ) : workingTreeState.diff.kind === DiffType.Binary ? (
                <p>Binary file cannot be displayed.</p>
              ) : workingTreeState.diff.kind === DiffType.Image ? (
                <p>Image preview is not available yet.</p>
              ) : workingTreeState.diff.kind === DiffType.Submodule ? (
                <p>Submodule change.</p>
              ) : (
                <p>Diff cannot be displayed.</p>
              )}
            </section>
            {workingTreeState.workingDirectory !== null &&
              workingTreeState.workingDirectory.files.length > 0 && (
                <form
                  className="commit-form"
                  aria-label="Commit changes"
                  onSubmit={event => {
                    event.preventDefault()
                    void workingTreeStore
                      .commit(commitMessage, useShellHookEnvironment)
                      .then(sha => {
                        if (sha !== null) {
                          setCommitMessage('')
                        }
                      })
                  }}
                >
                  <label htmlFor="commit-message">
                    Commit message
                  </label>
                  <input
                    id="commit-message"
                    value={commitMessage}
                    onChange={event =>
                      setCommitMessage(event.currentTarget.value)
                    }
                  />
                  <label className="commit-option">
                    <input
                      type="checkbox"
                      checked={useShellHookEnvironment}
                      disabled={workingTreeState.commitLoading}
                      onChange={event =>
                        setUseShellHookEnvironment(
                          event.currentTarget.checked
                        )
                      }
                    />
                    Run hooks with the shell environment
                  </label>
                  <button
                    type="submit"
                    disabled={workingTreeState.commitLoading}
                  >
                    {workingTreeState.commitLoading
                      ? 'Committing…'
                      : 'Commit included files'}
                  </button>
                  {workingTreeState.commitError !== null && (
                    <p className="application-error" role="alert">
                      {workingTreeState.commitError}
                    </p>
                  )}
                  {commitTerminalOutput.length > 0 && (
                    <pre
                      className="commit-terminal-output"
                      aria-label="Commit terminal output"
                    >
                      {commitTerminalOutput}
                    </pre>
                  )}
                </form>
              )}
          </div>
        )}

        {error !== null && (
          <p className="application-error" role="alert">
            {error}
          </p>
        )}
      </section>
      {discardFile !== null && (
        <div className="dialog-backdrop">
          <section
            className="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-dialog-title"
            aria-describedby="discard-dialog-message"
          >
            <h2 id="discard-dialog-title">
              {permanentlyDiscard
                ? 'Permanently discard changes'
                : 'Confirm discard changes'}
            </h2>
            <p>
              Are you sure you want to discard{' '}
              {discardSelection ? 'the selected changes to ' : 'all changes to '}
              <strong>{discardFile.path}</strong>?
            </p>
            <p id="discard-dialog-message">
              {discardSelection
                ? 'Selected changes cannot be restored from the operating system trash.'
                : permanentlyDiscard
                ? 'Changes cannot be restored after deletion.'
                : 'Changes can be restored from the operating system trash.'}
            </p>
            {workingTreeState.error !== null && (
              <p className="application-error" role="alert">
                {workingTreeState.error}
              </p>
            )}
            <div className="confirmation-dialog-actions">
              <button
                type="button"
                disabled={discarding}
                onClick={() => {
                  setDiscardFileID(null)
                  setPermanentlyDiscard(false)
                  setDiscardSelection(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="destructive-button"
                disabled={discarding}
                onClick={() => void confirmDiscard()}
              >
                {discarding
                  ? 'Discarding…'
                  : permanentlyDiscard
                    ? 'Permanently discard changes'
                    : 'Discard changes'}
              </button>
            </div>
          </section>
        </div>
      )}
      {workingTreeState.hookFailure !== null && (
        <div className="dialog-backdrop">
          <section
            className="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="hook-failure-title"
            aria-describedby="hook-failure-message"
          >
            <h2 id="hook-failure-title">Git hook failed</h2>
            <p id="hook-failure-message">
              The{' '}
              <strong>{workingTreeState.hookFailure.hook}</strong> hook
              failed. Abort the commit, or ignore this failure and
              continue?
            </p>
            <pre className="commit-terminal-output">
              {workingTreeState.hookFailure.terminalOutput}
            </pre>
            <div className="confirmation-dialog-actions">
              <button
                type="button"
                onClick={() =>
                  workingTreeStore.resolveHookFailure('abort')
                }
              >
                Abort commit
              </button>
              <button
                type="button"
                onClick={() =>
                  workingTreeStore.resolveHookFailure('ignore')
                }
              >
                Ignore hook failure
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
