# Multi-window operation checklist

Created by `OPERATION_PROGRESS_PLAN.md` Slice 20. Everything here is about **what the screen says
when an operation and the window watching it are not the same window** — a question no automated
test can answer.

The behaviour underneath is already pinned. `e2e/operation-windows.test.mjs` proves that a second
window opens on the same repository, that a different repository stays independent, that a linked
worktree shares the repository lock, that peer remote writes are disabled while the owner commits,
and that a commit keeps running when its owner window closes. **Do not re-verify those facts here.**
Verify that a person who did not write the code can tell, from the screen alone, which window owns
the operation, why the other one cannot act, and what to do when the owner is gone.

Run on both macOS and real-Wayland Linux. Record window titles and which physical window you acted
in — "the other window" is not reproducible evidence.

## Fixtures

Generate one root and use three scenarios from it:

| Row group | Scenario | Why |
|---|---|---|
| Peer window, owner-window loss | `multiWindowPushA` | 20-second push window: long enough to switch windows, read both, and close one |
| Two repositories at once | `multiWindowPushA` + `multiWindowPushB` | Two independent repositories with two independent remotes, so the operations cannot contend for one lock |

`delayedPush`'s three seconds is deliberately **not** enough for any row here. If a row asks you to
hurry, you are using the wrong scenario.

## 1. Peer window — an operation started somewhere else

Open `multiWindowPushA` in two windows. Start Push in window A. While it runs, read window B.

- [ ] **Window B says where the operation came from.** It reads "Started in another window" rather
      than presenting the operation as if B owned it.
- [ ] **Window B offers no controls.** No Cancel, no adopt. A peer that appears able to cancel and
      then does nothing is worse than a peer that shows nothing.
- [ ] **Window B's own actions are refused, visibly.** Fetch/Push/Pull are disabled, and it is
      apparent *why* — a disabled button with no explanation reads as a bug.
- [ ] **Window A is unambiguously the owner.** Its progress presentation is the full one, with the
      cancellation the operation supports.
- [ ] **Both windows reach the same end.** When the push completes, A and B agree on the outcome,
      and B's controls re-enable without needing a manual refresh.
- [ ] **Light and Dark** on both windows, and at a compact width on at least one.

## 2. Owner-window loss — the operation outlives its window

Open `multiWindowPushA` in two windows. Start Push in window A. **Close window A while it runs.**

- [ ] **The operation continues.** Nothing in window B suggests it was cancelled by the close.
- [ ] **Window B explains the new situation.** It reads "The window that started this operation is
      no longer open" — the state has a name, and it is not "something went wrong".
- [ ] **Window B is now offered "Take control and cancel".** Confirm the label makes sense to
      someone who did not read this plan: it must be clear that taking control is what enables
      cancelling, not a second thing to do afterwards.
- [ ] **Taking control actually works.** Use it. The operation cancels, and window B then presents
      the cancellation outcome as an owner would.
- [ ] **Repeat without taking control**: let the push finish on its own. Window B reports the
      outcome; the repository is not left locked.
- [ ] Verify with `git --git-dir=<multiWindowPushA remote> rev-parse refs/heads/publish-me` that the
      remote's state matches what the screen claimed in each case.

## 3. Two repositories, two windows, at once

Open `multiWindowPushA` in window A and `multiWindowPushB` in window B. Start Push in **both**.

- [ ] **Neither blocks the other.** Both progress at once; neither waits for the other's lock. This
      is the row that proves the lock is repository-scoped rather than global — if one window sits
      idle until the other finishes, stop and report it.
- [ ] **Each window shows its own operation only.** No cross-talk: window A never shows B's
      progress, and neither reports the other's completion.
- [ ] **Each is an owner.** Both offer cancellation for their own operation and neither offers it
      for the other's.
- [ ] Cancel one and let the other finish. The cancelled repository reports cancellation; the other
      reports success. Verify both remotes with `rev-parse`.

## 4. Linked worktree — one repository, two paths

`e2e` proves a linked worktree shares the repository lock. What it cannot judge is whether that
sharing is *comprehensible*.

- [ ] Open a repository and one of its linked worktrees in two windows, and start an operation in
      one. The other window must make clear that it is blocked by the *same repository*, not by an
      unrelated failure — two different paths on screen, one shared lock, and the explanation has to
      bridge that.

## 5. Process-tree termination — Linux and macOS

Slice 20 item 6. Windows is governed by the Phase 10 target and is out of scope here; its seam must
compile when introduced.

- [ ] Start the `multiWindowPushA` push and cancel it. The fixture builds the tree this row needs:
      pushing to a local bare remote runs `git push` → `git receive-pack` → the `pre-receive` hook →
      `sleep 20`, so the thing that must die is a **grandchild**, not the process rdc spawned. While
      the push runs, confirm all of them exist:

      ```sh
      pgrep -af 'receive-pack|sleep 20'
      ```

      Then cancel, and confirm the same command prints nothing. An orphaned `sleep 20` is exactly
      the failure this row exists to catch, and it is invisible from the UI — the dialog reports
      cancellation either way.
- [ ] Confirm the repository is usable immediately afterwards: no stale `index.lock`, and an
      ordinary Fetch succeeds without a manual unlock.
