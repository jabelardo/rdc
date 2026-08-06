# Component migration — the three-way review process

**Status**: active. Dialogs first; the same process applies to every component family after.

## Why this exists

The shadcn/Radix migration is not a mechanical swap, and adopting a library default is a UI/UX
decision even when it looks like plumbing. Three sources each carry real information:

- **rdc today** — what ships now, and what users of the current build already expect.
- **desktop-plus** — the app rdc is a rewrite of. Its dialog layer encodes years of decisions, and
  those decisions are often *documented in the source* rather than merely implied.
- **shadcn/Radix** — the new foundation, whose defaults are good but generic, and were not chosen
  with a git client in mind.

Where all three agree, there is no decision to make. Where they disagree, there is one — and it
should be made deliberately, once, and written down. rdc is explicitly allowed to diverge from
desktop-plus (`MIGRATION_PLAN.md` principle 6: UI/UX is rdc's to choose); the point of comparing is
to make divergence a choice rather than an accident.

## The process, per component

1. **Build the three-way table.** One row per behavioural dimension (below), one column each for
   rdc / desktop-plus / shadcn. Read the source for all three — desktop-plus in particular tends to
   explain *why* in comments, which is the most valuable input available.
2. **Mark each row**: `AGREED` (all three match — no decision), `SETTLED` (already covered by a
   convention below — no decision), or `DECIDE` (genuine divergence).
3. **Resolve every `DECIDE` row** with the user, and record the rationale.
4. **Promote anything reusable** into "Settled conventions" below.
5. **Implement**, then run the visual pass in
   [`qa/phase-8b/dialog-migration-checklist.md`](./qa/phase-8b/dialog-migration-checklist.md).

The payoff compounds: each component only needs review of what is *new*. By the third or fourth
dialog most rows should read `SETTLED`, and the table shrinks to the genuine deltas.

### Dimensions to compare

Behaviour and semantics (this document): focus target on open · keyboard dismissal (Escape) ·
button order · which action is the default · destructive treatment · labels/wording · element
semantics (`Dialog` vs `AlertDialog`) · what happens while an operation is in flight.

Appearance (the QA checklist, human pass): backdrop · padding · header alignment · footer
treatment · width and clipping · forced-colors.

> **Note on the checklist's Focus criterion.** It currently reads "First focusable element gets
> focus on open", which assumes Radix's default is correct. Convention 1 below supersedes that: the
> criterion is whether the *intended* element has focus, which for a destructive dialog is not the
> first one.

---

## Settled conventions

Append-only. Each entry states the rule and the evidence, so a later component can cite it instead
of re-litigating.

### Convention 1 — the safe action is the default, and Radix gives this for free

When a dialog's affirmative action is destructive, the **safe** action is the default (focused)
button. All three sources agree, which makes this a convention rather than a judgement call:

- **desktop-plus** makes it explicit in `OkCancelButtonGroup`'s API — a `destructive` prop whose
  documented purpose is *"This controls whether the Ok button, or the Cancel button will be the
  default button"*, with the implementation comment *"we want the default button to be the safest
  choice and we want that safe button to be what gets clicked if the user submits the form using
  the keyboard."*
- **Radix** implements the same idea natively: `AlertDialog` keeps a `cancelRef` and calls
  `cancelRef.current?.focus({ preventScroll: true })` on open, so `AlertDialogCancel` is focused
  rather than the first tabbable element.
- **rdc** intends it — the pre-migration hand-rolled `Modal` focused the safe action.

**Rule:** use `AlertDialogCancel` for the safe action and `AlertDialogAction` for the affirmative
one. Do not use plain `<button>` elements inside an `AlertDialogFooter` — that is precisely what
drops the behaviour, because Radix then has no cancel to focus and falls back to first-tabbable.

### Convention 3 — Tailwind owns the scale; new work adds no hand-written CSS

The port brought desktop-plus's CSS wholesale into a Tailwind project, so Tailwind ended up a
veneer rather than the design system — 244 hand-written rules in `App.css` against 179 `className`
attributes, and `--space-1…5` ported from desktop-plus and referenced **zero** times because
`gap-2`/`p-4` were already there. Three of the problems hit during the dialog migration were the
same root cause: an unlayered `button {}` overriding utilities, two competing token vocabularies,
and a 13px root silently rendering every rem-based utility at 81% of its designed size.

**Rules that follow from the fix:**

- **The root stays at the browser default.** rdc's 13px density lives on `body`. A 13px root makes
  `rem` mean 13px, which quietly shrinks every Tailwind spacing and type utility — invisible to
  every automated gate. `visual.test.mjs` now asserts both the 16px root and the 13px body so a
  regression is caught.
- **`rem` in a `@media` prelude is always 16px**, regardless of `html { font-size }`, because a
  media query is evaluated outside the element tree and resolves against the initial value. Never
  convert those alongside declaration lengths.
- **Anything matching a bare element selector must live in `@layer base`**, or it outranks every
  utility.
- **A migrated component leaves `App.css`.** Its styling moves to utilities or a shadcn component,
  so the file only ever shrinks. No new hand-written component CSS.
- **shadcn's own files (`src/components/ui/**`) keep `rem`** — they are authored against a 16px
  root and are now finally correct. Only rdc-authored values were converted to px.

### Convention 2 — platform button order

macOS renders `[Cancel, Ok]`; every other platform renders `[Ok, Cancel]`. Ported faithfully from
desktop-plus's `OkCancelButtonGroup` and already correct in rdc's migrated dialogs — keep it.

---

## Component 1 — Hook failure (`AlertDialog`)

| Dimension | rdc today | desktop-plus | shadcn/Radix default | Verdict |
|---|---|---|---|---|
| Labels | "Ignore and Continue" / "Abort" | identical | — | **AGREED** |
| Button order | macOS `[Abort, Ignore]`, else `[Ignore, Abort]` | same rule | — | **AGREED** (Convention 2) |
| Escape / backdrop | no-op — decision required | modal, no dismissal | `AlertDialog` blocks both | **AGREED** |
| Element semantics | `AlertDialog` | modal dialog | — | **AGREED** |
| Focus on open | **first tabbable** → the destructive *Ignore* on Linux | safe action (`destructive={true}`) | `AlertDialogCancel`, if used | **FIX** (Convention 1) |
| Destructive visual | solid red fill, light text (`.destructive-button`) | solid red fill (`--button-destructive-background: $red-100`) | soft 10%-tinted red (`Button variant="destructive"`) | **DECIDE** |

### The one open decision

Adopting `AlertDialogCancel`/`AlertDialogAction` is what restores the focus behaviour, but those
wrappers style themselves through shadcn's `Button` variants — `outline` for cancel, and a soft
`bg-destructive/10` tint for destructive. rdc and desktop-plus both use a **solid** red fill. So the
focus fix and the button's appearance are coupled, and the choice is:

- **(a) Keep the solid fill.** Match rdc and desktop-plus; override the variant styling on the
  Radix primitives so the appearance is unchanged and only focus behaviour moves.
- **(b) Adopt shadcn's soft tint.** Fewer overrides and closer to stock shadcn, but a visible change
  to every destructive dialog and a departure from two of three sources.

Whichever is chosen becomes **Convention 3**, applying to Discard file, Discard all, Delete branch
and Remove repository — all of which have the same solid/soft question waiting.

### Blocked on this

Two E2E specs assert the pre-migration labels and the pre-migration focus order, so they fail on
`origin/main` today (`keyboard.test.mjs`, `working-tree.test.mjs` — 26/28). They are stale, not
broken: the labels they expect were rdc's own divergence, and the focus order they assert is the
one Convention 1 restores. Both get updated once the decision above lands, so they encode decided
behaviour rather than whatever Radix happens to do.
