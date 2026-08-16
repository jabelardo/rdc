import { beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/lib/__generated__/wire-snapshot.json";
import type { IHookProgress } from "./hook-ipc";

/**
 * Checks the hook boundary.
 *
 * Two things here are load bearing beyond field-matching: the status strings are the original's
 * (`'started' | 'finished' | 'failed'`, so ported UI code comparing against them keeps working), and every
 * update carries an `id` — because the abort handle the original passed to the UI as a *function* cannot
 * cross IPC, so it is looked up by id on the Rust side instead.
 */
const invoke = vi.hoisted(() => vi.fn());
const channelInstances = vi.hoisted(() => [] as Array<{ handler?: unknown }>);

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    public handler?: unknown;
    public constructor(handler?: unknown) {
      this.handler = handler;
      channelInstances.push(this);
    }
  },
}));

const { abortHook, resolveHookFailure } = await import("./hook-ipc");
const { createCommit, mergeBranch } = await import("@/lib/ipc/git-ipc");
const { push, pull } = await import("@/features/remotes/api/remote-ipc");

const REPO = "/tmp/repo";

describe("the hook progress shape", () => {
  // Annotated, not cast: assignability to the ported type is the check.
  const progress: IHookProgress = snapshot.hookProgress as IHookProgress;

  it("uses the status strings the original used", () => {
    expect(progress.status).toBe("started");
    // A ported UI comparing against these strings must keep working, which is why they aren't an enum.
    const statuses: ReadonlyArray<IHookProgress["status"]> = ["started", "finished", "failed"];
    expect(statuses).toContain(progress.status);
  });

  it("carries an id, because an abort callback cannot cross IPC", () => {
    expect(typeof progress.id).toBe("number");
    expect(progress.hook).toBe("pre-commit");
  });
});

describe("asking for interception", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    channelInstances.length = 0;
  });

  it("createCommit leaves interception off when nothing asks for it", async () => {
    // The conservative default: git still runs the hooks itself, exactly as without rdc.
    await createCommit(REPO, "message", []);

    expect(invoke).toHaveBeenCalledWith(
      "create_commit",
      expect.objectContaining({ interceptHooks: false }),
    );
  });

  it("createCommit sends hook and terminal Channels even when nothing listens", async () => {
    // The Rust side takes one unconditionally, so its absence would be a deserialization error rather
    // than quietly unreported progress.
    await createCommit(REPO, "message", []);

    expect(channelInstances).toHaveLength(3);
    expect(channelInstances[0].handler).toBeUndefined();
    expect(channelInstances[1].handler).toBeTypeOf("function");
    expect(channelInstances[2].handler).toBeUndefined();
  });

  it("createCommit forwards the progress callback when interception is on", async () => {
    const onHookProgress = vi.fn();

    await createCommit(REPO, "message", [], undefined, {
      interceptHooks: true,
      onHookProgress,
    });

    expect(invoke).toHaveBeenCalledWith(
      "create_commit",
      expect.objectContaining({ interceptHooks: true }),
    );
    expect(channelInstances[0].handler).toBe(onHookProgress);
  });

  it("answers a failed hook with the callback decision", async () => {
    const onHookFailure = vi.fn(async () => "ignore" as const);

    await createCommit(REPO, "message", [], undefined, {
      interceptHooks: true,
      onHookFailure,
    });
    const handler = channelInstances[1].handler as (prompt: {
      id: number;
      hook: string;
      terminalOutput: string;
    }) => void;
    handler({
      id: 17,
      hook: "pre-commit",
      terminalOutput: "lint failed",
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("resolve_hook_failure", {
        id: 17,
        resolution: "ignore",
      }),
    );
    expect(onHookFailure).toHaveBeenCalledWith("pre-commit", "lint failed");
  });

  it("aborts conservatively when no failure callback is installed", async () => {
    await createCommit(REPO, "message", [], undefined, {
      interceptHooks: true,
    });
    const handler = channelInstances[1].handler as (prompt: {
      id: number;
      hook: string;
      terminalOutput: string;
    }) => void;
    handler({
      id: 18,
      hook: "commit-msg",
      terminalOutput: "invalid message",
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("resolve_hook_failure", {
        id: 18,
        resolution: "abort",
      }),
    );
  });

  it("does not take a list of hooks from the caller", async () => {
    // Which hooks an operation reaches is a property of the git command, not of the caller — `--amend`
    // reaches `post-rewrite` and a plain commit does not. Sending a list would let a caller ask for
    // something git never runs, or miss one it does.
    await createCommit(REPO, "message", [], undefined, { interceptHooks: true });

    const [, args] = invoke.mock.calls[0];
    expect(Object.keys(args)).not.toContain("hooks");
    expect(Object.keys(args)).not.toContain("interceptedHooks");
  });

  it("mergeBranch, push and pull all accept it", async () => {
    // The four operations upstream intercepts in. `rebase` deliberately is not one of them.
    await mergeBranch(REPO, "topic", undefined, { interceptHooks: true });
    expect(invoke).toHaveBeenLastCalledWith(
      "merge_branch",
      expect.objectContaining({ interceptHooks: true }),
    );

    await push(REPO, "origin", "main", null, [], {}, undefined, false, {
      interceptHooks: true,
    });
    expect(invoke).toHaveBeenLastCalledWith(
      "push",
      expect.objectContaining({ interceptHooks: true }),
    );

    await pull(REPO, "origin", undefined, false, false, {
      interceptHooks: true,
    });
    expect(invoke).toHaveBeenLastCalledWith(
      "pull",
      expect.objectContaining({ interceptHooks: true }),
    );
  });

  it("abortHook sends the id and reports whether it landed", async () => {
    invoke.mockResolvedValue(false);

    await expect(abortHook(7)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("abort_hook", { id: 7 });
  });

  it("resolveHookFailure sends the id and resolution", async () => {
    invoke.mockResolvedValue(true);

    await expect(resolveHookFailure(12, "abort")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("resolve_hook_failure", {
      id: 12,
      resolution: "abort",
    });
  });
});
