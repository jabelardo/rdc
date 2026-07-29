import { beforeEach, describe, expect, it, vi } from 'vitest'
import snapshot from './__generated__/wire-snapshot.json'
import type { IHookProgress } from './hook-ipc'

/**
 * Checks the hook boundary.
 *
 * Two things here are load bearing beyond field-matching: the status strings are the original's
 * (`'started' | 'finished' | 'failed'`, so ported UI code comparing against them keeps working), and every
 * update carries an `id` — because the abort handle the original passed to the UI as a *function* cannot
 * cross IPC, so it is looked up by id on the Rust side instead.
 */
const invoke = vi.hoisted(() => vi.fn())
const channelInstances = vi.hoisted(() => [] as Array<{ handler?: unknown }>)

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    public handler?: unknown
    public constructor(handler?: unknown) {
      this.handler = handler
      channelInstances.push(this)
    }
  },
}))

const { abortHook } = await import('./hook-ipc')
const { createCommit, mergeBranch } = await import('./git-ipc')
const { push, pull } = await import('./remote-ipc')

const REPO = '/tmp/repo'

describe('the hook progress shape', () => {
  // Annotated, not cast: assignability to the ported type is the check.
  const progress: IHookProgress = snapshot.hookProgress as IHookProgress

  it('uses the status strings the original used', () => {
    expect(progress.status).toBe('started')
    // A ported UI comparing against these strings must keep working, which is why they aren't an enum.
    const statuses: ReadonlyArray<IHookProgress['status']> = [
      'started',
      'finished',
      'failed',
    ]
    expect(statuses).toContain(progress.status)
  })

  it('carries an id, because an abort callback cannot cross IPC', () => {
    expect(typeof progress.id).toBe('number')
    expect(progress.hook).toBe('pre-commit')
  })
})

describe('asking for interception', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    channelInstances.length = 0
  })

  it('createCommit leaves interception off when nothing asks for it', async () => {
    // The conservative default: git still runs the hooks itself, exactly as without rdc.
    await createCommit(REPO, 'message', [])

    expect(invoke).toHaveBeenCalledWith(
      'create_commit',
      expect.objectContaining({ interceptHooks: false })
    )
  })

  it('createCommit sends a Channel even when nothing listens', async () => {
    // The Rust side takes one unconditionally, so its absence would be a deserialization error rather
    // than a quietly unreported hook.
    await createCommit(REPO, 'message', [])

    expect(channelInstances).toHaveLength(1)
    expect(channelInstances[0].handler).toBeUndefined()
  })

  it('createCommit forwards the progress callback when interception is on', async () => {
    const onHookProgress = vi.fn()

    await createCommit(REPO, 'message', [], undefined, {
      interceptHooks: true,
      onHookProgress,
    })

    expect(invoke).toHaveBeenCalledWith(
      'create_commit',
      expect.objectContaining({ interceptHooks: true })
    )
    expect(channelInstances[0].handler).toBe(onHookProgress)
  })

  it('does not take a list of hooks from the caller', async () => {
    // Which hooks an operation reaches is a property of the git command, not of the caller — `--amend`
    // reaches `post-rewrite` and a plain commit does not. Sending a list would let a caller ask for
    // something git never runs, or miss one it does.
    await createCommit(REPO, 'message', [], undefined, { interceptHooks: true })

    const [, args] = invoke.mock.calls[0]
    expect(Object.keys(args)).not.toContain('hooks')
    expect(Object.keys(args)).not.toContain('interceptedHooks')
  })

  it('mergeBranch, push and pull all accept it', async () => {
    // The four operations upstream intercepts in. `rebase` deliberately is not one of them.
    await mergeBranch(REPO, 'topic', undefined, { interceptHooks: true })
    expect(invoke).toHaveBeenLastCalledWith(
      'merge_branch',
      expect.objectContaining({ interceptHooks: true })
    )

    await push(REPO, 'origin', 'main', null, [], {}, undefined, false, {
      interceptHooks: true,
    })
    expect(invoke).toHaveBeenLastCalledWith(
      'push',
      expect.objectContaining({ interceptHooks: true })
    )

    await pull(REPO, 'origin', undefined, false, false, { interceptHooks: true })
    expect(invoke).toHaveBeenLastCalledWith(
      'pull',
      expect.objectContaining({ interceptHooks: true })
    )
  })

  it('abortHook sends the id and reports whether it landed', async () => {
    invoke.mockResolvedValue(false)

    await expect(abortHook(7)).resolves.toBe(false)
    expect(invoke).toHaveBeenCalledWith('abort_hook', { id: 7 })
  })
})
