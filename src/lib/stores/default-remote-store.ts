import { RemoteStore } from './remote-store'

let defaultRemoteStore: RemoteStore | undefined

export function getDefaultRemoteStore(): RemoteStore {
  defaultRemoteStore ??= new RemoteStore()
  return defaultRemoteStore
}
