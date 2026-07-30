import { HistoryStore } from './history-store'

let defaultHistoryStore: HistoryStore | undefined

export function getDefaultHistoryStore(): HistoryStore {
  defaultHistoryStore ??= new HistoryStore()
  return defaultHistoryStore
}
