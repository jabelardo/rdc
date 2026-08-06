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

---

## Component 3 — Destructive confirmation family

Migrated as one family, because they share a single shape: **Discard file**, **Discard all**,
**Delete branch**, **Remove repository**, plus the "Cannot delete branch" refusal that was crammed
into the delete-branch `Modal` and is really an informational dialog.

Seven of the ten rows arrived already settled, so review concentrated on three.

| Dimension | rdc today | desktop-plus | shadcn/Radix | Verdict |
|---|---|---|---|---|
| Element semantics · Escape · order · safe default · destructive tint · footer · scale | — | — | — | **SETTLED** (C1–C5) |
| Escape while the operation is in flight | blocked (`onDismiss={undefined}`) | blocked (`dismissDisabled`) | **closes** | **FIX** → Convention 8 |
| Checkbox primitive | raw `<input type="checkbox">` | custom `Checkbox` | shadcn `Checkbox` | **AGREED** → shadcn |
| Long path rendering | raw, can overflow | `PathText` middle-elision | — | **DECIDED** → wrap |
| Warning icon | hook-failure only | amber gutter icon on all | none | **DECIDED** → inline in title |
| Inline "don't show again" | none (Preferences only) | checkbox in the dialog | — | **DECIDED** → yes |
| Discard-all file identification | count only | up to 10 paths, then a count | — | **DECIDED** → port the rule |

### Resolved

- **Warning icon inline in the title**, in `var(--warning-text)`. Extends what the hook-failure
  dialog already shipped rather than adopting desktop-plus's gutter, which would cost horizontal
  space and new layout CSS in the shared primitive.
- **Inline opt-out**, ported *including* its subtlety: the preference is written when the user
  **confirms**, not when the box is ticked. Ticking and then cancelling leaves the guard intact, so a
  change of mind never removes a confirmation on an irreversible action. Offered only for a
  whole-file discard — a line-level discard confirms regardless of the preference, so an opt-out
  there would promise to silence a dialog that would keep appearing.
- **Every path is listed, with no cap.** This started as desktop-plus's rule ported as-is — list up
  to ten, then a bare count — and was corrected once the realistic case was considered: a
  hundred-file discard is common, and under that rule it told you *nothing* about which files it
  covered, exactly when you most want to check. The list now lives in a fixed-height scroll region,
  so ten paths and ten thousand cost the same vertical space, and `VirtualList` windows the DOM past
  a hundred rows so the large case is not paid for by the small one. desktop-plus's cap was a
  limitation worth *not* porting.
- **Long paths wrap, they do not truncate.** desktop-plus middle-elides because it forces one line;
  a dialog with room to wrap loses nothing. rdc's own `truncateWithEllipsis` would be the wrong tool
  either way — it cuts the *end*, destroying the filename, which is the part you need to recognise.

### Reading order

Putting the question in `description` and the consequence in `children` is deliberate. The first
attempt had the header's description carry the consequence, which reads backwards — "Changes can be
restored from the trash" before "Are you sure you want to discard Alpha.ts?". The description is
also what Radix announces, so the question belongs there.

### The abstraction

`ConfirmDialog` (`src/lib/ui/dialogs/confirm-dialog.tsx`) encodes Conventions 1, 2, 4, 5 and 8 once
instead of restating them in four places — the same role desktop-plus's `OkCancelButtonGroup`
played. `NoticeDialog` covers the refusal case under Conventions 6 and 7. Four dialogs' worth of
hand-written markup left `app-dialogs.tsx`, and `.destructive-button` left `App.css` with zero
consumers, per Convention 3.

### Resolved → Conventions 8, 9 and 10

- **Convention 8 — dismissal is one guarded path, and it is refused mid-operation.** Route Escape,
  the Cancel button and any future dismissal through a single `onOpenChange` handler, and refuse all
  of them while the confirmed operation is in flight: losing the dialog then leaves the user with no
  indication of whether it completed. Radix's `AlertDialogAction` is a `Dialog.Close`, so an async
  action must `event.preventDefault()` in its `onClick` — the close runs through
  `composeEventHandlers`, which skips it when the event is already default-prevented. Verified
  against the installed source, not assumed.
- **Convention 9 — rdc's element defaults stop at shadcn's door.** Bare-element rules in
  `@layer base` must exclude vendored primitives with `:not([data-slot])`. `button`'s
  `padding: 6.5px 9.75px` reached inside the Radix Checkbox, and since padding cannot shrink below
  its own size, a `size-4` (16px) checkbox rendered ~21.5px wide against a 16px height — a
  rectangle. What is genuinely universal stays unscoped: `cursor: pointer` applies to every button,
  because Tailwind's preflight does not set it and shadcn's components assume it comes from here.
- **Convention 10 — a warning is not an error.** Text describing what confirming will *cost* takes
  the `--warning-*` tokens, not `--error-*`, and carries no `role="alert"`: it is present when the
  dialog opens, the dialog is already announced, and announcing it again as an interruption is
  wrong. `role="alert"` is for something that arrives *after* the dialog is up — a failure.

### Two bugs that only a browser could see

Both were reported from the running app after the automated gate was fully green, which is worth
recording as evidence for how much the human pass still carries:

- **Every confirmation stretched to the window width.** `AlertDialogContent` had `w-full` with no
  `max-w`, while `DialogContent` had `max-w-[calc(100%-2rem)] sm:max-w-lg` — which is exactly why
  About looked right and these did not. The two primitives now size identically. The hook-failure
  override moved to `sm:max-w-[600px]` so `twMerge` drops the shared ceiling instead of the
  breakpoints tying; confirmed by running `twMerge` rather than reasoning about class order.
