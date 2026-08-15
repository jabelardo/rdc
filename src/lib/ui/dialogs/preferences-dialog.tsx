import type { MergeStrategy } from "../../../models/merge-strategy";
import { MergeStrategyLabel } from "../../../models/merge-strategy";
import { setWindowZoomFactor } from "../../platform/window";
import type { PreferencesState, PreferencesStore } from "../../stores/preferences-store";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { DialogFailure } from "./dialog-failure";

type PreferencesDialogProps = {
  readonly state: PreferencesState;
  readonly store: PreferencesStore;
  readonly onDismiss: () => void;
};

/** The application preferences form, kept separate from the modal orchestration layer. */
export function PreferencesDialog({ state, store, onDismiss }: PreferencesDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent className="preferences-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
        </DialogHeader>
        <div className="preferences-fields grid items-center gap-x-4 gap-y-3">
          <label htmlFor="theme-preference">Theme</label>
          <select
            id="theme-preference"
            value={state.theme}
            onChange={(event) =>
              void store.setTheme(event.currentTarget.value as PreferencesState["theme"])
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
                const next = Math.max(0.5, state.zoomFactor - 0.05);
                store.setZoomFactor(next);
                void setWindowZoomFactor(next);
              }}
              disabled={state.zoomFactor <= 0.5}
              aria-label="Decrease zoom"
            >
              −
            </button>
            <span aria-live="polite">{Math.round(state.zoomFactor * 100)}%</span>
            <button
              type="button"
              onClick={() => {
                const next = Math.min(2.0, state.zoomFactor + 0.05);
                store.setZoomFactor(next);
                void setWindowZoomFactor(next);
              }}
              disabled={state.zoomFactor >= 2.0}
              aria-label="Increase zoom"
            >
              +
            </button>
          </div>

          <label htmlFor="editor-preference">External editor</label>
          <select
            id="editor-preference"
            value={state.selectedExternalEditor ?? ""}
            disabled={state.loading}
            onChange={(event) => store.setSelectedExternalEditor(event.currentTarget.value || null)}
          >
            {state.editors.length === 0 && <option value="">No supported editor found</option>}
            {state.editors.map((editor) => (
              <option key={editor.editor} value={editor.editor}>
                {editor.editor}
              </option>
            ))}
          </select>

          <label htmlFor="shell-preference">Shell</label>
          <select
            id="shell-preference"
            value={state.selectedShell ?? ""}
            disabled={state.loading}
            onChange={(event) =>
              store.setSelectedShell(
                (event.currentTarget.value || null) as PreferencesState["selectedShell"],
              )
            }
          >
            {state.shells.length === 0 && <option value="">No supported shell found</option>}
            {state.shells.map((shell) => (
              <option key={shell.shell} value={shell.shell}>
                {shell.shell}
              </option>
            ))}
          </select>

          <label htmlFor="default-merge-strategy">Default merge</label>
          <select
            id="default-merge-strategy"
            value={state.defaultMergeStrategy}
            onChange={(event) =>
              store.setDefaultMergeStrategy(event.currentTarget.value as MergeStrategy)
            }
          >
            <option value="merge">{MergeStrategyLabel.merge}</option>
            <option value="squash">{MergeStrategyLabel.squash}</option>
          </select>

          <fieldset>
            <legend>Confirm before</legend>
            <label>
              <input
                type="checkbox"
                checked={state.confirmRepositoryRemoval}
                onChange={(event) => store.setConfirmRepositoryRemoval(event.currentTarget.checked)}
              />
              Removing a repository from rdc
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.confirmDiscardChanges}
                onChange={(event) => store.setConfirmDiscardChanges(event.currentTarget.checked)}
              />
              Discarding file changes
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.confirmDiscardChangesPermanently}
                onChange={(event) =>
                  store.setConfirmDiscardChangesPermanently(event.currentTarget.checked)
                }
              />
              Permanently discarding changes when trash fails
            </label>
          </fieldset>
        </div>
        <DialogFailure error={state.error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
