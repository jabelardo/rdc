import type { Repository } from '../../../models/repository'
import type { WorkingDirectoryFileChange } from '../../../models/status'
import type { CloneState } from '../../stores/clone-store'
import type {
  PreferencesState,
  PreferencesStore,
} from '../../stores/preferences-store'
import { setWindowZoomFactor } from '../../platform/window'
import type {
  HookFailureState,
  WorkingTreeStore,
} from '../../stores/working-tree-store'
import { Modal } from '../modal'

const confirmationDialogClassName =
  'confirmation-dialog box-border w-[min(30rem,calc(100vw-2rem))] rounded-[var(--radius-medium)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-6 shadow-[var(--shadow-dialog)]'
const dialogActionsClassName =
  'confirmation-dialog-actions mt-6 flex justify-end gap-3'

type AppDialogsProps = {
  readonly discardFile: WorkingDirectoryFileChange | null
  readonly permanentlyDiscard: boolean
  readonly discardSelection: boolean
  readonly discarding: boolean
  readonly workingTreeError: string | null
  readonly hookFailure: HookFailureState | null
  readonly workingTreeStore: WorkingTreeStore
  readonly repositoryToRemove: Repository | null
  readonly showAboutDialog: boolean
  readonly showPreferencesDialog: boolean
  readonly preferencesState: PreferencesState
  readonly preferencesStore: PreferencesStore
  readonly showCloneDialog: boolean
  readonly cloneState: CloneState
  readonly cloneURL: string
  readonly clonePath: string
  readonly onCancelDiscard: () => void
  readonly onConfirmDiscard: () => void
  readonly onCancelRemoveRepository: () => void
  readonly onConfirmRemoveRepository: () => void
  readonly onDismissAbout: () => void
  readonly onDismissPreferences: () => void
  readonly onDismissClone: () => void
  readonly onChooseCloneDestination: () => void
  readonly onSubmitClone: () => void
  readonly onCloneURLChange: (value: string) => void
  readonly onClonePathChange: (value: string) => void
}

/**
 * The application's modal layer.
 *
 * Keeping these workflows together is intentional: only one can be actionable at a time, they
 * share focus restoration through `Modal`, and none participates in the repository workspace's
 * layout. Extracting them prevents modal state changes from obscuring the main shell structure.
 */
