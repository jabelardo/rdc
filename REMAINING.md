# Remaining work

**What this file is for.** `MIGRATION_PLAN.md` (~3,350 lines) and `MIGRATION_MAP.md` (~1,530 lines)
are the *historical record*: why each decision was made, what was measured, which upstream
assumptions turned out wrong. That content is worth keeping and worth reading — but roughly 250 of
those 4,900 lines describe work that is still open, and Phase 8b's QA cycle should not begin with
archaeology. This file is the open list only, and it links back rather than duplicating.

Keep it short. When something closes, delete the entry rather than annotating it — the plan and the
commit history already record what happened.

---

## Where the MVP stands

Phases 0–4, 5a, 6a and 7a–7e are closed. Phase 8a first closed on 2026-07-30, but the automated
frontier was deliberately reopened when formatter/linter enforcement and a Tailwind/component
architecture pass became pre-QA requirements. **The next work is autonomous; Phase 8b remains the
only human-blocked phase, but it must not start until the reopened 8a work closes again.**

| Gate | State |
|---|---|
| `pnpm test` (Vitest) | 939 passing |
| `pnpm exec tsc --noEmit` | clean |
| `pnpm format:check` / `pnpm lint` | clean |
| `cargo test --workspace` | 1,179 passing |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `pnpm test:e2e` (Linux container) | 22 tests / 14 suites passing |
| `pnpm qualify:phase8a` | green, `"errors": []` |

---

## Next autonomous work — close Phase 8a again

Complete the engineering items below, rerun every gate in the table, refresh the development builds
and update the recorded evidence. Tailwind migration and `App.tsx` decomposition are one coordinated
UI-architecture slice: splitting or restyling the monolith independently would churn the same view
and tests twice.

After that, the next phase is Phase 8b.

## Then: Phase 8b — human-assisted QA and refinement

An **iterative QA/fix cycle**, not an approval ceremony. Full description at
`MIGRATION_PLAN.md` §"Phase 8b"; prepared fixtures and checklists in `qa/phase-8b/`.

The loop: run the prepared checks against current macOS and real-Wayland Linux development builds →
fix every agreed MVP-blocking defect, adding automated regression coverage wherever the behaviour
can be pinned without human judgement → rerun the **complete** Phase 8a gate and repeat every
affected human check. Package **last**, only once no agreed blocker remains.

Human judgement is required for: visual refinement (hierarchy, density, alignment, empty/loading/
error states, diff readability) at normal and compact sizes in Light/Dark/System; the final icon,
bundle identifier and preview presentation (`org.rdc` and the current icon are explicitly
provisional); the native macOS pass, since WKWebView has no `tauri-driver` backend so the recorded
checklist *is* the evidence; and a real Ubuntu Wayland session to qualify rendering and the
`WEBKIT_DISABLE_COMPOSITING_MODE=1` mitigation outside the Xvfb harness.

**MVP exit criteria** are enumerated at `MIGRATION_PLAN.md` §"macOS/Linux MVP exit criteria" — seven
items, unchanged; do not restate them here, satisfy them there.

---

## Open engineering items

Ordered by cost.

**Sequencing matters here.** Items 1 and 2 rewrite the same components, so doing them in
one pass is much cheaper than in sequence: decompose `App.tsx` into components and style those
components with Tailwind together, rather than migrating a 2,166-line monolith to Tailwind and then
splitting it up. Both should precede the Phase 8b visual QA cycle — findings recorded against
a UI that is about to be restructured would have to be re-verified afterwards.

1. **Adopt Tailwind CSS and migrate the current UI.** Today styling is `src/App.css` plus the
   Phase 7e design tokens. Note two existing constraints: Phase 5a's production CSP allows
   `style-src 'unsafe-inline'` but no script eval, so a build-time Tailwind is fine while any
   runtime JIT is not; and `e2e/visual.test.mjs` asserts computed values (`13px` root font size,
   toolbar background differing from canvas, single-column grids at the compact breakpoint), so the
   token layer has to survive the migration or that spec must move with it.
