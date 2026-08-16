import type { FoundEditor } from "@/models/editor";
import type { MergeStrategy } from "@/models/merge-strategy";
import { Shell, type FoundShell } from "@/models/shell";
import { getAvailableEditors } from "@/platform/editors";
import { getAvailableShells } from "@/platform/shells";
import { setNativeThemeSource, shouldUseDarkColors, type ThemeSource } from "@/platform/theme";
import { describeError } from "@/lib/format-error";

export const PreferencesStorageKey = "rdc-preferences-v1";

export type PreferencesState = {
  readonly theme: ThemeSource;
  /** `theme` with "system" resolved to a concrete value — what `useTheme()` (theme-provider.tsx)
   * exposes to anything that needs a real light/dark decision rather than the raw preference. */
  readonly resolvedTheme: "light" | "dark";
  readonly zoomFactor: number;
  readonly confirmRepositoryRemoval: boolean;
  readonly confirmDiscardChanges: boolean;
  readonly confirmDiscardChangesPermanently: boolean;
  /**
   * Which strategy the merge dialog offers first.
   *
   * A team convention rather than a per-invocation choice, which is why it lives here instead of
   * being re-decided in the dialog each time. The dialog still lets either be picked.
   */
  readonly defaultMergeStrategy: MergeStrategy;
  readonly selectedExternalEditor: string | null;
  readonly selectedShell: Shell | null;
  readonly editors: ReadonlyArray<FoundEditor>;
  readonly shells: ReadonlyArray<FoundShell>;
  readonly loading: boolean;
  readonly error: string | null;
};

type PersistedPreferences = Pick<
  PreferencesState,
  | "theme"
  | "zoomFactor"
  | "confirmRepositoryRemoval"
  | "confirmDiscardChanges"
  | "confirmDiscardChangesPermanently"
  | "defaultMergeStrategy"
  | "selectedExternalEditor"
  | "selectedShell"
>;

type PreferencesStoreDependencies = {
  readonly getAvailableEditors: typeof getAvailableEditors;
  readonly getAvailableShells: typeof getAvailableShells;
  readonly setTheme: (theme: ThemeSource) => Promise<"light" | "dark">;
  readonly resolveSystemTheme: () => Promise<"light" | "dark">;
};

const DefaultPreferences: PersistedPreferences = {
  theme: "system",
  zoomFactor: __LINUX__ ? 1.15 : 1.0,
  confirmRepositoryRemoval: true,
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  // A merge commit preserves the shape of the history, which is the safer default to assume when
  // nobody has expressed a preference.
  defaultMergeStrategy: "merge",
  selectedExternalEditor: null,
  selectedShell: null,
};

function isTheme(value: unknown): value is ThemeSource {
  return value === "light" || value === "dark" || value === "system";
}

function isMergeStrategy(value: unknown): value is MergeStrategy {
  return value === "merge" || value === "squash";
}

function isShell(value: unknown): value is Shell {
  return (
    typeof value === "string" && (Object.values(Shell) as ReadonlyArray<string>).includes(value)
  );
}

function readBoolean(
  source: Record<string, unknown>,
  key: keyof PersistedPreferences,
  fallback: boolean,
): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function readPreferences(): PersistedPreferences {
  const raw = localStorage.getItem(PreferencesStorageKey);
  if (raw === null) {
    return DefaultPreferences;
  }

  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch {
    return DefaultPreferences;
  }
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return DefaultPreferences;
  }

  const record = source as Record<string, unknown>;
  return {
    theme: isTheme(record.theme) ? record.theme : DefaultPreferences.theme,
    confirmRepositoryRemoval: readBoolean(
      record,
      "confirmRepositoryRemoval",
      DefaultPreferences.confirmRepositoryRemoval,
    ),
    confirmDiscardChanges: readBoolean(
      record,
      "confirmDiscardChanges",
      DefaultPreferences.confirmDiscardChanges,
    ),
    confirmDiscardChangesPermanently: readBoolean(
      record,
      "confirmDiscardChangesPermanently",
      DefaultPreferences.confirmDiscardChangesPermanently,
    ),
    defaultMergeStrategy: isMergeStrategy(record.defaultMergeStrategy)
      ? record.defaultMergeStrategy
      : DefaultPreferences.defaultMergeStrategy,
    selectedExternalEditor:
      typeof record.selectedExternalEditor === "string" ? record.selectedExternalEditor : null,
    selectedShell: isShell(record.selectedShell) ? record.selectedShell : null,
    zoomFactor:
      typeof record.zoomFactor === "number" && record.zoomFactor > 0
        ? record.zoomFactor
        : DefaultPreferences.zoomFactor,
  };
}

async function applyTheme(theme: ThemeSource): Promise<"light" | "dark"> {
  await setNativeThemeSource(theme);
  if (theme === "system") {
    return resolveSystemTheme();
  }
  document.documentElement.dataset.theme = theme;
  return theme;
}

