/**
 * Parsing OpenSSH's "authenticity of host … can't be established" prompt.
 *
 * MIGRATION NOTE (layering fix): in desktop-plus this function lived at the bottom of
 * `lib/ssh/ssh.ts`, whose *other* export (`getSSHEnvironment`) imports the trampoline paths and
 * `pathExists` — so a pure regex parser sat behind `fs` and the whole trampoline module. That is why
 * `ssh-test.ts`, which tests **only** this function, was blocked.
 *
 * `getSSHEnvironment` belongs with the trampoline/shell work (it produces `SSH_ASKPASS` and
 * `GIT_SSH_COMMAND` pointing at the trampoline binary); this is just text parsing.
 */

/** What OpenSSH told us about an unknown host. */
export interface IAddSSHHostPrompt {
  readonly host: string
  readonly ip: string
  readonly keyType: string
  readonly fingerprint: string
}

/**
 * Extracts the host, IP, key type and fingerprint from OpenSSH's host-key confirmation prompt, or
 * `null` if the text isn't that prompt.
 *
 * The prompt's middle line varies — OpenSSH may add "but keys of different type are already known
 * for this host" or "This key is not known by any other names" — and the trailing question may or
 * may not offer `[fingerprint]`. The pattern therefore anchors on the two lines that carry the data
 * and tolerates whatever sits between and after them.
 */
export function parseAddSSHHostPrompt(
  prompt: string
): IAddSSHHostPrompt | null {
  const promptRegex =
    /^The authenticity of host '([^ ]+) \(([^)]+)\)' can't be established[^.]*\.\n([^ ]+) key fingerprint is ([^.]+)\./

  const matches = promptRegex.exec(prompt)
  if (matches === null || matches.length < 5) {
    return null
  }

  return {
    host: matches[1],
    ip: matches[2],
    keyType: matches[3],
    fingerprint: matches[4],
  }
}
