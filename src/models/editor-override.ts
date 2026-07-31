import { ICustomIntegration } from './custom-integration'

export type EditorOverride = {
  selectedExternalEditor: string | null
  useCustomEditor: boolean
  customEditor: ICustomIntegration | null
}

export function getEditorOverrideLabel(
  editorOverride: EditorOverride
): string | undefined {
  return editorOverride.useCustomEditor
    ? undefined
    : (editorOverride.selectedExternalEditor ?? undefined)
}
