import { invoke } from '@tauri-apps/api/core'

export function isInApplicationFolder(): Promise<boolean | null> {
  return invoke<boolean | null>('is_in_application_folder')
}

export function moveToApplicationsFolder(): Promise<void> {
  return invoke('move_to_applications_folder')
}