- **The checkbox was a rectangle** — Convention 9 above.

`e2e/discard.test.mjs` now asserts both in a real browser: dialog width against the window, and the
checkbox's width against its height. Both assertions carry **lower** bounds too, because a 0-width
dialog would satisfy "narrower than the window" and a 0x0 checkbox would satisfy "square" — the same
dead-assertion trap this repo has hit before.

### Icon libraries → Convention 11

This section originally recorded a *split* — lucide inside `src/components/ui/**`, FontAwesome in
rdc's own components — as the rule. That was superseded within the day, so the reasoning is worth
keeping: the split was described as "already existing by accident", which was the tell that it was a
habit rather than a decision.

**Convention 11 — lucide is rdc's only icon library.** FontAwesome was removed entirely. The case
was measured, not argued: FA cost **28.7 KB gzipped against 1.6 KB** for the same 30 icons, because
FA ships a runtime core while lucide's `createLucideIcon` was already in the bundle for shadcn.
Removing it took the real bundle from 213,795 to 188,511 gzipped, **-11.8%**.

Two structural gains beyond size:

- `@fortawesome/fontawesome-svg-core` was a peer of `react-fontawesome` that pnpm auto-installed and
  `package.json` never listed. It worked, but nothing pinned it — a stricter installer would have
  broken the build.
- FA sized icons through a **runtime-injected stylesheet**; its emitted SVG carried no `width` or
  `height` at all. That is the same fragility class as the sonner stylesheet that broke the toolbar
  at 715px (Component 1). lucide emits plain attributes.

**Geometry was held constant so the visual review judged one variable.** FA rendered at `1em`;
`LucideProvider` applies `size-[1em]` as a *class* rather than the `size` prop, because lucide types
`size` as a number while CSS `width`/`height` override SVG presentation attributes anyway. The two
explicit sizes in `App.css` (`.working-tree-file-status svg`) are unlayered and still win, keeping
the status glyphs at their designed 7.8px and 13px.

A caution for the next icon change: **tests must not identify an icon by a library-specific
attribute.** Eleven assertions keyed off FA's `data-icon` and one E2E assertion did too; all had to
move to lucide's `class="lucide lucide-<name>"`. Prefer asserting on the accessible name of the
control instead, which survives a library swap.

---

## Component 4 — Rename branch (`Dialog`)

The simplest non-destructive form dialog. Every row was already settled by existing conventions —
the review table shrank to zero genuine decisions, exactly as the process intended.

| Dimension | rdc today | desktop-plus | shadcn/Radix default | Verdict |
|---|---|---|---|---|
| Element semantics | hand-rolled `Modal` | modal dialog | `Dialog` (not `AlertDialog` — nothing to confirm) | **SETTLED** (Convention 6) |
| Escape / backdrop | dismisses | dismisses | dismisses | **AGREED** |
| Button order | N/A (Cancel + submit) | N/A | — | **SETTLED** (Convention 2) |
| Default action | Rename (submit) | Rename (submit) | — | **SETTLED** (Convention 7 — Cancel is outline, Rename is default) |
| Footer / separator | — | — | — | **SETTLED** (Convention 5) |
| Scale and type | — | — | — | **SETTLED** (Convention 3) |
| Close button | none | footer only | X by default | **SETTLED** (Convention 6 — footer has Cancel, no X) |
| Icon | none | none | — | **SETTLED** (Convention 11 — n/a) |
| Disabled state | Rename disabled when name empty or unchanged | same | — | **AGREED** |

No conventions created or modified. This dialog exercises Conventions 2, 3, 5, 6 and 7 but
introduces no new behaviour.

---

## Component 5 — Merge picker (`Dialog`)

A form dialog with two modes: an informational "no branches" state and a branch-select state.
Conditionally dismissible (blocked while `mergeRunning` is true).

| Dimension | rdc today | desktop-plus | shadcn/Radix default | Verdict |
|---|---|---|---|---|
| Element semantics | hand-rolled `Modal` | modal dialog | `Dialog` | **SETTLED** (Convention 6) |
| Escape / backdrop | blocked while running | blocked while running | dismisses | **SETTLED** → Convention 8 pattern (`onOpenChange` guard) |
| Button order | macOS `[Cancel, Merge]`, else `[Merge, Cancel]` | same rule | — | **SETTLED** (Convention 2) |
| Default action | Merge (not destructive — merges are reversible via reset) | same | — | **SETTLED** (Convention 7 — Cancel is outline, Merge is default) |
| Footer / separator | — | — | — | **SETTLED** (Convention 5) |
| Scale and type | — | — | — | **SETTLED** (Convention 3) |
| Close button | none | footer only | X by default | **SETTLED** (Convention 6 — footer has Close/Cancel) |
| Error display | `.application-error` class | — | — | **FIX** → `--error-*` tokens (interim rule) |
| "No branches" state | plain text + Close button | — | — | **AGREED** → single Close button, `variant="default"` (Convention 7) |
| Busy label | "Merging…" | same | — | **AGREED** |

### Resolved

- **Error tokens switched from `.application-error`** to `--error-*` tokens during migration,
  per the interim rule in COMPONENT_MIGRATION_PROCESS.md's open decisions. This is the fifth
  consumer of the error styling pattern.
- **"No branches" Close is `variant="default"`** (Convention 7) — with no competing action,
  solid reads as the obvious target.

No new conventions created.