export function AppDialogs({
  discardFile,
  permanentlyDiscard,
  discardSelection,
  discarding,
  workingTreeError,
  hookFailure,
  workingTreeStore,
  repositoryToRemove,
  showAboutDialog,
  showPreferencesDialog,
  preferencesState,
  preferencesStore,
  showCloneDialog,
  cloneState,
  cloneURL,
  clonePath,
  onCancelDiscard,
  onConfirmDiscard,
  onCancelRemoveRepository,
  onConfirmRemoveRepository,
  onDismissAbout,
  onDismissPreferences,
  onDismissClone,
  onChooseCloneDestination,
  onSubmitClone,
  onCloneURLChange,
  onClonePathChange,
}: AppDialogsProps) {
  return (
    <>
      {discardFile !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="discard-dialog-title"
          aria-describedby="discard-dialog-message"
          onDismiss={discarding ? undefined : onCancelDiscard}
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
          {workingTreeError !== null && (
            <p className="application-error" role="alert">
              {workingTreeError}
            </p>
          )}
          <div className={dialogActionsClassName}>
            <button
              type="button"
              disabled={discarding}
              onClick={onCancelDiscard}
            >
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              disabled={discarding}
              onClick={onConfirmDiscard}
            >
              {discarding
                ? 'Discarding…'
                : permanentlyDiscard
                  ? 'Permanently discard changes'
                  : 'Discard changes'}
            </button>
          </div>
        </Modal>
      )}

      {hookFailure !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="hook-failure-title"
          aria-describedby="hook-failure-message"
        >
          <h2 id="hook-failure-title">Git hook failed</h2>
          <p id="hook-failure-message">
            The <strong>{hookFailure.hook}</strong> hook failed. Abort the
            commit, or ignore this failure and continue?
          </p>
          <pre className="commit-terminal-output">
            {hookFailure.terminalOutput}
          </pre>
          <div className={dialogActionsClassName}>
            <button
              type="button"
              onClick={() => workingTreeStore.resolveHookFailure('abort')}
            >
              Abort commit
            </button>
            <button
              type="button"
              onClick={() => workingTreeStore.resolveHookFailure('ignore')}
            >
              Ignore hook failure
            </button>
          </div>
        </Modal>
      )}

      {repositoryToRemove !== null && (
        <Modal
          className={confirmationDialogClassName}
          role="alertdialog"
          aria-labelledby="remove-repository-title"
          aria-describedby="remove-repository-message"
          onDismiss={onCancelRemoveRepository}
        >
          <h2 id="remove-repository-title">Remove repository</h2>
          <p id="remove-repository-message">
            Remove <strong>{repositoryToRemove.name}</strong> from rdc? Files in
            the repository will not be deleted.
          </p>
          <div className={dialogActionsClassName}>
            <button type="button" onClick={onCancelRemoveRepository}>
              Cancel
            </button>
            <button
              type="button"
              className="destructive-button"
              onClick={onConfirmRemoveRepository}
            >
              Remove repository
            </button>
          </div>
        </Modal>
      )}

      {showAboutDialog && (
        <Modal
          className={`${confirmationDialogClassName} about-dialog`}
          aria-labelledby="about-dialog-title"
          onDismiss={onDismissAbout}
        >
          <h2 id="about-dialog-title">About RDC</h2>
          <p>Version {__APP_VERSION__}</p>
          <p>A native Git client built with Tauri and Rust.</p>
          <div className={dialogActionsClassName}>
            <button type="button" onClick={onDismissAbout}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {showPreferencesDialog && (
        <Modal
          className={`${confirmationDialogClassName} preferences-dialog`}
          aria-labelledby="preferences-dialog-title"
          onDismiss={onDismissPreferences}
        >
          <h2 id="preferences-dialog-title">Preferences</h2>
          <div className="preferences-fields grid items-center gap-x-4 gap-y-3">
            <label htmlFor="theme-preference">Theme</label>
            <select
              id="theme-preference"
              value={preferencesState.theme}
              onChange={event =>
                void preferencesStore.setTheme(
                  event.currentTarget.value as PreferencesState['theme']
                )
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>

            <label>Zoom</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const next = Math.max(0.5, preferencesState.zoomFactor - 0.05)
                  preferencesStore.setZoomFactor(next)
                  void setWindowZoomFactor(next)
                }}
                disabled={preferencesState.zoomFactor <= 0.5}
                aria-label="Decrease zoom"
              >
                −
              </button>
              <span aria-live="polite">
                {Math.round(preferencesState.zoomFactor * 100)}%
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = Math.min(2.0, preferencesState.zoomFactor + 0.05)
                  preferencesStore.setZoomFactor(next)
                  void setWindowZoomFactor(next)
                }}
                disabled={preferencesState.zoomFactor >= 2.0}
                aria-label="Increase zoom"
              >
                +
              </button>
            </div>

            <label htmlFor="editor-preference">External editor</label>
            <select
              id="editor-preference"
              value={preferencesState.selectedExternalEditor ?? ''}
              disabled={preferencesState.loading}
              onChange={event =>
                preferencesStore.setSelectedExternalEditor(
                  event.currentTarget.value || null
                )
              }
            >
              {preferencesState.editors.length === 0 && (
                <option value="">No supported editor found</option>
              )}
              {preferencesState.editors.map(editor => (
                <option key={editor.editor} value={editor.editor}>
                  {editor.editor}
                </option>
              ))}
            </select>

            <label htmlFor="shell-preference">Shell</label>
            <select
              id="shell-preference"
              value={preferencesState.selectedShell ?? ''}
              disabled={preferencesState.loading}
              onChange={event =>
                preferencesStore.setSelectedShell(
                  (event.currentTarget.value ||
                    null) as PreferencesState['selectedShell']
                )
              }
            >
              {preferencesState.shells.length === 0 && (
                <option value="">No supported shell found</option>
              )}
              {preferencesState.shells.map(shell => (
                <option key={shell.shell} value={shell.shell}>
                  {shell.shell}
                </option>
              ))}
            </select>

            <fieldset>
              <legend>Confirm before</legend>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmRepositoryRemoval}
                  onChange={event =>
                    preferencesStore.setConfirmRepositoryRemoval(
                      event.currentTarget.checked
                    )
                  }
                />
                Removing a repository from rdc
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmDiscardChanges}
                  onChange={event =>
                    preferencesStore.setConfirmDiscardChanges(
                      event.currentTarget.checked
                    )
                  }
                />
                Discarding file changes
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferencesState.confirmDiscardChangesPermanently}
                  onChange={event =>
                    preferencesStore.setConfirmDiscardChangesPermanently(
                      event.currentTarget.checked
                    )
                  }
                />
                Permanently discarding changes when trash fails
              </label>
            </fieldset>
          </div>
          {preferencesState.error !== null && (
            <p className="application-error" role="alert">
              {preferencesState.error}
            </p>
          )}
          <div className={dialogActionsClassName}>
            <button type="button" onClick={onDismissPreferences}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {showCloneDialog && (
        <Modal
          className={`${confirmationDialogClassName} clone-dialog`}
          aria-labelledby="clone-dialog-title"
          onDismiss={cloneState.operation === null ? onDismissClone : undefined}
        >
          <h2 id="clone-dialog-title">Clone a repository</h2>
          <form
            aria-busy={cloneState.operation !== null}
            onSubmit={event => {
              event.preventDefault()
              onSubmitClone()
            }}
          >
            <label htmlFor="clone-url">Repository URL</label>
            <input
              id="clone-url"
              value={cloneURL}
              disabled={cloneState.operation !== null}
              onChange={event => onCloneURLChange(event.currentTarget.value)}
            />
            <label htmlFor="clone-path">Destination path</label>
            <div className="clone-path grid gap-2 [grid-template-columns:minmax(0,1fr)_auto]">
              <input
                id="clone-path"
                value={clonePath}
                disabled={cloneState.operation !== null}
                onChange={event => onClonePathChange(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={cloneState.operation !== null}
                onClick={onChooseCloneDestination}
              >
                Browse…
              </button>
            </div>
            {cloneState.progress !== null && (
              <div className="clone-progress grid gap-[0.35rem]" role="status">
                <progress value={cloneState.progress.value} max={1} />
                <span>
                  {cloneState.progress.description ??
                    cloneState.progress.title ??
                    'Cloning…'}
                </span>
              </div>
            )}
            {cloneState.error !== null && (
              <p className="application-error" role="alert">
                {cloneState.error}
              </p>
            )}
            <div className={dialogActionsClassName}>
              <button
                type="button"
                disabled={cloneState.operation !== null}
                onClick={onDismissClone}
              >
                Cancel
              </button>
              <button type="submit" disabled={cloneState.operation !== null}>
                {cloneState.operation === 'clone' ? 'Cloning…' : 'Clone'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
