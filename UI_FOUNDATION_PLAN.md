# UI foundation — shadcn/Radix adoption

**Status**: Phase 0 landed (tooling + full token migration). Phases 1–3 (Toast, Dialog, Tooltip)
not started.
**Why now, not later**: rdc is greenfield and not racing to an MVP date — the priority is a strong
architectural foundation a future open-source collaborator (post-MVP, once the project is
promoted) can pick up easily. Every hand-rolled component added between now and "later" is more
migration debt, not less, so this happens before the message system's toast rather than after.
**Blocks**: `MESSAGE_SYSTEM_PLAN.md`'s Slice 0 (the toast is this plan's Phase 1, not a separate
component). Nothing else depends on this landing first.

## Why shadcn, specifically

Not a component library dependency — a CLI (`npx shadcn add <component>`) that copies component
source into the repo (`src/components/ui/`), built on Radix UI primitives (unstyled, accessible
behavior: focus trap, portals, keyboard nav, collision-aware positioning) styled with Tailwind
classes. rdc owns the copied source and can edit it freely. The value for an eventual open-source
audience: Radix's primitives are things a contributor would otherwise have to get right by reading
rdc's bespoke `Modal`/`Tooltip` and matching their conventions by hand; shadcn is popular enough
that a contributor plausibly already knows the pattern.

## Current state

Verified by reading the code, not assumed from convention:

- **Tokens**: `src/App.css` defines ~29 distinct `--color-*` custom properties (plus shadow/radius/
  spacing tokens) under a plain `:root { }` — not wired through Tailwind 4's `@theme` directive,
  just referenced via `var(--color-x)` throughout (172 references in `App.css` alone; 7 more
  `.tsx` files reference them inline via arbitrary Tailwind values). Dark-theme and forced-colors
  (Windows high-contrast) override blocks exist for several tokens (found during the message-
  system research pass, e.g. the `.application-error` dark/forced-colors overrides) and must
  survive the migration.
- **Modal** (`src/lib/ui/modal.tsx`, 100 lines) hand-rolls exactly what Radix's `Dialog` primitive
  provides: focus trap, Tab-cycle between first/last focusable element, Escape-to-dismiss,
  backdrop, `role="dialog"|"alertdialog"`, `aria-modal`. No bespoke business logic beyond that — a
  clean, low-risk swap.
- **Dialogs** (`src/lib/ui/app/app-dialogs.tsx`, 912 lines) use `<Modal>` **12 times** — one call
  site per dialog (clone, preferences, discard, discard-all, rename-branch, delete-branch, merge
  picker, manage-remotes, add-remote, commit-hook-output, and two more). Mechanical once the first
  is migrated and the pattern is proven.
- **Tooltip** (`src/lib/ui/tooltip.tsx`, 234 lines) is **not** a clean swap. Real custom behavior
  Radix doesn't provide identically:
  - Boundary clearance (`data-tooltip-boundary`) — a tooltip clears an entire ancestor element
    (e.g. a whole command bar), not just its own trigger, so it never lands inside the bar's own
    padding. Radix's `Tooltip.Content` (built on Popper) accepts `collisionBoundary` (element(s)
    to avoid overlapping) — plausibly a direct replacement, but needs proving, not assuming.
  - Pointer-Y tracking while hovering a tall target (`onMouseMove` repositioning) — no Radix
    equivalent; needs a thin custom layer on top of the primitive.
  - `dismissAllTooltips()` — a module-level registry of every mounted tooltip's `hide`, called by
    `use-app-controller.ts` before opening a native context menu (so a lingering tooltip doesn't
    render behind the popup). Radix `Tooltip.Root` is controllable via `open`/`onOpenChange`; the
    replacement is the same registry shape, holding setters that drive Radix's controlled props
    instead of local `useState`.
- **Tests**: no dedicated `app-dialogs.test.tsx` exists — dialog behavior is exercised through
  `App.test.tsx`'s integration-style tests, which will need updated assertions as each dialog
  migrates even though the file itself isn't touched by the migration directly. `modal.test.tsx`
  and `tooltip.test.tsx` exist and test today's hand-rolled behavior directly — both need
  rewriting against the Radix-backed replacement.

## Phase 0 — Tooling and token migration

**Tooling**: `npx shadcn init` — adds `components.json`, a `cn()` utility (`clsx` +
`tailwind-merge`) at the conventional `src/lib/utils.ts` path (check for a naming clash with the
existing `src/lib/` layout before accepting the default — `src/lib/` already has many
single-purpose modules, `utils.ts` is generic enough to double-check). Add each component's Radix
package only when that component is actually added (`@radix-ui/react-dialog` in Phase 2,
`@radix-ui/react-tooltip` in Phase 3, whatever `sonner` itself needs in Phase 1) rather than
installing the whole Radix suite up front.

