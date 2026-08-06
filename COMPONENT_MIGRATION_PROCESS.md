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

## Open decisions

Rows that came up during a component's review, reach further than that component, and were
deliberately **not** settled there. A migration may not quietly resolve one by picking an option.

| Decision | Raised by | Settled in | Interim rule |
|---|---|---|---|
| Where an in-dialog operation failure appears — inline, or as a toast | Destructive confirmation family (Discard file/all, Delete branch, Remove repository) | `MESSAGE_SYSTEM_PLAN.md` § *Open decision*, before its Slice 1 | Keep the failure text inline; switch `.application-error` → `--error-*` tokens. Never add a new `.application-error` usage — 17 remain in `tsx` and the count only goes down. |

Deferring this one was the right call rather than a punt: the strongest option ("toast, dialog stays
open") has a failure mode — a toast overlapped by, or read as unrelated to, the modal in front of it
— that is *empirically checkable* against a real `sonner` toast and a real Radix overlay, and there
is no working toast to check against until the message system is built.

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

### Convention 2 — platform button order

macOS renders `[Cancel, Ok]`; every other platform renders `[Ok, Cancel]`. Ported faithfully from
desktop-plus's `OkCancelButtonGroup` and already correct in rdc's migrated dialogs — keep it.

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

### Convention 4 — destructive buttons are tinted *and* bordered

Solid (rdc's and desktop-plus's choice) reads too heavy against shadcn's smaller button geometry;
shadcn's stock 10% tint alone does not read as a distinct control beside `outline`. The border
carries the destructive hue rather than `outline`'s neutral grey. See Component 1 for how this was
judged.

### Convention 5 — dialog footers carry no separator or band, and hovers must be real

Applied to the shared `Dialog`/`AlertDialog` primitives, so every dialog inherits it:

- No `border-t` and no tinted band. Removing the band also removes the reason for the
  `-mx-5 -mb-5 … p-5` full-bleed trick, which existed only to paint it edge to edge.
- No margin above the footer: `*DialogContent` is a `grid gap-4`, so a `mt-*` is a second spacing
  mechanism stacked on the first.
- **Check a hover against resolved token values, not class names.** `outline` was `bg-secondary`
  with `hover:bg-muted`, and `--secondary` and `--muted` hold the same value in both themes — so it
  had no hover at all in light mode.

---

## Component 1 — Hook failure (`AlertDialog`)

| Dimension | rdc today | desktop-plus | shadcn/Radix default | Verdict |
|---|---|---|---|---|
| Labels | "Ignore and Continue" / "Abort" | identical | — | **AGREED** |
| Button order | macOS `[Abort, Ignore]`, else `[Ignore, Abort]` | same rule | — | **AGREED** (Convention 2) |
| Escape / backdrop | no-op — decision required | modal, no dismissal | `AlertDialog` blocks both | **AGREED** |
| Element semantics | `AlertDialog` | modal dialog | — | **AGREED** |
| Focus on open | **first tabbable** → the destructive *Ignore* on Linux | safe action (`destructive={true}`) | `AlertDialogCancel`, if used | **FIX** (Convention 1) |
| Destructive visual | solid red fill, light text (`.destructive-button`) | solid red fill (`--button-destructive-background: $red-100`) | soft 10%-tinted red (`Button variant="destructive"`) | **DECIDED** → Convention 4 |

### Resolved → Convention 4

Judged live in both treatments once the layering and scale bugs were out of the way (before that,
*neither* rendered — see Convention 3). Solid read too heavy against shadcn's smaller button
geometry; the stock 10% tint alone did not read as a distinct control beside `outline`. **Tinted and
bordered** was the outcome, with the border in the destructive hue rather than `outline`'s neutral
grey. Applies to Discard file, Discard all, Delete branch and Remove repository when they migrate.

Two further decisions came out of the same pass, both applied to the shared `Dialog`/`AlertDialog`
primitives rather than this one dialog:

- **Footers carry no separator line and no tinted band.** Removing the band also removed the reason
  for the `-mx-5 -mb-5 … p-5` full-bleed trick, which existed only to paint it edge to edge. And the
  footer's `mt-4` went with it: `*DialogContent` is a `grid gap-4`, so the margin was a second
  spacing mechanism stacked on the first, totalling 32px above the buttons.
- **A hover must be a real colour step.** `outline` was `bg-secondary` with `hover:bg-muted`, and
  `--secondary` and `--muted` hold the *same value* in both themes — so it had no hover at all in
  light mode. Check a hover against the resolved token values, not the class names.

### Blocked on this

Two E2E specs assert the pre-migration labels and the pre-migration focus order, so they fail on
`origin/main` today (`keyboard.test.mjs`, `working-tree.test.mjs` — 26/28). They are stale, not
broken: the labels they expect were rdc's own divergence, and the focus order they assert is the
one Convention 1 restores. Both get updated once the decision above lands, so they encode decided
behaviour rather than whatever Radix happens to do.

---

## Component 2 — About (`Dialog`, not `AlertDialog`)

The first non-destructive dialog, so it tests whether the conventions generalise past confirmation
prompts. Six of the eight rows were already settled — the table shrank exactly as intended.

| Dimension | rdc today | desktop-plus | shadcn/Radix default | Verdict |
|---|---|---|---|---|
| Element semantics | hand-rolled `Modal` | modal dialog | `Dialog` (not `AlertDialog` — nothing to confirm) | **AGREED** |
| Escape / backdrop | dismisses | dismisses | dismisses | **AGREED** |
| Footer / separator | — | — | — | **SETTLED** (Convention 5) |
| Scale and type | — | — | — | **SETTLED** (Convention 3) |
| Button order | single button | single button | — | **SETTLED** (Convention 2 — n/a at one button) |
| Default action | Close | Close | — | **SETTLED** (Convention 1 — Close *is* the safe action) |
| Close button style | outline | solid | outline | **DECIDED** → solid `default` |
| Corner X *and* footer Close | X only | footer only | X by default | **DECIDED** → no X |
| Content scope | version only | version, arch, links | — | **DECIDED** → version + arch + links |

### Resolved → Conventions 6 and 7

- **Convention 6 — one close affordance per dialog.** `DialogContent` takes
  `showCloseButton={false}` when the footer already carries an explicit Close. Two controls doing
  the same thing is duplicate-close UX; shadcn's default X exists for dialogs with no footer, which
  is not this one. A dialog whose footer has *no* dismissing action keeps the X.
- **Convention 7 — a dialog's single dismissing button is `variant="default"` (solid).** With no
  competing action there is nothing for an outline to differentiate against, and solid reads as the
  obvious target. This does *not* apply to a Cancel sitting beside an affirmative action, where
  Convention 1 governs and Cancel stays `outline`.

### Also landed

- **`ExternalLink` (`src/lib/ui/external-link.tsx`)** — new shared component. A webview has no
  chrome to get back from, so an anchor that navigates strands the user; this keeps the `href` (so
  the role stays `link` and the URL is inspectable) but cancels navigation and hands the URL to
  `openExternal`, which guards the scheme. Every future dialog and the message system need this.
- **Architecture in the version string.** `getAppArchitecture()` already existed and was unused;
  About resolves it once so a pasted version string carries the architecture it ran under. The
  fetch is `.catch`-logged and the suffix is omitted when it fails, so About never depends on it.
- **Selectable version text** (`select-text`), matching desktop-plus's `selectable-text` on its own
  version string, for the same paste-into-a-bug-report reason.

### Deferred, deliberately

The user asked for "licence / terms links". The **MIT licence link is real** and shipped. Two
adjacent links were *not* added because they would be dead: rdc has no Terms and Conditions (it is
not a hosted service — MIT covers use) and no third-party/open-source notices file yet. Generating
a notices file belongs to Phase 9 (release engineering), where the dependency set is frozen.
