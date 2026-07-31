import type { FoundEditor } from '../../models/editor'
import { Shell, type FoundShell } from '../../models/shell'
import { getAvailableEditors } from '../platform/editors'
import { getAvailableShells } from '../platform/shells'
import {
  setNativeThemeSource,
  shouldUseDarkColors,
  type ThemeSource,
} from '../platform/theme'

export const PreferencesStorageKey = 'rdc-preferences-v1'

export type PreferencesState = {
  readonly theme: ThemeSource
  readonly confirmRepositoryRemoval: boolean
  readonly confirmDiscardChanges: boolean
  readonly confirmDiscardChangesPermanently: boolean
  readonly selectedExternalEditor: string | null
  readonly selectedShell: Shell | null
  readonly editors: ReadonlyArray<FoundEditor>
  readonly shells: ReadonlyArray<FoundShell>
  readonly loading: boolean
  readonly error: string | null
}

type PersistedPreferences = Pick<
  PreferencesState,
  | 'theme'
  | 'confirmRepositoryRemoval'
  | 'confirmDiscardChanges'
  | 'confirmDiscardChangesPermanently'
  | 'selectedExternalEditor'
  | 'selectedShell'
>

type PreferencesStoreDependencies = {
  readonly getAvailableEditors: typeof getAvailableEditors
  readonly getAvailableShells: typeof getAvailableShells
  readonly setTheme: (theme: ThemeSource) => Promise<void>
  readonly resolveSystemTheme: () => Promise<void>
}

const DefaultPreferences: PersistedPreferences = {
  theme: 'system',
  confirmRepositoryRemoval: true,
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  selectedExternalEditor: null,
  selectedShell: null,
}

function isTheme(value: unknown): value is ThemeSource {
  return value === 'light' || value === 'dark' || value === 'system'
}

function isShell(value: unknown): value is Shell {
  return (
    typeof value === 'string' &&
    (Object.values(Shell) as ReadonlyArray<string>).includes(value)
  )
}

function readBoolean(
  source: Record<string, unknown>,
  key: keyof PersistedPreferences,
  fallback: boolean
): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

function readPreferences(): PersistedPreferences {
  const raw = localStorage.getItem(PreferencesStorageKey)
  if (raw === null) {
    return DefaultPreferences
  }

  let source: unknown
  try {
    source = JSON.parse(raw)
  } catch {
    return DefaultPreferences
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return DefaultPreferences
  }

  const record = source as Record<string, unknown>
  return {
    theme: isTheme(record.theme) ? record.theme : DefaultPreferences.theme,
    confirmRepositoryRemoval: readBoolean(
      record,
      'confirmRepositoryRemoval',
      DefaultPreferences.confirmRepositoryRemoval
    ),
    confirmDiscardChanges: readBoolean(
      record,
      'confirmDiscardChanges',
      DefaultPreferences.confirmDiscardChanges
    ),
    confirmDiscardChangesPermanently: readBoolean(
      record,
      'confirmDiscardChangesPermanently',
      DefaultPreferences.confirmDiscardChangesPermanently
    ),
    selectedExternalEditor:
      typeof record.selectedExternalEditor === 'string'
        ? record.selectedExternalEditor
        : null,
    selectedShell: isShell(record.selectedShell) ? record.selectedShell : null,
  }
}

async function applyTheme(theme: ThemeSource): Promise<void> {
  await setNativeThemeSource(theme)
  if (theme === 'system') {
    await resolveSystemTheme()
  } else {
    document.documentElement.dataset.theme = theme
  }
}

async function resolveSystemTheme(): Promise<void> {
  document.documentElement.dataset.theme = (await shouldUseDarkColors())
    ? 'dark'
    : 'light'
}

export class PreferencesStore {
  private currentState: PreferencesState
  private readonly dependencies: PreferencesStoreDependencies
  private readonly listeners = new Set<(state: PreferencesState) => void>()

