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
import type { Repository } from './models/repository'
import './App.css'

const rendererStartTime = performance.now()

function App() {
  const [appStore] = useState(getDefaultAppStore)
  const [appState, setAppState] = useState<AppStoreState>(appStore.state)
  const [error, setError] = useState<string | null>(null)

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
          </div>
        )}

        {error !== null && (
          <p className="application-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}

export default App