**Token migration** — map rdc's existing semantic names onto shadcn's expected slots once, as a
deliberate table, not ad hoc during each later phase:

| rdc token | shadcn slot |
|---|---|
| `--color-canvas` | `--background` |
| `--color-text` | `--foreground` |
| `--color-surface` / `--color-surface-raised` | `--card` / `--popover` |
| `--color-accent` / `--color-accent-button` | `--primary` |
| `--color-text-muted` | `--muted-foreground` |
| `--color-border` / `--color-border-strong` | `--border` / `--ring` |
| `--color-danger`, `--color-error-*` | `--destructive` (+ a distinct `--destructive-foreground`) |
| `--radius-small` / `--radius-medium` | `--radius` (shadcn expects one base radius; decide during this phase whether both current sizes still earn a place as app-specific extensions, or collapse to one) |

`--color-success`, `--color-warning-*`, `--color-toolbar-*`, `--color-diff-*` and the
tooltip-specific tokens (`--color-tooltip-*`) have no shadcn-standard slot — keep them as rdc's own
extensions, defined in the same `@theme`/`:root` block as the renamed shadcn slots, not split into
a second file or a second convention. Wire both light and dark values through Tailwind 4's
`@theme` directive so shadcn's utility classes (`bg-background`, `text-foreground`, etc.) work
directly, and carry every existing dark/forced-colors override forward under the new names.

This is a rename-and-restructure pass, not a value change — the deliverable is a before/after
visual diff that is blank in every theme except wherever a later phase deliberately changes
something. Update the 7 `.tsx` files with inline `var(--color-x)` references to the new names in
the same pass; grep for the old names afterward and confirm zero hits outside this phase's own
commit history.

## Phase 0 — landed, actual result

The mapping table above was a sketch written before touching the code; a few things changed once
the actual token usages were read (grep, not assumption) and are worth recording so Phases 1–3
don't re-derive them:

- **`shadcn init` (v4.16.1) is a different tool than expected** — a web-configurator-linked CLI
  with named presets (Nova/Vega/Maia/...) rather than the older offline `components.json` +
  `globals.css` flow. Its "Custom" preset opens a browser to `ui.shadcn.com/create`, unusable
  headlessly. Worked around by bootstrapping with `-p nova -b radix -t vite -y` (Nova's `baseColor`
  is `neutral`, same as every preset but Sera) and then overwriting every value it wrote with rdc's
  own palette — the preset only ever mattered for getting past the picker, not for any color it
  produced.
- **It also demanded a path alias** (`@/*`) before it would run at all — added scoped to
  `tsconfig.json`/`vite.config.ts`, documented in both places as shadcn-only; the rest of the
  codebase keeps its relative-import convention.
- **A real bug the migration would have shipped silently**: the CLI's `@custom-variant dark
  (&:is(.dark *))` assumes a `.dark` class. rdc's actual dark-theme selector is
  `document.documentElement.dataset.theme` (`[data-theme='dark']`, set in
  `preferences-store.ts`) — every `dark:` utility in a vendored component would have silently
  never fired. Fixed to `@custom-variant dark (&:is([data-theme='dark'] *))`.
- **`--accent`/`--accent-foreground` are not rdc's brand accent.** shadcn's `accent` slot is a
  subtle hover/selected background for interactive list items — a different concept from rdc's own
  `--color-accent` (brand blue, 23 usages: links, focus outlines, active-state borders). Both are
  kept as distinct tokens rather than conflated; `--ring` (focus rings) maps to `--color-accent`'s
  value, since that is what rdc's own `:focus-visible` rule already used.
- **`--primary` maps to `--color-accent-button`, not `--color-accent`** — the two were identical in
  light mode but diverge in dark mode (`#7aa2f7` vs `#436fc8`), and only `-button` was actually used
  as a solid-fill background (`--color-accent` is a foreground/border/outline color, never a fill
  behind body text — using it as a button fill would fail contrast). `--primary-foreground` is a
  flat `#ffffff` in both themes, matching the one real usage found (`.commit-form
  button[type='submit']`).
- **`--input` maps to `--color-border-strong`**, not to any background — nothing in rdc's CSS uses
  a distinct input background from `--card`, so only the border-strength distinction carried over.
- **Removed rather than kept as extensions**: `--sidebar-*` and `--chart-*` (no consuming
  component; `shadcn add sidebar`/`chart` would reintroduce them if ever adopted) and the
  `@fontsource-variable/geist` font import (rdc already had a deliberate system-font choice for a
  desktop app; kept as the new `--font-sans` value instead of adopting a bundled webfont).