  public constructor(dependencies: Partial<PreferencesStoreDependencies> = {}) {
    this.currentState = {
      ...readPreferences(),
      editors: [],
      shells: [],
      loading: true,
      error: null,
    }
    this.dependencies = {
      getAvailableEditors,
      getAvailableShells,
      setTheme: applyTheme,
      resolveSystemTheme,
      ...dependencies,
    }
  }

  public get state(): PreferencesState {
    return this.currentState
  }

  public get selectedEditor(): FoundEditor | null {
    return (
      this.currentState.editors.find(
        editor => editor.editor === this.currentState.selectedExternalEditor
      ) ?? null
    )
  }

  public get selectedShell(): FoundShell | null {
    return (
      this.currentState.shells.find(
        shell => shell.shell === this.currentState.selectedShell
      ) ?? null
    )
  }

  public onDidUpdate(listener: (state: PreferencesState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async load(): Promise<void> {
    this.update({ ...this.currentState, loading: true, error: null })
    try {
      const [editors, shells] = await Promise.all([
        this.dependencies.getAvailableEditors(),
        this.dependencies.getAvailableShells(),
        this.dependencies.setTheme(this.currentState.theme),
      ])
      const selectedExternalEditor = editors.some(
        editor => editor.editor === this.currentState.selectedExternalEditor
      )
        ? this.currentState.selectedExternalEditor
        : (editors[0]?.editor ?? null)
      const selectedShell = shells.some(
        shell => shell.shell === this.currentState.selectedShell
      )
        ? this.currentState.selectedShell
        : (shells[0]?.shell ?? null)
      this.update({
        ...this.currentState,
        editors,
        shells,
        selectedExternalEditor,
        selectedShell,
        loading: false,
        error: null,
      })
      this.persist()
    } catch (error) {
      this.update({
        ...this.currentState,
        loading: false,
        error: String(error),
      })
    }
  }

  public async setTheme(theme: ThemeSource): Promise<void> {
    this.updateAndPersist({ theme })
    try {
      await this.dependencies.setTheme(theme)
    } catch (error) {
      this.update({ ...this.currentState, error: String(error) })
    }
  }

  public async refreshTheme(): Promise<void> {
    if (this.currentState.theme !== 'system') {
      return
    }
    try {
      await this.dependencies.resolveSystemTheme()
    } catch (error) {
      this.update({ ...this.currentState, error: String(error) })
    }
  }

  public setConfirmRepositoryRemoval(value: boolean): void {
    this.updateAndPersist({ confirmRepositoryRemoval: value })
  }

  public setConfirmDiscardChanges(value: boolean): void {
    this.updateAndPersist({ confirmDiscardChanges: value })
  }

  public setConfirmDiscardChangesPermanently(value: boolean): void {
    this.updateAndPersist({ confirmDiscardChangesPermanently: value })
  }

  public setSelectedExternalEditor(value: string | null): void {
    if (
      value !== null &&
      !this.currentState.editors.some(editor => editor.editor === value)
    ) {
      return
    }
    this.updateAndPersist({ selectedExternalEditor: value })
  }

  public setSelectedShell(value: Shell | null): void {
    if (
      value !== null &&
      !this.currentState.shells.some(shell => shell.shell === value)
    ) {
      return
    }
    this.updateAndPersist({ selectedShell: value })
  }

  private updateAndPersist(update: Partial<PersistedPreferences>): void {
    this.update({ ...this.currentState, ...update })
    this.persist()
  }

  private persist(): void {
    const {
      theme,
      confirmRepositoryRemoval,
      confirmDiscardChanges,
      confirmDiscardChangesPermanently,
      selectedExternalEditor,
      selectedShell,
    } = this.currentState
    localStorage.setItem(
      PreferencesStorageKey,
      JSON.stringify({
        theme,
        confirmRepositoryRemoval,
        confirmDiscardChanges,
        confirmDiscardChangesPermanently,
        selectedExternalEditor,
        selectedShell,
      } satisfies PersistedPreferences)
    )
  }

  private update(state: PreferencesState): void {
    this.currentState = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
