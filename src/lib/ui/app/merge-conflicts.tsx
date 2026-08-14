import type { ConflictState, ConflictStore } from "../../stores/conflict-store";

type MergeConflictsProps = {
  readonly repositoryPath: string;
  readonly state: ConflictState;
  readonly store: ConflictStore;
  readonly onStageResolved: (path: string) => void;
  readonly recoveryOperation?: "cherryPick" | "revert";
  readonly onContinueRecovery?: () => void;
  readonly onAbortRecovery?: () => void;
};

/** In-progress merge state and resolved-file staging controls. */
export function MergeConflicts({
  repositoryPath,
  state,
  store,
  onStageResolved,
  recoveryOperation,
  onContinueRecovery,
  onAbortRecovery,
}: MergeConflictsProps) {
  const recoveryVisible = recoveryOperation !== undefined;
  if (!recoveryVisible && !state.mergeInProgress && state.files.length === 0 && state.error === null) {
    return null;
  }

  return (
    <section
      className="merge-conflicts absolute top-32 right-4 left-4 z-[2] rounded-[var(--radius-medium)] border border-[var(--warning-border)] bg-[var(--warning-surface)] p-4 text-left shadow-[var(--shadow-banner)]"
      aria-label={
        recoveryVisible
          ? `${recoveryOperation === "cherryPick" ? "Cherry-pick" : "Revert"} recovery`
          : state.mergeInProgress
            ? "Merge conflicts"
            : "Repository conflicts"
      }
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3>
            {recoveryVisible
              ? `${recoveryOperation === "cherryPick" ? "Cherry-pick" : "Revert"} recovery`
              : state.mergeInProgress
                ? "Merge in progress"
                : "Repository conflicts"}
          </h3>
          <p>Resolve files in your editor, then refresh and stage each resolution.</p>
        </div>
        <button
          type="button"
          disabled={state.loading || state.stagingPath !== null}
          onClick={() => void store.load(repositoryPath)}
        >
          Refresh conflict state
        </button>
      </header>
      {state.loading ? (
        <p>Loading conflict state…</p>
      ) : state.error !== null ? (
        <p className="application-error" role="alert">
          {state.error}
        </p>
      ) : state.files.length === 0 ? (
        <p>All conflict resolutions are staged.</p>
      ) : (
        <ul className="mt-4 grid list-none gap-[5.2px] p-0">
          {state.files.map((file) => (
            <li
              className="grid items-center gap-3 [grid-template-columns:minmax(0,1fr)_auto_auto]"
              key={file.path}
            >
              <span>{file.path}</span>
              <small>
                {file.resolvedInWorkingTree
                  ? "Resolved"
                  : "conflictMarkerCount" in file.status
                    ? `${file.status.conflictMarkerCount} ${
                        file.status.conflictMarkerCount === 1
                          ? "conflict marker"
                          : "conflict markers"
                      }`
                    : "Choose a side outside rdc"}
              </small>
              <button
                type="button"
                aria-label={`Stage resolution for ${file.path}`}
                disabled={!file.resolvedInWorkingTree || state.stagingPath !== null}
                onClick={() => onStageResolved(file.path)}
              >
                {state.stagingPath === file.path ? "Staging…" : "Stage resolution"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.operationError !== null && (
        <p className="application-error" role="alert">
          {state.operationError}
        </p>
      )}
      {recoveryVisible && (
        <div className="mt-4 flex justify-end gap-2">
          {recoveryOperation === "cherryPick" && onContinueRecovery !== undefined && (
            <button
              type="button"
              disabled={state.loading || state.stagingPath !== null || state.files.length > 0}
              onClick={onContinueRecovery}
            >
              Continue cherry-pick
            </button>
          )}
          {onAbortRecovery !== undefined && (
            <button type="button" disabled={state.loading} onClick={onAbortRecovery}>
              Abort {recoveryOperation === "cherryPick" ? "cherry-pick" : "revert"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
