# UI foundation — shadcn/Radix adoption

**Status**: **Complete.** Phases 0–3 landed — tooling and the full token migration, the sonner-backed toast and
`useTheme()` provider, every dialog on Radix with the hand-rolled `Modal` deleted, and the Tooltip
rebuilt on Radix's primitive. **The shadcn/Radix adoption is complete.** See "Stages" below for
where this sits in the engineering round.
**Why now, not later**: rdc is greenfield and not racing to an MVP date — the priority is a strong
architectural foundation a future open-source collaborator (post-MVP, once the project is
promoted) can pick up easily. Every hand-rolled component added between now and "later" is more
migration debt, not less, so this happens before the message system's toast rather than after.
**Blocks**: `MESSAGE_SYSTEM_PLAN.md`'s Slice 0 (the toast is this plan's Phase 1, not a separate
component). Nothing else depends on this landing first.

## Stages

`REMAINING.md`'s "Engineering, this pass — before QA cycle 2" lists three items in dependency order.
Mapping them to the work that has actually landed keeps the sequencing honest:

| Stage | Plan | State |
|---|---|---|
| 0 | `UI_FOUNDATION_PLAN.md` Phase 0 (tooling + token migration) | landed (`c6f8765`) |
| 1 | `UI_FOUNDATION_PLAN.md` Phase 1 + `MESSAGE_SYSTEM_PLAN.md` Slice 0 + the `useTheme()` sidebar | landed (`1897ddf`, `dd903a7`) — `reportError` has zero production callers, by design |
| 2 | `UI_FOUNDATION_PLAN.md` Phase 2 (Dialog) + Phase 3 (Tooltip) | landed — `modal.tsx` deleted, `tooltip.tsx` rebuilt on Radix |
| 3 | `MESSAGE_SYSTEM_PLAN.md` Slices 1–7 (wire `reportError` into every store, remove `.application-error`) | after the Dialog primitive they consume exists |
| 4 | `BRANCH_OPERATIONS_PLAN.md` Slice 4 (abort merge) | independent; any time |

Stage 2 finishes the foundation before any message-system consumer, because `MESSAGE_SYSTEM_PLAN.md`
Slice 1's three known-broken dialogs (rename-branch, delete-branch, manage-remotes remove) all live in
`app-dialogs.tsx` — the very file Phase 2 migrates. Migrating the primitive first means Slice 1 wires
`reportError` onto a stable Dialog rather than onto the hand-rolled `Modal` that Phase 2 then has to
carry that wiring through. The two passes touch different lines (markup swap vs. error-field
removal), so the double-touch on those three dialogs is mild and each slice stays independently
gated.

## Why shadcn, specifically

Not a component library dependency — a CLI (`npx shadcn add <component>`) that copies component
source into the repo (`src/components/ui/`), built on Radix UI primitives (unstyled, accessible
behavior: focus trap, portals, keyboard nav, collision-aware positioning) styled with Tailwind
classes. rdc owns the copied source and can edit it freely. The value for an eventual open-source
audience: Radix's primitives are things a contributor would otherwise have to get right by reading
rdc's bespoke `Modal`/`Tooltip` and matching their conventions by hand; shadcn is popular enough
that a contributor plausibly already knows the pattern.

## Current state

**Historical: this is the survey the plan was written from, kept because the later phases argue
against it. Phases 0–3 have since landed; `modal.tsx` no longer exists and `tooltip.tsx` is
Radix-backed.** Verified by reading the code, not assumed from convention:

- **Tokens**: `src/styles/app.css` defines ~29 distinct `--color-*` custom properties (plus shadow/radius/
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
- **Dialogs** (`src/app/app-dialogs.tsx`) use `<Modal>` **2 times** (preferences,
  clone); the other 10 call sites have migrated to shadcn's `Dialog`, `AlertDialog`, or the shared
  `ConfirmDialog`/`NoticeDialog` abstractions. Mechanical once the remaining two are done.
- **Tooltip** (`src/components/tooltip/tooltip.tsx`, 234 lines) is **not** a clean swap. Real custom behavior
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

### Phase 1 — landed, actual result

- **shadcn's own generated `sonner.tsx` assumes `next-themes`**, a Next.js theme-context package
  this app doesn't have. Without a `<ThemeProvider>`, `useTheme()` always falls back to `"system"`
  and silently ignores a user's explicit light/dark preference in Preferences. Removed
  `next-themes` entirely; `Toaster` now takes an explicit `theme` prop, threaded from
  `preferencesState.theme` (the same `ThemeSource` type, already the exact values sonner's own
  prop expects — no adapter needed).
- **A real layout bug, caught by the existing Gate-E resize-matrix E2E, not by unit tests**:
  mounted directly in `app-shell.tsx`, sonner's `<Toaster>` broke `.repository-toolbar` at the
  715 px floor (confirmed by git-stash bisection against the Phase-0 baseline, which was clean).
  Root cause: sonner applies its own `position: fixed` via a runtime-injected `<style>` tag keyed
  off a `data-sonner-toaster` attribute — it does not return a portal. Mounted in place, its
  outer element is still a real, if usually invisible, child of `.application-shell`'s CSS grid,
  and an unstyled grid item silently claims a track and pushes every sibling pane over. `fixed`
  positioning alone does not opt an element out of grid layout; only moving it out of the grid's
  DOM subtree does. Fixed by wrapping `MessageToasts`' return in `createPortal(..., document.body)`
  — the same pattern `tooltip.tsx` already uses, and the one the original design called for before
  a since-corrected implementation shortcut dropped it.
- **jsdom has no `window.matchMedia`** — sonner calls it on mount to track the OS color-scheme
  preference and throws without it. Added a fixed-`false` stub to `test-setup.ts`; no test in this
  suite depends on a real `prefers-color-scheme` result, since the app always passes its own
  resolved theme explicitly.
- Full gate set green with all three fixes in: 1,009 frontend tests (16 new, `message-store.ts` +
  `format-error.ts`), tsc, lint, format, bundle-boundary, a production build, `qualify:phase8a`, and
  `pnpm test:e2e` (28/28 — including the Gate-E resize matrix that caught the portal bug in the
  first place).

## Theming — `useTheme()`, not prop-drilling

Landed alongside Phase 1, once passing `theme` as a prop into `MessageToasts` surfaced the real
question: how does *any* shadcn component get theme-awareness, not just this one. Decided now
because every phase after this needs the answer.

- `src/features/preferences/components/theme-provider.tsx` exports `ThemeProvider`/`useTheme()`, matching the shape most
  shadcn snippets assume from `next-themes` (`{ theme, resolvedTheme, setTheme }`) — but backed by
  rdc's own `preferences-store.ts` and Tauri-native theme integration, not a second parallel theme
  system. `next-themes` itself was considered and rejected: adopting it would mean two independent
  sources of theme truth (its own storage/DOM mechanism versus `preferences-store.ts` +
  `setNativeThemeSource`), and it has no knowledge of Tauri's OS-level theme API at all.
- `PreferencesState` gained `resolvedTheme: 'light' | 'dark'` — `theme` with `'system'` resolved to
  a concrete value. This didn't exist before: theme resolution was a side effect written straight
  to `document.documentElement.dataset.theme`, never tracked in React state, so nothing reactive
  could read "is it actually dark right now" without re-deriving it. `applyTheme`/
  `resolveSystemTheme` (`preferences-store.ts`) now return the resolved value in addition to
  setting the DOM attribute — one source of truth, not two.
- `<ThemeProvider>` wraps the app once, in `src/app/app.tsx`. Any component under it — `MessageToasts`
  today, Dialog/Tooltip's shadcn primitives next — calls `useTheme()` directly instead of
  receiving `theme` threaded down as a prop through however many layers separate it from
  `app-shell.tsx`.
- `MessageToasts` reads `resolvedTheme`, not `theme`, when it hands sonner a value: this keeps
  sonner's colors matching what Tauri's own OS-level theme detection already decided for the rest
  of the app, rather than trusting sonner's independent browser `matchMedia` check to agree with
  it. The same choice applies to Dialog/Tooltip if either ever needs a concrete light/dark
  decision rather than the raw preference.
- **One DOM signal, not three.** shadcn's docs recommend `next-themes`, which sets three things
  on `<html>`: a `.dark` class, a `color-scheme` CSS property, and (via React context) the
  `useTheme()` shape. rdc keeps a single JS-set signal — `document.documentElement.dataset.theme`
  — and derives everything else from it in CSS, so nothing can drift:
  - The `.dark` class is *not* set. shadcn's generated components assume it via Tailwind's
    `dark:` variant, so `App.css:12` redirects that variant to the actual selector
    (`@custom-variant dark (&:is([data-theme='dark'] *))`). shadcn components read the one
    attribute through that mapping; no second class is maintained.
  - `color-scheme` is set in CSS too (`App.css` `:root { color-scheme: light; }` and
    `:root[data-theme="dark"] { color-scheme: dark; }`), so native form controls and scrollbars
    follow the same attribute the rest of the theme does — one source of truth (Tauri's resolved
    theme), not three. This was added after the next-themes comparison surfaced it as the one real
    gap; the fix is a CSS consequence of the existing attribute, not a second JS write.
  - The `useTheme()` *shape* is what `theme-provider.tsx` provides; the shape is shadcn's
    contract, the backing is rdc's. Adopting shadcn does not commit rdc to next-themes (a separate
    package by a different author, built for Next.js SSR with no Tauri awareness); the tax for not
    adopting it is per-component (strip the `next-themes` import where a vendored component
    assumes it — sonner needed it in Phase 1; `dialog.tsx`/`alert-dialog.tsx` don't), not a
    parallel theme system to maintain.

## Phase 2 — Dialog

Retire `modal.tsx`. Migrate `app-dialogs.tsx`'s 12 call sites onto shadcn's `Dialog`, one at a
time. Do the one with the most internal-focus complexity first (to prove the pattern under the
hardest case), then the rest mechanically — once the shape is proven, this is exactly the kind of
work to hand off with an exact spec rather than repeat by hand 12 times. For `modal.test.tsx`:
decide per assertion whether it now tests pure Radix behavior (already covered upstream, safe to
drop) or an app-specific detail (`aria-labelledby`/`aria-describedby` wiring, the specific
backdrop/z-index contract other code depends on) that still needs rdc's own test.

### Phase 2 — execution breakdown

The 12 call sites, read from `app-dialogs.tsx` (line numbers current as of stage 2):

| # | Line | Dialog | Role | `onDismiss` | Status |
|---|---|---|---|---|---|
| 1 | `:166` | discard-file | alertdialog | `discarding ? undefined : onCancelDiscard` | **done** (ConfirmDialog) |
| 2 | `:214` | discard-all | alertdialog | `discarding ? undefined : onCancelDiscardAll` | **done** (ConfirmDialog) |
| 3 | `:253` | rename-branch | dialog | `onCancelRename` (form `onSubmit`) | **done** (Dialog) |
| 4 | `:308` | delete-branch | alertdialog | `onCancelDelete` (two-mode: refusal vs. confirm) | **done** (ConfirmDialog/NoticeDialog) |
| 5 | `:366` | merge-picker | dialog | `mergeRunning ? undefined : onCancelMerge` | **done** (Dialog) |
| 6 | `:411` | manage-remotes | dialog | `manageRunning ? undefined : onCloseManageRemotes` | **done** (Dialog) |
| 7 | `:482` | add-remote | dialog | `manageRunning ? undefined : onCloseAddRemote` | **done** (Dialog) |
| 8 | `:544` | hook-failure | alertdialog | *(none — decision required)* | **done** (AlertDialog) |
| 9 | `:582` | remove-repository | alertdialog | `onCancelRemoveRepository` | **done** (ConfirmDialog) |
| 10 | `:601` | about | dialog | `onDismissAbout` | **done** (Dialog) |
| 11 | `:632` | preferences | dialog | `onDismissPreferences` (largest flat form) | pending |
| 12 | `:773` | clone | dialog | `cloneState.operation === null ? onDismissClone : undefined` | pending |

**Primitive decision.** Radix ships two: `Dialog` (dismissible) and `AlertDialog` (no
backdrop/Escape dismissal — the accessible contract for "a decision is required"). `Modal` encodes
the latter today via `onDismiss={undefined}`, which suppresses both Escape and the backdrop click.
Recommend vendoring **both** `dialog.tsx` and `alert-dialog.tsx`; map the 5 alertdialog sites to
`AlertDialog` and the 7 dialog sites to `Dialog`. The conditional-`undefined` sites (1, 2, 5, 6, 7,
12 — "dismissible unless an operation is running") become `onOpenChange={(open) => { if (!open &&
!running) onClose() }}`, i.e. the same gating, expressed in Radix's controlled-open shape. The one
pure decision-required site (8, hook-failure) is `AlertDialog` with no `onOpenChange` dismissal at
all — the case `modal.test.tsx:44` ("does not dismiss a decision dialog without a safe
cancellation path") already pins, and which `AlertDialog` gives by spec.

**Sub-slice 2.0 — vendor both primitives, pilot the hardest of each.** `npx shadcn add dialog
alert-dialog`, then apply the same fixes Phase 0/1 needed: the `@custom-variant dark` already
corrected in `App.css` covers these; drop any `next-themes` import the generators assume (Dialog
doesn't read theme, but the file may still import it). Pilot:
- **`Dialog` on manage-remotes (`:433`) + add-remote (`:500`)** — these are sibling conditional
  `Modal`s that render *stacked* when add-remote opens, the nested-dialog focus case. Radix's
  `DismissableLayer` + `FocusScope` stack handles nested focus trapping, Escape-closes-top-only,
  and backdrop-click-on-top-only; proving the pattern here proves the hardest case before
  repeating it 11 times. If the nested case surfaces a Radix gap, fall back to piloting on
  preferences (`:627`, the largest flat form) and file the nesting case as a follow-up — but only
  after reading the gap, not by assuming one.
- **`AlertDialog` on hook-failure (`:558`)** — the only pure decision-required site; proves the
  "no dismissal" contract maps cleanly.

Update `App.test.tsx` assertions that touch these three dialogs (the `getByRole("dialog"|
"alertdialog", { name: "..." })` queries — Radix surfaces the accessible name from `DialogTitle`/
`AlertDialogTitle`, so the hardcoded `aria-labelledby` ids can go; the `name:` matcher keeps
working off the title text). Keep `modal.test.tsx` for now — `Modal` is still used by the other 9
sites. Gate: full seven-gate set plus a manual Light/Dark/System visual pass on the three pilots
(backdrop colour, focus ring, Escape, and the manage-remotes→add-remote stacking order).

**Sub-slice 2.1 — migrate the remaining 9 call sites mechanically.** Once 2.0 proves the shape,
this is markup swap + prop remap, one dialog per commit:
- `Dialog`: ~~rename `:262`~~ **done**, ~~merge `:367`~~ **done**, about **done**, preferences `:632`, clone `:773`.
- `AlertDialog`: discard-file **done**, discard-all **done**, delete-branch **done** (two-mode: refusal
  view vs. confirm-with-checkbox), remove-repository **done**.

**Sub-slice 2.2 — retire `modal.tsx` and `modal.test.tsx`.** Delete `src/lib/ui/modal.tsx`; grep
for `<Modal` and the `Modal` import must return zero hits. For `modal.test.tsx`: the focus-trap,
Tab-cycle and Escape-dismiss assertions test pure Radix behavior now covered upstream → drop. The
one assertion worth keeping, if any, is an rdc-specific contract other code depends on (the
backdrop `z-index` relative to the native context menu and sonner's `Toaster` — verify by reading,
not by memory; if Radix's portal `z-index` ordering differs, that's an `App.css` adjustment, not a
`modal.test.tsx` test). Likely delete the whole file.

**Per sub-slice verification.** Same gate set as every phase, plus: grep confirms no `<Modal` /
`modal.tsx` import remains after 2.2; `App.test.tsx`'s dialog assertions (lines `534`, `561`, `572`,
`982`, `1501`, `1578`, `1700`, `1785`, `1880` and the manage-remotes/add-remote ones) pass unchanged
against the new primitives — they should, since the accessible-name queries are primitive-agnostic.

### Phase 2 — per-dialog visual validation

Each dialog migration changes padding (`p-6`→`p-4`), border (`border`→`ring-1`), backdrop
(`42%`→`10%`+blur), max-width, and header alignment. None of these are caught by the automated
gate set — a wrong shade or misaligned header is invisible to every test. So **every migrated
dialog gets a human visual check in Light and Dark**, and every sub-slice **adds that dialog's rows**
to `qa/phase-8b/dialog-migration-checklist.md` (created in sub-slice 2.0) as part of its own work.

The check itself runs in the Phase 8b cycle, not as a gate on the sub-slice: a sub-slice is done when
its automated gates are green and its rows are written. See “Where QA happens” in
`COMPONENT_MIGRATION_PROCESS.md`. The rows stay per-dialog — that granularity is what makes the cycle
walkable — but a dialog does not wait on a signature to be considered migrated.

What to verify per dialog, in Light and Dark:

- **Backdrop** — dim but content readable; `forced-colors` override (`App.css:1810`) still
  targets the new class (the `.dialog-backdrop` selector may need re-pointing to Radix's
  `[data-slot="dialog-overlay"]` / `[data-slot="alert-dialog-overlay"]`).
- **Header alignment** — shadcn's `AlertDialogHeader` centers by default below `sm:`; rdc's 715px
  floor is above it, but pin left-alignment (`place-items-start text-left`) rather than assume.
- **Width** — each dialog's custom width override (preferences `min(34rem,...)`, manage-remotes
  wider for the list, hook-failure wider for the `<pre>`) is applied via `className` and not
  clipped.
- **Action buttons** — `DialogFooter`/`AlertDialogFooter` layout (border-t, bg-muted/50) reads
  as a footer, not as body content; destructive buttons keep the `destructive-button` styling.
- **Focus** — first focusable element gets focus on open; Tab cycles within; Escape closes
  dismissible dialogs and is a no-op on decision-required ones (hook-failure).
- **Nested case** (manage-remotes → add-remote) — the top dialog traps focus; Escape closes only
  the top dialog; backdrop-click closes only the top dialog; closing the top returns focus to the
  bottom, not to the app.

The pilot sub-slice (2.0) establishes the checklist template and signs off the two pilot dialogs;
sub-slices 2.1 and 2.2 fill in one row per migrated dialog as it lands.

## Phase 3 — Tooltip

Last, because it's the one phase with real product behavior to preserve, not just markup to swap.
Before writing any component code, spend real time confirming `collisionBoundary` actually
reproduces the boundary-clearance behavior against `data-tooltip-boundary` elements — don't assume
Popper's semantics match a hand-written boundary-clamp without checking both against the same test
cases `tooltip.test.tsx` already encodes. Land, in order: boundary clearance, the pointer-tracking
layer, then the `dismissAllTooltips()`-equivalent controlled-registry — verify the context-menu
force-dismiss integration (`use-app-controller.ts`) still works before calling this phase done, not
just the tooltip in isolation. Rewrite `tooltip.test.tsx` against the new behavior.

### Phase 3 — execution breakdown

The custom behavior to preserve is in `tooltip.tsx` (225 lines) and pinned by `tooltip.test.tsx`
(5 tests). Three behaviors, in landing order:

1. **Boundary clearance** — a trigger inside a `[data-tooltip-boundary]` clears the *whole*
   ancestor (e.g. a command bar), not just its own rect, so the bubble never lands inside the bar's
   padding. Pinned by `tooltip.test.tsx:60` (asserts `bubbleTop() === "75.25px"` — the bar's
   `bottom` + 7 px gap, not the trigger's `bottom` + gap) and `:77` (no boundary → clears the
   trigger only, `66.3px`).
2. **Pointer-Y tracking on tall targets** (`tooltip.tsx:130-150, 194-207`) — hovering a row taller
   than 100 px repositions the bubble to follow `clientY`. No Radix equivalent; needs a thin custom
   layer on top of the primitive.
3. **`dismissAllTooltips()` registry** (`tooltip.tsx:31-38`) — a module-level `Set` of every
   mounted tooltip's `hide`, called from `use-app-controller.ts:526` and `:879` before a native
   surface (context menu) covers the trigger. Pinned by `tooltip.test.tsx:112` (closes without a
   blur/mouseleave — the macOS-context-menu regression) and `:133` (unmount is safe).

**Sub-slice 3.0 — boundary-clearance spike (de-risk, not shippable).** `npx shadcn add tooltip`
(vendors `@radix-ui/react-tooltip`). *Before writing component code*, write a throwaway test that
mounts a Radix `Tooltip` inside a `data-tooltip-boundary` container with the exact stubbed rects
`tooltip.test.tsx:15-49` defines, and asserts `bubbleTop() === "75.25px"`. If
`collisionBoundary={<ancestor>}` + `collisionPadding={{ top: 36 }}` (the `titlebarGap`) reproduces
it → proceed. If not → stop; the sketch's "needs proving, not assuming" gate has fired and the
boundary layer has to be custom, not Radix. This spike exists to fail fast on the one assumption
this phase rests on.

**Spike run (2026-08-15). The gate fired: `collisionBoundary` does not reproduce it.** Measured
against the exact stubbed rects, with `@radix-ui/react-tooltip` 1.2.16 via `radix-ui` 1.6.7:

| Configuration | Radix positions at | Contract |
|---|---|---|
| `collisionBoundary` + `collisionPadding={{ top: 36 }}` | `translate(0px, 39px)` | ✗ — *worse*, inside the bar |
| No collision handling, `sideOffset={7}` | `translate(12px, 66px)` | ✗ — trigger clearance (today's no-boundary case) |
| No collision handling, `sideOffset={barBottom − triggerBottom + 7}` | `translate(12px, 75px)` | ✓ — the boundary-clearance contract |

The reason is semantic, and it is why no amount of prop-tuning would have worked:
**`collisionBoundary` is a containment constraint — it keeps content *inside* the boundary — while
rdc's clearance pushes content *past* an ancestor.** They are opposite operations, which is why the
collision configuration pulled the bubble further up into the bar (39px) rather than below it.

So the boundary layer is custom, as the gate says. But the custom part is small: Radix still does
the positioning, and rdc supplies `sideOffset = boundaryBottom − triggerBottom + gap`. That is one
measurement and one subtraction, not a positioning engine, and row three above proves it lands on
the contract.

Two consequences for 3.1, both measured rather than assumed:

- **The assertions cannot be preserved in *value*.** Radix positions with `transform: translate(…)`
  on a `[data-radix-popper-content-wrapper]`, not `style.top` on the bubble, so `bubbleTop()` has
  nothing to read. Re-derive against the transform.
- **Radix rounds to integer pixels**: `75px` where today's implementation writes `75.25px`. A
  quarter-pixel, but it is a real behaviour change and the re-derived assertions should state the
  rounded value deliberately rather than appear to have drifted.

**Sub-slice 3.1 — boundary clearance + pointer-Y tracking.** Build the rdc `Tooltip` on Radix's
primitive, portalling to `document.body` (Radix portals by default; verify the bubble is not
clipped by a workspace pane, which is why today's `tooltip.tsx` portals). Boundary clearance from
3.0. Pointer-Y tracking: Radix's Popper is anchor-based, not pointer-based, so for tall targets
keep a custom position layer (`onMouseMove` → controlled offset), and use Radix's positioning for
the short-trigger-in-a-bar case. Unify both behind one component so call sites don't branch. Port
`tooltip.test.tsx`'s stubbed-rect tests (boundary, no-boundary, `aria-describedby`-while-open) onto
the new component; the assertions' exact pixel values are the contract.

**Sub-slice 3.2 — `dismissAllTooltips` registry + context-menu integration.** Replace the
module-level `openTooltips: Set<() => void>` with the same shape holding Radix-controlled `open`
setters (the sketch's controlled-registry — Radix `Tooltip.Root` is controllable via
`open`/`onOpenChange`). Keep the export name `dismissAllTooltips` so `use-app-controller.ts:526,
879` don't change. The guard is `tooltip.test.tsx:112` (closes on `dismissAllTooltips` without
blur/mouseleave — the macOS regression this whole mechanism exists for) and `:133` (unmount safe);
both must pass against the controlled registry. The native-context-menu path itself isn't
exercisable in jsdom, so the unit test is the guard — do not add an E2E for it (native GTK menus
have no WebDriver backend; see `MIGRATION_MAP.md` §8).

**Landed (2026-08-15), 3.1–3.3 together.** The component is Radix-backed and keeps both export
names, so no call site changed. Radix owns open/close semantics, `aria-describedby`, Escape
dismissal, the portal and the transform; rdc owns the placement, expressed as `side`, `sideOffset`
and `alignOffset`.

`avoidCollisions` is **off**, and that is the consequence of 3.0 rather than a shortcut. Collision
handling cannot coexist with boundary clearance — it pulls the bubble back inside the very ancestor
the clearance pushes it past — so the viewport clamping and the flip-above that collision handling
would have provided are computed here instead. That is the honest cost: the component is 242 lines
against the hand-rolled 225. It is not smaller. What it buys is Escape dismissal (new), upstream
ownership of the hover/focus/a11y semantics, and consistency with the rest of the foundation.

Three things the plan did not anticipate, each found by a test rather than by reading:

- **`data-tooltip` on the trigger is load-bearing outside this component.** `working-tree.test.mjs`
  and `history.test.mjs` read it, as does `App.test.tsx`. It is not decoration; it stays.
- **`.app-tooltip` was `position: fixed`**, which only made sense while the implementation wrote
  `left`/`top` onto the bubble itself. Inside Radix's positioned wrapper it is laid out normally.
- **An unmeasurable bubble must still be positionable.** The first implementation returned "no
  placement" when the bubble reported zero height, which is what jsdom reports without stubbed
  rects — so the bubble stayed `visibility: hidden` forever and was invisible to `getByRole`. Zero
  height means *cannot* measure, not *not yet*; the height only refines the placement.

**Sub-slice 3.3 — retire the old `tooltip.tsx` implementation.** The new component keeps the same
export names (`Tooltip`, `dismissAllTooltips`), so the ~dozen call sites (`repository-toolbar`,
`repository-sidebar`, `app-dialogs`, etc.) don't change. Delete the hand-rolled positioning code;
grep `from "../tooltip"` / `from "./tooltip"` confirms every import resolves to the new file.

**Per sub-slice verification.** Same gate set, plus: the four `tooltip.test.tsx` assertions that
encode real product behavior (boundary clearance, no-boundary clearance, `dismissAllTooltips`
closes-without-blur, unmount-safe) pass against the Radix-backed component unchanged in *value*;
if 3.0's spike forced a custom boundary layer, those assertions are re-derived from the same
stubbed rects, not relaxed. A manual Light/Dark/System pass on the repository toolbar's tooltips
(the primary `data-tooltip-boundary` site) confirms the bubble still clears the bar after the swap.

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
