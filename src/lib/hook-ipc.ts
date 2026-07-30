/**
 * The hook side of the IPC boundary.
 *
 * A git hook is a script the user wrote, and it assumes the environment their *terminal* has — a version
 * manager on `PATH`, tool shims, `~/.local/bin`. A desktop application inherits none of that, so a hook
 * that works in a terminal fails when git is run by the app. `crates/git-ops/src/hooks/**` fixes that by
 * running the hook itself, with an environment loaded from the user's login shell; these are the types and
 * the one command that go with it.
 *
 * # Which hooks are intercepted is not the caller's choice
 *
 * It is a property of the git command being run: a commit reaches `pre-commit` and `commit-msg`, an
 * `--amend` also reaches `post-rewrite`, a push reaches only `pre-push`. So an operation passes
 * `interceptHooks: true` and the Rust side names the hooks. Passing a list here would let a caller ask for
 * something git will never run — or, worse, forget one it will.
 */

import { Channel, invoke } from '@tauri-apps/api/core'

/** Where a hook is in its life. Matches the original's `onHookProgress` status strings. */
export type HookStatus = 'started' | 'finished' | 'failed'

/** A hook starting, finishing or failing. */
export interface IHookProgress {
  /**
   * Identifies this run of this hook.
   *
   * Present on every update so a start can be matched to its end. Pass it to {@linkcode abortHook} to stop
   * a hook that is taking too long — the Rust side holds the handle, because a callback cannot cross IPC.
   */
  readonly id: number

  /** The hook's name, e.g. `pre-commit`. */
  readonly hook: string

  readonly status: HookStatus
}

export type HookFailureResolution = 'abort' | 'ignore'

/** A failed hook waiting for the user's decision. */
export interface IHookFailurePrompt {
  readonly id: number
  readonly hook: string
  readonly terminalOutput: string
}

export type HookFailureCallback = (
  hook: string,
  terminalOutput: string
) => Promise<HookFailureResolution>

/**
 * Stops a hook that is still running.
 *
 * Resolves to `false` when the hook had already ended, which is not an error: the user cancelled a moment
 * too late and the operation carried on.
 *
 * Kills the `git hook run` process. A hook that spawned children of its own may leave them running — the
 * same limitation the original's `AbortController` had.
 */
export async function abortHook(id: number): Promise<boolean> {
  return invoke<boolean>('abort_hook', { id })
}

/** Answers a failed-hook prompt. A stale prompt resolves to `false`. */
export async function resolveHookFailure(
  id: number,
  resolution: HookFailureResolution
): Promise<boolean> {
  return invoke<boolean>('resolve_hook_failure', { id, resolution })
}

/**
 * Creates the response Channel used by every hook-capable operation.
 *
 * Missing callbacks and callback failures abort conservatively. In particular, Rust must never wait
 * forever merely because a caller enabled interception but forgot to install a prompt.
 */
export function hookFailureChannel(
  onFailure?: HookFailureCallback
): Channel<IHookFailurePrompt> {
  return new Channel<IHookFailurePrompt>(prompt => {
    void Promise.resolve<HookFailureResolution>(
      onFailure?.(prompt.hook, prompt.terminalOutput) ?? 'abort'
    )
      .catch((): HookFailureResolution => 'abort')
      .then(resolution =>
        resolveHookFailure(prompt.id, resolution)
      )
  })
}
