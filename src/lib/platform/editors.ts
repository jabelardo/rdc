import { invoke } from '@tauri-apps/api/core'
import type {
  ICustomIntegration,
  ICustomIntegrationPathValidation,
} from '../../models/custom-integration'
import type { FoundEditor } from '../../models/editor'

/**
 * Resolve supported editors installed on this machine.
 *
 * Discovery belongs in Rust because it reads the filesystem (and, on macOS, application metadata).
 * Keep the upstream function name so Phase 7 consumers can switch imports without changing behavior.
 */
export function getAvailableEditors(): Promise<ReadonlyArray<FoundEditor>> {
  return invoke<ReadonlyArray<FoundEditor>>('get_available_editors')
}

export function validateCustomIntegrationPath(
  path: string
): Promise<ICustomIntegrationPathValidation> {
  return invoke<ICustomIntegrationPathValidation>(
    'validate_custom_integration_path',
    { path }
  )
}

export function isValidCustomIntegration(
  customIntegration: ICustomIntegration
): Promise<boolean> {
  return invoke<boolean>('is_valid_custom_integration', { customIntegration })
}

export function launchExternalEditor(
  fullPath: string,
  editor: FoundEditor
): Promise<void> {
  return invoke('launch_external_editor', { fullPath, editor })
}

export function launchCustomExternalEditor(
  fullPath: string,
  customEditor: ICustomIntegration
): Promise<void> {
  return invoke('launch_custom_external_editor', {
    fullPath,
    customEditor,
  })
}
