import { BranchStore } from './branch-store'

let defaultBranchStore: BranchStore | undefined

export function getDefaultBranchStore(): BranchStore {
  defaultBranchStore ??= new BranchStore()
  return defaultBranchStore
}
