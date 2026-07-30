const knownThirdPartyHosts = new Set([
  'dev.azure.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'amazonaws.com',
  'visualstudio.com',
])

export function isKnownThirdPartyHost(hostname: string): boolean {
  for (const knownHost of knownThirdPartyHosts) {
    if (hostname === knownHost || hostname.endsWith(`.${knownHost}`)) {
      return true
    }
  }
  return false
}

/** Determines whether a remote URL is safe to expose as an external link. */
export function isTrustedRemoteHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'https:') {
      return false
    }
    if (
      hostname === 'github.com' ||
      hostname.endsWith('.github.com')
    ) {
      return true
    }
    return isKnownThirdPartyHost(hostname)
  } catch {
    return false
  }
}