2. **Decompose `src/App.tsx`.** 2,166 lines in a single component: 22 `useState`, 14 `useEffect`,
   zero `useCallback`/`useMemo`. The store layer beneath it is well factored and independently
   tested, so the logic is not trapped — the view is. Two consequences: every store update
   re-renders the whole workspace including the virtualized lists, and with no memoized callbacks
   each row gets fresh props, which is the cost `@tanstack/react-virtual` was added to avoid; and
   Phase 7f is written as "port components one by one", which presumes a component tree to port
   *into*. Suggested target: `App.tsx` becomes a composition root under ~200 lines, one component
   per sidebar/workspace region, stores consumed via `useSyncExternalStore`. `App.test.tsx` (1,778
   lines) is coupled to the monolith and will need to move with it — budget for that, it is the
   larger half of the work. Pair this with item 1 rather than doing either alone.
3. **One Windows body remains** — `custom_integration`'s `has_execute_access`. The three platform
   seams themselves are done (`AGENTS.md` rule 11): `rdc-printenvz`'s two arms now share a
   signature, `cli_installer`'s symlink is behind a per-OS `link` module with both arms real, and
   `custom_integration`'s unix code is in a gated inner module. What is left is a genuine Phase 10
   *decision*, flagged by a `compile_error!` rather than guessed: "executable" on Windows means
   `PATHEXT` membership or a DACL `AccessCheck`, not a mode bit. Adding it is additive.

---

## Carried debt

- **Legacy `url.parse()` — 8 sites** in `api.ts` (3), `find-account.ts` (3), `parse-app-url.ts` (1),
  `repository-matching.ts` (1). `DEP0169`, security-relevant, and the WHATWG `URL` migration is a
  strict behaviour change that needs its own change with tests as the guard. **None of these modules
  ships in the MVP bundle** (verified), so the deprecation warnings visible during `pnpm test` come
  from Vitest importing them, not from the application. Correct time to fix each: the phase that
  lands its consumer — Phase 5b for the API/account modules, Phase 9 for `parse-app-url`. The
  blocking browser bundle-boundary CI check is what keeps that deferral honest.
- **Node `path` in `lib/repository-matching.ts`** — same boundary, same guard.
- **OAuth callback still points at `https://desktop-plus.org/oauth`** (`lib/api.ts`). Unlike the
  User-Agent and About copy, this cannot simply be renamed: it needs an rdc-owned domain and a
  registered OAuth application. Phase 9, travelling with the GitHub sign-in consumer.
- **Two names are deliberately *not* rebranded**, because they are bytes inside a user's repository
  that other clients read: `git-ops`'s `STASH_ENTRY_MARKER` (`!!GitHub_Desktop`) and
  `models/remote.ts`'s `ForkedRemotePrefix` (`github-desktop-`). Both carry comments explaining why.
  See `MIGRATION_PLAN.md` principle 6 — config and UI are rdc's to choose, repository bytes are not.

---

## Post-MVP backlog

One line each; detail lives in the plan under the same heading.

| Phase | Scope |
|---|---|
| 5b | Authenticated media + GitHub collaboration (retires `update-accounts`) |
| 5c | Enterprise networking — PAC/proxy resolution, certificate trust. Highest architectural risk in the plan; no longer blocks the UI |
| 6b | Consent-aware crash/error reporting pipeline |
| 7f | UI and upstream parity: accounts, stashes, tags, advanced merge/rebase, worktrees, LFS, submodules, syntax-highlighted diffs, full xterm, spell checking |
| 9 | Public release engineering: signing, notarization, updater key/endpoint, single-instance/deep-link routing, OAuth callback, standalone CLI |
| 10 | Windows support — six work groups. `git-ops`'s library already compiles for `x86_64-pc-windows-msvc` and CI keeps it that way |

---

## Accepted gaps

- **No automated native-Wayland coverage.** The E2E harness is X11 (Xvfb) only, while current
  desktop environments are Wayland-only — so the rendering path most users hit has no automated
  test, and the mitigation is a blanket `WEBKIT_DISABLE_COMPOSITING_MODE=1`. Compensated by the
  Phase 8b real-Wayland checklist. This should be a named limitation in the MVP release notes, with
  a decision recorded for what happens if 8b finds Wayland-only defects.
- **No PAC/proxy or application-managed certificate trust** (Phase 5c). Remote operations must fail
  with actionable copy rather than pretending; MVP release notes should say so.
- **`models/popup.ts` and `models/repository.ts`** remain blocked on their consumers
  (`MIGRATION_MAP.md` §9); `models/popup.ts` additionally needs a certificate type from Rust.