async function resolveSystemTheme(): Promise<"light" | "dark"> {
  const resolved = (await shouldUseDarkColors()) ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export class PreferencesStore {
  private currentState: PreferencesState;
  private readonly dependencies: PreferencesStoreDependencies;
  private readonly listeners = new Set<(state: PreferencesState) => void>();

  public constructor(dependencies: Partial<PreferencesStoreDependencies> = {}) {
    const preferences = readPreferences();
    this.currentState = {
      ...preferences,
      // A real light/dark decision for "system" needs an async round trip (see resolveSystemTheme)
      // that has not run yet at construction time; "light" matches what the page already looks
      // like before any theme is applied (the plain, unscoped :root block is the light palette).
      resolvedTheme: preferences.theme === "dark" ? "dark" : "light",
      editors: [],
      shells: [],
      loading: true,
      error: null,
    };
    this.dependencies = {
      getAvailableEditors,
      getAvailableShells,
      setTheme: applyTheme,
      resolveSystemTheme,
      ...dependencies,
    };
  }

  public get state(): PreferencesState {
    return this.currentState;
  }

  public get selectedEditor(): FoundEditor | null {
    return (
      this.currentState.editors.find(
        (editor) => editor.editor === this.currentState.selectedExternalEditor,
      ) ?? null
    );
  }

  public get selectedShell(): FoundShell | null {
    return (
      this.currentState.shells.find((shell) => shell.shell === this.currentState.selectedShell) ??
      null
    );
  }

  public onDidUpdate(listener: (state: PreferencesState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(): Promise<void> {
    this.update({ ...this.currentState, loading: true, error: null });
    try {
      const [editors, shells, resolvedTheme] = await Promise.all([
        this.dependencies.getAvailableEditors(),
        this.dependencies.getAvailableShells(),
        this.dependencies.setTheme(this.currentState.theme),
      ]);
      const selectedExternalEditor = editors.some(
        (editor) => editor.editor === this.currentState.selectedExternalEditor,
      )
        ? this.currentState.selectedExternalEditor
        : (editors[0]?.editor ?? null);
      const selectedShell = shells.some((shell) => shell.shell === this.currentState.selectedShell)
        ? this.currentState.selectedShell
        : (shells[0]?.shell ?? null);
      this.update({
        ...this.currentState,
        editors,
        shells,
        selectedExternalEditor,
        selectedShell,
        resolvedTheme,
        loading: false,
        error: null,
      });
      this.persist();
    } catch (error) {
      this.update({
        ...this.currentState,
        loading: false,
        error: describeError(error),
      });
    }
  }

  public async setTheme(theme: ThemeSource): Promise<void> {
    this.updateAndPersist({ theme });
    try {
      const resolvedTheme = await this.dependencies.setTheme(theme);
      this.update({ ...this.currentState, resolvedTheme });
    } catch (error) {
      this.update({ ...this.currentState, error: describeError(error) });
    }
  }

  public async refreshTheme(): Promise<void> {
    if (this.currentState.theme !== "system") {
      return;
    }
    try {
      const resolvedTheme = await this.dependencies.resolveSystemTheme();
      if (resolvedTheme !== this.currentState.resolvedTheme) {
        this.update({ ...this.currentState, resolvedTheme });
      }
    } catch (error) {
      this.update({ ...this.currentState, error: describeError(error) });
    }
  }

  public setConfirmRepositoryRemoval(value: boolean): void {
    this.updateAndPersist({ confirmRepositoryRemoval: value });
  }

  public setConfirmDiscardChanges(value: boolean): void {
    this.updateAndPersist({ confirmDiscardChanges: value });
  }

  public setConfirmDiscardChangesPermanently(value: boolean): void {
    this.updateAndPersist({ confirmDiscardChangesPermanently: value });
  }

  public setDefaultMergeStrategy(value: MergeStrategy): void {
    this.updateAndPersist({ defaultMergeStrategy: value });
  }

  public setSelectedExternalEditor(value: string | null): void {
    if (value !== null && !this.currentState.editors.some((editor) => editor.editor === value)) {
      return;
    }
    this.updateAndPersist({ selectedExternalEditor: value });
  }

  public setSelectedShell(value: Shell | null): void {
    if (value !== null && !this.currentState.shells.some((shell) => shell.shell === value)) {
      return;
    }
    this.updateAndPersist({ selectedShell: value });
  }

  public setZoomFactor(value: number): void {
    if (value <= 0) {
      return;
    }
    this.updateAndPersist({ zoomFactor: value });
  }

  private updateAndPersist(update: Partial<PersistedPreferences>): void {
    this.update({ ...this.currentState, ...update });
    this.persist();
  }

  private persist(): void {
    const {
      theme,
      confirmRepositoryRemoval,
      confirmDiscardChanges,
      confirmDiscardChangesPermanently,
      defaultMergeStrategy,
      selectedExternalEditor,
      selectedShell,
      zoomFactor,
    } = this.currentState;
    localStorage.setItem(
      PreferencesStorageKey,
      JSON.stringify({
        theme,
        zoomFactor,
        confirmRepositoryRemoval,
        confirmDiscardChanges,
        confirmDiscardChangesPermanently,
        defaultMergeStrategy,
        selectedExternalEditor,
        selectedShell,
      } satisfies PersistedPreferences),
    );
  }

  private update(state: PreferencesState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
