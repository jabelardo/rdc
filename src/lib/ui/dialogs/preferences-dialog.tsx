import type { ReactNode } from "react";
import { GitBranch, HelpCircle, Palette, Plug } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { DialogFailure } from "./dialog-failure";

type PreferencesDialogProps = {
  readonly state: PreferencesState;
  readonly store: PreferencesStore;
  readonly onDismiss: () => void;
};

/**
 * One row of the settings grid: a label and its control.
 *
 * The grid lives on the panel rather than on each row so every control in a category lines up on
 * the same column, which is the whole point of a two-column settings layout.
 */
function Setting({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <label className="font-semibold" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </>
  );
}

function Panel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
      {children}
    </div>
  );
}

/** Fixed height so the dialog does not resize as the user moves between categories. */
const panelClassName = "h-[27.5rem] max-h-[50vh] overflow-y-auto pl-1";

const selectClassName =
  "box-border min-w-0 rounded-[var(--radius-small)] border border-[var(--input)] bg-[var(--card)] py-1.5 pr-6 pl-2 text-foreground disabled:opacity-50";

/**
 * Application preferences, grouped by category.
 *
 * **Why a category layout rather than one list.** rdc has six settings today and desktop-plus has
 * nine categories' worth; a flat list has nowhere for the seventh to go except further down. The
 * shape is desktop-plus's — a vertical rail with the panel beside it — adapted to rdc's tokens and
 * built on Radix's `Tabs`, which supplies roving focus and arrow-key movement rather than this
 * hand-rolling them.
 *
 * **Only categories that have settings appear.** An empty category is a promise the app does not
 * keep; adding one costs a trigger and a panel when its first setting arrives.
 *
 * **The content pane is a fixed height.** Categories differ in length, and sizing to content makes
 * the dialog jump every time the user changes category. Fixed height with internal scrolling keeps
 * the frame still, and satisfies Convention 14's requirement that height be bounded.
 *
 * Preferences apply immediately, so there is no Save — the single Close button is the dialog's one
 * dismissing affordance, per Convention 6.
 */
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
      <DialogContent
        className="w-[min(37.5rem,calc(100vw-2rem))] sm:max-w-[600px]"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="appearance" orientation="vertical">
          <TabsList aria-label="Preferences categories">
            <TabsTrigger value="appearance">
              <Palette aria-hidden="true" />
              Appearance
            </TabsTrigger>
            <TabsTrigger value="integrations">
              <Plug aria-hidden="true" />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="git">
              <GitBranch aria-hidden="true" />
              Git
            </TabsTrigger>
            <TabsTrigger value="prompts">
              <HelpCircle aria-hidden="true" />
              Prompts
            </TabsTrigger>
          </TabsList>

          {/* The rail stays put and the panel scrolls, so a long category never pushes the
              categories out of reach. The height and the overflow sit on the panels themselves
              rather than on this wrapper: Radix puts each panel in the tab sequence, and that tab
              stop only earns itself if the thing it focuses is the scrollable region. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <TabsContent value="appearance" className={panelClassName}>
              <Panel>
                <Setting label="Theme" htmlFor="theme-preference">
                  <select
                    id="theme-preference"
                    className={selectClassName}
                    value={state.theme}
                    onChange={(event) =>
                      void store.setTheme(event.currentTarget.value as PreferencesState["theme"])
                    }
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </Setting>

                <Setting label="Zoom">
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
                </Setting>
              </Panel>
            </TabsContent>

            <TabsContent value="integrations" className={panelClassName}>
              <Panel>
                <Setting label="External editor" htmlFor="editor-preference">
                  <select
                    id="editor-preference"
                    className={selectClassName}
                    value={state.selectedExternalEditor ?? ""}
                    disabled={state.loading}
                    onChange={(event) =>
                      store.setSelectedExternalEditor(event.currentTarget.value || null)
                    }
                  >
                    {state.editors.length === 0 && (
                      <option value="">No supported editor found</option>
                    )}
                    {state.editors.map((editor) => (
                      <option key={editor.editor} value={editor.editor}>
                        {editor.editor}
                      </option>
                    ))}
                  </select>
                </Setting>

                <Setting label="Shell" htmlFor="shell-preference">
                  <select
                    id="shell-preference"
                    className={selectClassName}
                    value={state.selectedShell ?? ""}
                    disabled={state.loading}
                    onChange={(event) =>
                      store.setSelectedShell(
                        (event.currentTarget.value || null) as PreferencesState["selectedShell"],
                      )
                    }
                  >
                    {state.shells.length === 0 && (
                      <option value="">No supported shell found</option>
                    )}
                    {state.shells.map((shell) => (
                      <option key={shell.shell} value={shell.shell}>
                        {shell.shell}
                      </option>
                    ))}
                  </select>
                </Setting>
              </Panel>
            </TabsContent>

            <TabsContent value="git" className={panelClassName}>
              <Panel>
                <Setting label="Default merge" htmlFor="default-merge-strategy">
                  <select
                    id="default-merge-strategy"
                    className={selectClassName}
                    value={state.defaultMergeStrategy}
                    onChange={(event) =>
                      store.setDefaultMergeStrategy(event.currentTarget.value as MergeStrategy)
                    }
                  >
                    <option value="merge">{MergeStrategyLabel.merge}</option>
                    <option value="squash">{MergeStrategyLabel.squash}</option>
                  </select>
                </Setting>
              </Panel>
            </TabsContent>

            <TabsContent value="prompts" className={panelClassName}>
              <fieldset className="grid gap-1.5 border-0 p-0">
                <legend className="mb-1.5 font-semibold">Confirm before</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.confirmRepositoryRemoval}
                    onChange={(event) =>
                      store.setConfirmRepositoryRemoval(event.currentTarget.checked)
                    }
                  />
                  Removing a repository from rdc
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.confirmDiscardChanges}
                    onChange={(event) =>
                      store.setConfirmDiscardChanges(event.currentTarget.checked)
                    }
                  />
                  Discarding file changes
                </label>
                <label className="flex items-center gap-2">
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
            </TabsContent>
          </div>
        </Tabs>

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
