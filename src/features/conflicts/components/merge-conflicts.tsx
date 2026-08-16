import type { ConflictState, ConflictStore } from "@/features/conflicts/stores/conflict-store";

type MergeConflictsProps = {
  readonly repositoryPath: string;
  readonly state: ConflictState;
  readonly store: ConflictStore;
  readonly onStageResolved: (path: string) => void;
  readonly recoveryOperation?: "cherryPick" | "revert";
  readonly onContinueRecovery?: () => void;
  readonly onAbortRecovery?: () => void;
  readonly onContinueRebase?: () => void;
  readonly onAbortRebase?: () => void;
  readonly onAbortMerge?: () => void;
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
  onContinueRebase,
  onAbortRebase,
  onAbortMerge,
}: MergeConflictsProps) {
  const recoveryVisible = recoveryOperation !== undefined;
  if (
    !recoveryVisible &&
    !state.mergeInProgress &&
    !state.rebaseInProgress &&
    state.files.length === 0 &&
    !state.loadFailed
  ) {
    return null;
  }

  return (
    <section
      className="merge-conflicts absolute top-32 right-4 left-4 z-[2] rounded-[var(--radius-medium)] border border-[var(--warning-border)] bg-[var(--warning-surface)] p-4 text-left shadow-[var(--shadow-banner)]"
      aria-label={
        recoveryVisible
          ? `${recoveryOperation === "cherryPick" ? "Cherry-pick" : "Revert"} recovery`
          : state.rebaseInProgress
            ? "Rebase recovery"
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
              : state.rebaseInProgress
                ? "Rebase recovery"
                : state.mergeInProgress
                  ? "Merge in progress"
                  : "Repository conflicts"}
          </h3>
          <p>
            {recoveryOperation === "revert"
              ? "Resolve files in your editor, then refresh the conflict state. Revert can only be aborted from here."
              : state.rebaseInProgress
                ? "A rebase was interrupted. Resolve files in your editor, then refresh and stage each resolution. Continue or abort the rebase below."
                : state.mergeInProgress
                  ? "A merge was interrupted. Resolve and stage each conflict, then commit the merge, or abort it below."
                  : "Resolve files in your editor, then refresh and stage each resolution."}
          </p>
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
      ) : state.loadFailed ? (
        // The failure itself is a message, announced once; this only keeps the banner from
        // claiming everything is staged over a repository it could not read.
        <p>Conflict state is unavailable.</p>
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
              {recoveryOperation !== "revert" && (
                <button
                  type="button"
                  aria-label={`Stage resolution for ${file.path}`}
                  disabled={!file.resolvedInWorkingTree || state.stagingPath !== null}
                  onClick={() => onStageResolved(file.path)}
                >
                  {state.stagingPath === file.path ? "Staging…" : "Stage resolution"}
                </button>
              )}
            </li>
          ))}
        </ul>
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
      {state.rebaseInProgress && (
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={state.loading || state.stagingPath !== null || state.files.length > 0}
            onClick={onContinueRebase}
          >
            Continue rebase
          </button>
          <button type="button" disabled={state.loading} onClick={onAbortRebase}>
            Abort rebase
          </button>
        </div>
      )}
      {state.mergeInProgress && onAbortMerge !== undefined && (
        <div className="mt-4 flex justify-end">
          <button type="button" disabled={state.loading} onClick={onAbortMerge}>
            Abort merge
          </button>
        </div>
      )}
    </section>
  );
}
