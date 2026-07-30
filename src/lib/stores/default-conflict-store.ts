import { ConflictStore } from './conflict-store'

let defaultConflictStore: ConflictStore | undefined

export function getDefaultConflictStore(): ConflictStore {
  defaultConflictStore ??= new ConflictStore()
  return defaultConflictStore
}
