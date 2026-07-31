import { invoke } from '@tauri-apps/api/core'
import type { AppleActionOnDoubleClick } from '../../models/apple-action-on-double-click'

export function getAppleActionOnDoubleClick(): Promise<AppleActionOnDoubleClick> {
  return invoke<AppleActionOnDoubleClick>('get_apple_action_on_double_click')
}
