import { PreferencesStore } from './preferences-store'

let defaultStore: PreferencesStore | undefined

/** One preferences owner per webview, backed by origin-scoped persistence. */
export function getDefaultPreferencesStore(): PreferencesStore {
  defaultStore ??= new PreferencesStore()
  return defaultStore
}