- **`shadcn` (the CLI) and `tw-animate-css` moved to `devDependencies`** — build-time-only, same
  treatment as `tailwindcss` itself. Radix packages, `lucide-react`, `cva`, `clsx`, `tailwind-merge`
  stay in `dependencies` since they run in the shipped webview.
- **A CSS comment gotcha worth remembering for Phases 1–3**: a `/* ... */` comment containing an odd
  total number of `'` characters broke Tailwind's dev-build CSS parser with `Unterminated string`
  (not a spec-compliant CSS rule, but real in this toolchain) — and separately, a comment containing
  a literal `*/` substring (e.g. describing `bg-*/text-*/` shorthand) closes the comment early and
  breaks `oxfmt`'s CSS parser. Avoid contractions and glob-slash notation in CSS comments here.
- **Two real test regressions caught and fixed**: `e2e/visual.test.mjs` computed its own "expected"
  colors by reading `var(--color-surface-raised)` and `var(--color-danger)` directly — both renamed
  away, so the test would have silently compared the live app's new (correct) colors against `now
  resolves to nothing` instead of catching a real regression. Updated to `--popover`/`--destructive`.
  Full gate set (including `pnpm test:e2e`, `pnpm qualify:phase8a`, a production `pnpm build`, and
  `cargo test`/`clippy`/`fmt`) is green with these fixes in.

## Phase 1 — Toast (the pilot)

`sonner` (shadcn's current recommendation, superseding the older `toast`/`use-toast` component).
This phase *is* `MESSAGE_SYSTEM_PLAN.md`'s Slice 0 — the toast component lives here; that
document's `MessageStore`/`describeError`/`reportError` design (state and formatting, which is
app-specific logic, not a UI-kit concern) is unaffected and stays there. See that document for the
severity/dismissal design (error/warning persist until dismissed, info auto-dismisses) — this
phase's job is only to make `sonner` render that design, not to redecide it.

## Phase 2 — Dialog

Retire `modal.tsx`. Migrate `app-dialogs.tsx`'s 12 call sites onto shadcn's `Dialog`, one at a
time. Do the one with the most internal-focus complexity first (to prove the pattern under the
hardest case), then the rest mechanically — once the shape is proven, this is exactly the kind of
work to hand off with an exact spec rather than repeat by hand 12 times. For `modal.test.tsx`:
decide per assertion whether it now tests pure Radix behavior (already covered upstream, safe to
drop) or an app-specific detail (`aria-labelledby`/`aria-describedby` wiring, the specific
backdrop/z-index contract other code depends on) that still needs rdc's own test.

## Phase 3 — Tooltip

Last, because it's the one phase with real product behavior to preserve, not just markup to swap.
Before writing any component code, spend real time confirming `collisionBoundary` actually
reproduces the boundary-clearance behavior against `data-tooltip-boundary` elements — don't assume
Popper's semantics match a hand-written boundary-clamp without checking both against the same test
cases `tooltip.test.tsx` already encodes. Land, in order: boundary clearance, the pointer-tracking
layer, then the `dismissAllTooltips()`-equivalent controlled-registry — verify the context-menu
force-dismiss integration (`use-app-controller.ts`) still works before calling this phase done, not
just the tooltip in isolation. Rewrite `tooltip.test.tsx` against the new behavior.

## Not scoped now

Button, Input, Select and other primitives — adopt shadcn's versions naturally as each is next
touched by other work, rather than a forced pass over every pixel. The foundation (tokens, tooling,
the pattern proven three times over) is what matters; migrating everything at once isn't the goal
and isn't worth the risk of a single enormous diff.

## Definition of done, per phase

Same gate set every plan in this repo uses:

- `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm format:check`, `pnpm lint`
- `pnpm check:bundle-boundary`, `pnpm qualify:phase8a`, `pnpm test:e2e`
- `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --check`

Plus, for any phase touching `App.css`'s shared tokens (Phase 0 touches all of them at once): a
manual visual pass in Light/Dark/System at normal/default/compact widths, treated as load-bearing
verification, not a nice-to-have — a wrong color here is invisible to every automated gate above.

## Risks

- **Phase 0's token rename is the one place a mistake is silent.** Nothing in the automated gate
  set catches "this element is now the wrong shade of grey." The before/after visual diff is the
  actual test.
- **Tooltip's custom behavior is real product logic**, found and fixed earlier this session
  precisely because it mattered (the boundary-clearance logic exists to stop a tooltip landing
  inside a command bar's own padding; the force-dismiss registry exists to stop a tooltip lingering
  behind a native context menu). Don't let "it's just Radix now" excuse quietly dropping either.
- **Dialog migration's real test surface is `App.test.tsx`'s integration coverage**, not a
  dedicated dialog test file — budget time for that even though `app-dialogs.tsx` itself has no
  test file to point at directly.
