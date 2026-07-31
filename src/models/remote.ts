/**
 * This is the magic remote name prefix
 * for when we add a remote on behalf of
 * the user.
 *
 * **Deliberately not rebranded**, for the same reason as `git-ops`'s `STASH_ENTRY_MARKER`: this
 * prefix is written into the user's `.git/config` as a real remote name, and it is how a client
 * recognises a remote it created on the user's behalf rather than one the user added. Renaming it
 * to `rdc-` would make every remote created by another client look user-added here, and every
 * remote rdc creates look user-added there. Product names in the UI and on the wire are rdc's to
 * choose; bytes inside someone's repository are not — see MIGRATION_PLAN.md principle 6.
 */
export const ForkedRemotePrefix = 'github-desktop-'

export function forkPullRequestRemoteName(remoteName: string) {
  return `${ForkedRemotePrefix}${remoteName}`
}

/** A remote as defined in Git. */
export interface IRemote {
  readonly name: string
  readonly url: string
}

/**
 * Gets a value indicating whether two remotes can be considered
 * structurally equivalent to each other.
 */
export function remoteEquals(x: IRemote | null, y: IRemote | null) {
  if (x === y) {
    return true
  }

  if (x === null || y === null) {
    return false
  }

  return x.name === y.name && x.url === y.url
}
