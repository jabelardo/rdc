import { WorkingTreeStore } from './working-tree-store'

let defaultWorkingTreeStore: WorkingTreeStore | undefined

export function getDefaultWorkingTreeStore(): WorkingTreeStore {
  defaultWorkingTreeStore ??= new WorkingTreeStore()
  return defaultWorkingTreeStore
}
