# Code organization — establishing a structure worth defending

**Status**: **closed 2026-08-16.** The questions below are answered by
[`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md), which is the guideline and the migration plan.
This document stays as the evidence that produced it — the measurements, and the reasoning about
what the reachability numbers do and do not prove. Scheduled **after** the dialog migration
completed, so it moves settled code rather than code still in flight. Raised by Jose on 2026-08-07: the dialogs sit at paths with no
discernible pattern — not by feature, not by component type, not by anything — and "not only dialogs
are disorganized."

This document exists to hold the evidence while it is fresh. **It decides nothing.** The point of
gathering the inventory now is that the later analysis starts from measurements instead of
impressions.

## Why it matters here specifically

`MIGRATION_PLAN.md` principle: rdc is a greenfield architecture, and the stated goal is *"a clear
architecture an open-source collaborator can easily pick up"* once the project takes contributions
post-MVP. Layout is the first thing such a person meets. It is also the cheapest thing to fix before
there are contributors and the most expensive after.

`ARCHITECTURE.md` is deferred to post-MVP. This work is its prerequisite: there is no point
documenting a structure nobody chose.

## What is actually there — measured 2026-08-07

### Dialogs live in four places

| Path | What is there | Why |
|---|---|---|
| `src/components/ui/` | `dialog.tsx`, `alert-dialog.tsx` | Vendored shadcn primitives. Correct — these must stay where the shadcn CLI writes them, or `shadcn add` stops being diffable. |
| `src/lib/ui/dialogs/` | `confirm-dialog.tsx`, `notice-dialog.tsx`, `rename-branch-dialog.tsx`, `dialog-actions.tsx`, `dialog-message.tsx`, `discard-file-list.tsx`, `confirm-opt-out.tsx` | rdc's own dialog layer. Created during the shadcn migration. |
| `src/lib/ui/app/app-dialogs.tsx` | Eight dialogs still inline, ~850 lines | The pre-migration home. Shrinking as each dialog is extracted. |
| `src/lib/ui/` | `modal.tsx`, `branch-select.tsx` | The hand-rolled modal being replaced, and a picker used only by a dialog. |

The split is chronological, not architectural: where a thing lives records *when* it was written.

### `src/lib/` is a 110-file flat drawer

One directory mixes, with no subdivision:

- pure helpers (`clamp.ts`, `round.ts`, `compare.ts`, `enum.ts`, `promise.ts`)
- IPC wrappers (`git-ipc.ts`, `diff-ipc.ts`, `remote-ipc.ts`, `stash-ipc.ts`, … nine of them)
- domain logic (`discard-changes.ts`, `rev-range.ts`, `sanitize-ref-name.ts`, `validate-branch-name.ts`)
- formatting (`format-error.ts`, `format-number.ts`, `format-relative.ts`, `format-duration.ts`)
- GitHub-service code from desktop-plus (`api.ts`, `find-account.ts`, `http.ts`, `endpoint-capabilities.ts`)

alongside subdirectories that *are* grouped (`stores/`, `platform/`, `menu/`, `logging/`,
`resilience/`, `debug/`). So the codebase already demonstrates two conventions at once and follows
neither consistently.

### 95 of 237 non-test modules are unreachable from `src/main.tsx`

Measured by reusing `scripts/check-bundle-boundary.mjs`'s AST traversal.

**Read that number carefully.** The traversal follows runtime imports only, because `import type` is
erased at build time. That makes it exactly right for the bundle-boundary check it was written for,
and it means **`src/models/` — 46 of the 95 — is largely a false positive**: a module imported only
for its types is genuinely absent from the bundle and genuinely still in use. Do not delete on this
number alone.

The 30 unreachable files directly under `src/lib/` are the real finding, and spot-checking confirms
they are unreferenced rather than type-only:

- `refs.ts`, `create-branch.ts`, `rebase.ts` — no non-test importer at all.
- `clamp.ts` — imported only by `rebase.ts`, which is itself unused. Transitively dead.
- `api.ts` — imported only by `models/account.ts`, `dot-com-bots.ts`, `owner.ts`, all themselves
  unreachable. A self-contained dead cluster.

They fall into three groups, and the groups want different answers:

1. **GitHub-service and Electron-era code rdc may never need** — `api.ts`, `http.ts`,
   `http-status-code.ts`, `endpoint-capabilities.ts`, `find-account.ts`, `email.ts`,
   `pull-request-refs.ts`, `parse-app-url.ts`, `parse-pac-string.ts`, `repository-matching.ts`,
   `suppress-certificate-error.ts`, `squirrel-error-parser.ts` (Electron's updater), `welcome.ts`,
   `copilot-commit-message.ts`, `copilot-error.ts`, `custom-integration.ts`.
2. **Ported ahead of a planned feature** — `create-branch.ts`, `rebase.ts`, `refs.ts`,
   `multi-commit-operation.ts`, `worktree-ipc.ts`, `conventional-commits.ts`, `text-token-parser.ts`,
   `wrap-rich-text-commit-message.ts`, `emoji.ts`, `diff-hunks.ts`.
3. **Utilities with no caller yet** — `clamp.ts`, `format-duration.ts`, `offset-from.ts`,
   `promise.ts`.

None of this is broken: most carry tests and the bundle-boundary check already proves none of it
reaches the webview. The cost is navigational. A newcomer reading `src/lib/` cannot tell which third
of it the app actually runs, and neither can a search.

## Questions to settle, none of them now

1. **By feature, by type, or a hybrid?** The honest options are feature-first
   (`src/features/branches/{store,dialogs,ipc}`), type-first (`src/{stores,dialogs,ipc,domain}`), or
   type-first at the top with feature grouping inside the large ones. rdc's existing
   `stores/ platform/ menu/` are type-first; the dialog layer is drifting feature-ward.
2. **Where does a dialog live** — beside the feature it serves, or in one dialog layer? This is the
   question that started it, and it is a special case of (1).
3. **What happens to the unreachable third?** Delete, or quarantine somewhere explicitly marked as
   not-yet-wired. Deleting is reversible through git history; keeping it unmarked is what makes the
   drawer unreadable. Groups 1 and 2 above plausibly get different answers.
4. **Is the rule enforceable?** A convention no check defends decays — this repository has watched
   that happen twice already (the two token vocabularies, the lucide/FontAwesome split that was
   "the rule" for one hour). Prefer a structure a script can assert over one that relies on
   discipline. `scripts/check-bundle-boundary.mjs` is the model.
5. **`src/lib/ui/` versus `src/components/`.** Vendored shadcn output must stay under
   `src/components/ui/`. Whether rdc's own components belong beside it or under `src/lib/ui/` is
   open, and the answer should make the vendored/authored boundary obvious at a glance.

## How to approach it

Survey how comparable projects lay this out before choosing — the request was explicitly to
*"analyse best practices"*, not to invent a scheme. Worth reading: desktop-plus's own layout (rdc
inherited its shape without inheriting its scale), and a couple of current Tauri/React applications
of similar size.

Then do it as one mechanical move with no behaviour change, gated by the full suite, so the diff is
reviewable as pure motion. Splitting it across feature work is how a reorganization ends up
half-applied — which is the state being fixed.
