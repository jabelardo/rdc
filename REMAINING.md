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

Phases 0–4, 5a, 6a, 7a–7e and 8a are closed. Phase 8a first closed on 2026-07-30 and closed again
after its 2026-07-31 pre-QA follow-up added mechanical Node/bundle/format/lint/Windows-portability
guards, independent E2E suites, Tailwind and a component-owned application shell. **Phase 8b is now
the next MVP phase and the only human-blocked phase.**

| Gate | State |
|---|---|
| `pnpm test` (Vitest) | 941 passing |
| `pnpm exec tsc --noEmit` | clean |
| `pnpm format:check` / `pnpm lint` | clean |
| `pnpm build` / `pnpm check:bundle-boundary` | clean; 108 browser-reachable modules, no Node built-ins |
| `cargo test --workspace` | 1,180 passing |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| Windows `git-ops --all-targets` compile guard | clean |
| `pnpm test:e2e` (Linux container) | 23 tests / 14 suites passing |
| `pnpm qualify:phase8a` | green, `"errors": []` |

---

## Next: Phase 8b — human-assisted QA and refinement

An **iterative QA/fix cycle**, not an approval ceremony. Full description at
`MIGRATION_PLAN.md` §"Phase 8b"; prepared fixtures and checklists in `qa/phase-8b/`.

The loop: run the prepared checks against current macOS and real-Wayland Linux development builds →
fix every agreed MVP-blocking defect, adding automated regression coverage wherever the behaviour
can be pinned without human judgement → rerun the **complete** Phase 8a gate and repeat every
affected human check. Package **last**, only once no agreed blocker remains.

Cycle one now has two explicit foundation levels. The shell/empty-state gate in
`qa/phase-8b/baseline-layout-checklist.md` was accepted on macOS on 2026-07-31 after three annotated
refinement rounds. **Next:** with the populated `primary` fixture, complete Gate A then Gate B in
`qa/phase-8b/selected-repository-baseline-checklist.md` to settle repository/branch context, toolbar
and navigation hierarchy, then the Changes/History frame. Only after both pass should macOS enter the
visual matrix and functional checklist. Linux repeats all foundation gates in real-Wayland QA; the
macOS result is a reference, not transferable evidence. Windows repeats them in Phase 10.

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

1. **One Windows body remains** — `custom_integration`'s `has_execute_access`. The three platform
   seams themselves are done (`AGENTS.md` rule 11): `rdc-printenvz`'s two arms now share a
   signature, `cli_installer`'s symlink is behind a per-OS `link` module with both arms real, and
   `custom_integration`'s unix code is in a gated inner module. What is left is a genuine Phase 10
   *decision*, flagged by a `compile_error!` rather than guessed: "executable" on Windows means
   `PATHEXT` membership or a DACL `AccessCheck`, not a mode bit. Adding it is additive.

---

## Carried debt

- **Tailwind 4 debug CSS source maps are incomplete.** A debug Tauri/Vite build emits Rolldown's
  `Sourcemap is likely to be incorrect` warning for `@tailwindcss/vite:generate:build` when
  `src/App.css` contains real Tailwind roots. The production build is quiet, the generated JavaScript
  map was traced back to both `App.tsx` and `use-app-controller.ts`, and application output is
  unaffected; the missing fidelity is CSS-to-source mapping in development tools. Enabling
  `css.devSourcemap` only moves the warning to Vite's CSS transform and emits no usable standalone
  CSS map, so do not suppress the warning or disable the working JavaScript maps. Recheck after
  Tailwind/Vite/Rolldown upgrades; upstream context is Tailwind
  [discussion #16119](https://github.com/tailwindlabs/tailwindcss/discussions/16119) and
  [issue #19930](https://github.com/tailwindlabs/tailwindcss/issues/19930). This is not an MVP
  runtime or packaging blocker.
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
