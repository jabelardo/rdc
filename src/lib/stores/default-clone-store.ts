import { CloneStore } from './clone-store'

let defaultCloneStore: CloneStore | undefined

export function getDefaultCloneStore(): CloneStore {
  defaultCloneStore ??= new CloneStore()
  return defaultCloneStore
}
