# Component migration — the three-way review process

**Status**: active. Dialogs first; the same process applies to every component family after.

**Queue.** Migrated and approved: hook failure, About, discard file, discard all, delete branch
(+ the "cannot delete" notice), remove repository, manage remotes, add remote, rename branch, merge.
The queue is empty: rebase (scoped in `BRANCH_OPERATIONS_PLAN.md` § "Amended scope") and clone both
landed, and Preferences and Manage remotes were migrated and then redesigned — see Components 7
and 8. Seventeen conventions in, a typical
table resolves to one or two genuine decisions, which is what the process was for; Preferences had
four, because a category layout is a design question rather than a port.

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
5. **Implement**, then **add the component's rows** to
   [`qa/phase-8b/dialog-migration-checklist.md`](./qa/phase-8b/dialog-migration-checklist.md) —
   see the QA-placement rule immediately below. Writing the rows is development work; walking them
   is not.

The payoff compounds: each component only needs review of what is *new*. By the third or fourth
dialog most rows should read `SETTLED`, and the table shrinks to the genuine deltas.

### Where QA happens

**A development slice never blocks on human sign-off.** Its exit criteria are automated: unit,
component, native and container-E2E evidence. What it owes the human cycle is *rows* — the specific
things a person must look at, written down while the author still remembers what changed.

Human visual, accessibility and platform verification belongs to `MIGRATION_PLAN.md` Phase 8b, which
is deliberately **one consolidated iterative QA cycle** rather than a sign-off gate attached to each
slice. Phase 8a prepares the fixtures and checklists; 8b runs them, finds defects, and loops through
fixes until no agreed blocker remains.

So, concretely:

- A slice may not list "human Light/Dark check" or "visual sign-off" among its exit criteria.
- A slice **must** leave its rows in the right `qa/phase-8b/` checklist, specific enough to walk
  without rediscovering the feature.
- A development plan may *reference* the QA cycle; it may not *own* it. "Slice N records human
  sign-off" is the shape to avoid.
- If a design question genuinely cannot be answered without looking at the running app, that is an
  **open decision with an empirical check**, not QA. Name it, say exactly what observation settles
  it, and block the dependent slice on the answer — see `MESSAGE_SYSTEM_PLAN.md`'s in-dialog
  failure decision for the worked example. The difference matters: an open decision blocks *design*
  and is cheap to answer; QA sign-off blocks *shipping* and costs a full cycle.

This rule exists because QA attached to individual slices fragments the cycle: the same fixture gets
built repeatedly, a person is pulled in mid-development to approve something still expected to
change, and the recorded result is invalidated by the next slice touching the same surface.

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

| Decision | Raised by | Settled |
|---|---|---|
| Where an in-dialog operation failure appears — inline, or as a toast | Destructive confirmation family (Discard file/all, Delete branch, Remove repository) | **Settled 2026-08-15 → Convention 17.** Inline, in the dialog that owns the action. See `MESSAGE_SYSTEM_PLAN.md` § *Settled* for the measurements. |

Deferring this one was the right call rather than a punt, and the deferral paid for itself. The
strongest-looking option ("toast, dialog stays open") had a failure mode that was *empirically
checkable* rather than arguable, and there was no working toast to check against until the message
system existed. When it was finally checked, the feared failure — a toast overlapped by the modal —
did not occur at all, and a different one did: behind a modal the toast is visible but inert, so it
cannot be dismissed. Reasoning would have picked the wrong option for the wrong reason.

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
- **Convention 17 — a dialog owns the failure of the action it confirmed, and never traps the user
  with it.** Settled 2026-08-15 in `MESSAGE_SYSTEM_PLAN.md` after measuring the alternative: behind
  a Radix modal a toast is visible but *inert*, because the modal sets `pointer-events: none` on
  `<body>` and sonner never re-enables it — so an error toast raised from a dialog cannot be
  dismissed until the dialog closes. Three rules follow, and the second is the one that is easy to
  get wrong:
  - A failure renders **inline in the dialog that owns the action**. Only an ownerless failure goes
    to the message system. The test is *ownership*, not *what happened to be on screen*.
  - **A dialog that can show a failure may not dismiss optimistically.** Several confirm handlers
    null their dialog state *before* awaiting the action, which quietly converts every failure into
    an ownerless one and defeats the rule above by making the dialog vanish. Close on success;
    stay open and render inline on failure.
  - **Cancel/Close must be enabled again once the action is no longer in flight.** This composes
    with Convention 8 rather than contradicting it: refuse dismissal *during* the operation, always
    permit it *after* a failure, so a user who cannot or will not retry is never stuck in a dialog
    that keeps failing.
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

The first dialog with a text field, so it settles the field conventions Clone and Preferences will
inherit. An earlier pass recorded this as introducing nothing; finishing it showed otherwise.

| Dimension | rdc today | desktop-plus | shadcn/Radix | Verdict |
|---|---|---|---|---|
| Element semantics · Escape · order · footer · scale · close affordance | — | — | — | **SETTLED** (C2, C3, C5, C6, C7) |
| Field primitive | hand-rolled `<input>` with a raw utility string | `RefNameTextBox` | `Input` + `Label` | **AGREED** → shadcn |
| Name validation | empty and unchanged only | sanitises as you type, warns "will be saved as" | — | **DECIDED** → validate and explain |
| Failure feedback | **none** — a rejected rename showed no reason | dispatcher-level | — | **FIX** |
| Busy state | none | — | — | **FIX** |
| Focus on open | input focused | close button focused | first tabbable | **DECIDED** → input, text selected |
| Where messages appear | inline, moving the layout | inline | — | **DECIDED** → Convention 12 |

### Resolved

- **Validate and explain, rather than sanitise silently.** The user keeps what they typed and a
  message says why it cannot be used; nothing rewrites the field under them. `sanitizedRefName` had
  been ported for exactly this and had **zero callers**, so anything but empty-or-unchanged reached
  git and failed after the fact. Messages name the specific rule — "cannot contain spaces" — because
  "invalid branch name" leaves the user hunting for the character.
- **A collision is caught before git sees it**, using `branchState.branches`.
- **The existing name is selected on open**, so typing replaces it while a small correction is still
  possible. desktop-plus focuses its close button instead; that was not worth porting.
- **`DialogActions`** extracts Convention 2's platform ordering for ordinary `Dialog` footers, the
  job `ConfirmDialog` does for `AlertDialog`. Two hand-written `__DARWIN__` ternaries in one file are
  two chances to get the order backwards.

---

## Component 5 — Merge (`Dialog`)

Reviewed twice. The first pass was abandoned mid-flight with four features written and commented
out — the branch selection was computed and never rendered, the preview was complete but not shown,
and the failure message likewise — so the dialog greyed out its own action with no explanation. That
is worth recording: **commented-out code in a dialog reads to the user as a broken feature, not as
unfinished work.**

| Dimension | rdc today | desktop-plus | shadcn/Radix | Verdict |
|---|---|---|---|---|
| Element semantics · Escape · order · footer · scale · busy guard | — | — | — | **SETTLED** (C2, C3, C5, C6, C7, C8) |
| Strategy choice | merge only | split button switching **operation** | — | **DECIDED** → split button, merge + squash |
| Rebase | absent | third option in the same control | — | **DECIDED** → its own dialog |
| Default strategy | n/a | n/a | — | **DECIDED** → a persisted preference |
| Conflicts | blocked | **allowed** — resolved afterwards | — | **FIX** → allow |
| Loading | allowed | blocked | — | **FIX** → block |
| Branch rows | sidebar's `.branch-list-selection` | `BranchList` | — | **FIX** → own layout |
| Keyboard | Tab only | arrow keys | — | **DECIDED** → both |

### Resolved

- **Rebase is a separate dialog**, because it inverts the direction: merge and squash ask "bring what
  in?" and the picked branch is the *source*; rebase asks "put mine on top of what?" and it is the
  *base*. The fixed side is the current branch in all three. desktop-plus reaches the same conclusion
  structurally — its dropdown dispatches a different operation and replaces the dialog. The
  one-dialog alternative was rejected on evidence: Atlassian still has an open issue
  ([SRCTREE-1578](https://jira.atlassian.com/browse/SRCTREE-1578)) about users reading the direction
  backwards in SourceTree, which is what a self-relabelling dialog invites.
- **The confirm button names the whole sentence** — "Merge into main", not "Merge" — for the same
  reason. Direction is the thing users get wrong.
- **Squash cost no backend work.** `MergeOptions { squash }` was complete and `merge()` already
  followed it with `git commit --no-edit` under the correct second hook set; `branch-store` was
  dropping the option.
- **Already-merged branches are filtered out**, matching on **SHA as well as ref**, which is what
  lets one `git branch --merged` also account for remote branches.

### Resolved → Conventions 12–15

- **Convention 12 — all of a dialog's messages share one slot, and the slot holds its height.**
  Jose's rule, and the strongest layout constraint the migration produced. A message appearing as the
  user types would otherwise move the confirm button out from under their cursor at the worst
  possible moment. One slot forces a priority order — failure, then validation, then context — which
  is a feature: it says which fact matters most. When there is nothing to report the slot says what
  the space is for rather than sitting blank, which reads as an unexplained gap. `DialogMessage`.
- **Convention 13 — a control in two halves shares one state.** The split button's caret greys with
  the action beside it; a lit caret next to a greyed confirm reads as two unrelated buttons.
- **Convention 14 — a dialog must fit the viewport in both axes.** `DialogContent` had no
  max-height, so a tall dialog centred with `-translate-y-1/2` overflowed equally above and below and
  slid under the macOS title bar — which web content can never paint over. Both primitives now cap
  height and scroll internally. This is the third geometry bug of the same family (missing max-width,
  the rectangular checkbox), so `e2e/discard.test.mjs` asserts dialog geometry with **lower bounds as
  well as upper ones**: a zero-width dialog satisfies "narrower than the window", and a 0×0 checkbox
  is "square".
- **Convention 15 — a list is unambiguous before it is pretty.** Two rows read "develop" while a
  remote's prefix was stripped in favour of a badge. Remotes keep their prefix. A picker that cannot
  distinguish two options has failed at its only job.

### Keyboard, after three attempts

Worth recording because the first two looked right and were not:

1. Options as buttons, arrows via the shared helper — **focus never moved from the filter field**,
   because `handleListNavigation`'s fallback walks up from the event target to `[data-keyboard-list]`
   and the filter field is a *sibling* of the list. Silent no-op. That constraint is now documented
   on the helper.
2. A roving `aria-activedescendant` listbox — fixed the arrows but **took Tab away**, which was a
   regression, not a trade.
3. What shipped: rows stay individually focusable so **Tab steps through them**, arrows move focus
   **by ref** rather than by DOM search, and each move pairs with
   `scrollIntoView({ block: "nearest" })` so arrowing past the last *visible* row scrolls instead of
   escaping to the action button.

**The lesson generalises: a keyboard test that asserts only the selection callback proves nothing.**
Both failing attempts passed their tests. Assert `document.activeElement`.

### Debug data is part of the component

Mergeability is computed by git, so stub branches produced no state at all and the dialog could not
be reviewed from Help → Show Dialog. The stubs now carry canned previews reaching every state the
dialog renders differently — clean at 1, 4 and 1284 commits for the singular, plural and thousands
wordings; conflicts; unrelated histories; one already-merged branch so the filter has something to
remove; and one branch too long for its row so the tooltip has something to reveal.

**`inject-test-state.test.ts` asserts that coverage**, because stub data that stops exercising a
state fails silently: the preview still looks correct and proves nothing. The `mergeStates` QA
fixture covers the same three outcomes with real ancestry, so canned answers prove the dialog
renders each state and real git proves the answers are right.

## Component 6 — Clone repository (`Dialog`)

The last of the three form dialogs with required inputs, and the first dialog that runs a long
operation *inside itself* (a clone stays open, surfacing progress), which is the one dimension that
made it more than a mechanical copy of Rename branch.

| Dimension | rdc today | desktop-plus | shadcn/Radix | Verdict |
|---|---|---|---|---|
| Element semantics | hand-rolled `Modal` | `Dialog` + `TabBar` | `Dialog` | **SETTLED** (C6, Component 4) |
| Title | `<h2>` | "Clone a repository" | `DialogHeader`/`DialogTitle` | **SETTLED** |
| Focus on open | first tabbable | URL `TextBox` autoFocus | first tabbable | **AGREED** → URL `Input` |
| Escape / backdrop | blocked in-flight (`onDismiss=undefined`) | blocked while loading | dismisses | **SETTLED** (C8) |
| Button order | `[Cancel, Clone]` always | `[Cancel, Clone]` mac / else `[Clone, Cancel]` | — | **SETTLED (FIX)** (C2 — rdc's always-Cancel-first was wrong on Linux) |
| Default / destructive | Clone, non-destructive | same | — | **SETTLED** (C2/C7 — Clone is the natural default, no destructive treatment) |
| One close affordance | footer Cancel | footer Cancel | X by default | **SETTLED** (C6 → `showCloseButton={false}`) |
| Fields | `<label>`+`<input>` | `TextBox` | `Input` + `Label` | **SETTLED** (Component 4) |
| Empty url/path | enabled, fails on submit | Clone **disabled** when url/path empty | — | **DECIDED** → C16 |
| Message slot | inline, moving layout | `DialogError` | — | **SETTLED** (C12 — one height-holding slot) |
| Error display | `.application-error` | `DialogError` | — | **SETTLED** (`--error-*` tokens + `role="alert"`; arrives after open, so C10 does not apply) |
| Progress | shared `OperationProgressDialog` replaces the form while running | in the toolbar | none vendored | **DECIDED** → category 1 blocking dialog |
| Wording | "Repository URL" / "Destination path" | "…GitHub username and repository (hubot/cool-repo)" / "Local path" | — | **DECIDED** → keep rdc's honest labels |
| Viewport fit | — | — | `DialogContent` caps height | **SETTLED** (C14) |

### Resolved → Convention 16

**Convention 16 — a form dialog's affirmative stays disabled until its required fields are valid,
and the message slot says what is missing instead of the submit failing after the fact.**
Rename and Add remote already half-obeyed this; Clone made it explicit. desktop-plus's `okButtonDisabled`
disables on url/path empty; rdc used to enable the button and let the store error ("Enter a repository
URL.") fire on submit. The disabled-button-plus-explanation wins: it is discoverable (the slot names the
missing field) and it cannot fail *after* the fact. `confirmDisabled` is independent of `busy` — a form
is invalid long before it is running.

### Resolved → departures recorded for §8

- **Progress stays in the dialog.** desktop-plus shows clone progress in its toolbar; rdc keeps the
  dialog open for the whole clone, replacing the form with the shared, undismissable
  `OperationProgressDialog`. The progress dialog owns the themed bar and `role="status"` row, so
  the feedback belongs where the user acted. Not a shadcn decision — shadcn has no vendored
  `Progress` here — it is an rdc information-architecture choice.
- **The `hubot/cool-repo` hint is dropped, deliberately.** The "Repository URL or GitHub username and
  repository" label only makes sense with the GitHub-account shortcuts rdc does not have (git cannot
  clone a bare `owner/repo`), so echoing it would be a lie. rdc keeps "Repository URL" and
  "Destination path".
- **No `TabBar`.** desktop-plus renders account tabs (GitHub.com / GitLab / Bitbucket / …); rdc has no
  accounts, so the URL tab is the whole dialog. A future accounts slice reintroduces the tab bar there,
  not here.

## Component 7 — Preferences (`Dialog`, category layout)

Raised by visual validation, 2026-08-15: the dialog did not fit the design criteria, and — the
larger problem — a flat two-column grid of six settings had nowhere to put a seventh. desktop-plus
carries nine categories' worth of settings, so the growth pressure is real and already visible
upstream. This is a redesign, not a markup swap.

| Dimension | rdc before | desktop-plus | shadcn/Radix | |
|---|---|---|---|---|
| Navigation | none — flat grid | vertical `TabBar`, 9 categories, icon + label | `Tabs`, vertical orientation | `DECIDE` → vertical rail |
| Category set | n/a | 9, two conditional | n/a | `DECIDE` → only populated ones |
| Width | 442px | 600px | — | `DECIDE` → 600px |
| Content height | content-sized | 440px cap on variable tabs | — | `DECIDE` → fixed |
| Selection persistence | n/a | none, resets to first | — | `AGREED` |
| Category keyboard nav | n/a | arrows cycle and wrap | Radix gives this from `orientation` | `AGREED` |
| Save model | live-apply | Cancel/Save footer | — | `AGREED` → keep rdc's |
| Close affordance | footer Close | Cancel/Save | — | `SETTLED` → Convention 6 |
| Height bounded | no | yes | — | `SETTLED` → Convention 14 |
| Styling | 48 lines in `App.css` | SCSS | Tailwind | `SETTLED` → Convention 3 |

### Resolved

- **Vertical rail, not horizontal tabs.** A tab strip stops scaling at roughly five or six at this
  width, which is exactly the growth the redesign exists for. The rail grows downward and the dialog
  does not move.
- **Only categories that have settings.** Appearance (theme, zoom), Integrations (editor, shell),
  Git (default merge), Prompts (the three confirms). An empty category is a promise the app does not
  keep; adding one later costs a trigger and a panel.
- **600px, fixed content height.** With a rail this is no longer a simple dialog, so it takes the
  guideline's data-dense tier. Fixed height because categories differ in length and sizing to
  content makes the dialog jump every time the user switches — the rail stays put, the panel
  scrolls.
- **Live-apply stays.** desktop-plus has a Cancel/Save footer; rdc writes each setting immediately
  and keeps a single Close. Importing the Save model would have been a behaviour change smuggled in
  behind a layout change.

### Radix supplies the keyboard behaviour, and that is why `orientation` matters

`Tabs` gives roving focus and arrow-key movement from its `orientation` prop — vertical yields
up/down. Nothing here hand-rolls it, but a silent default to horizontal would give left/right and
nobody would notice until they tried, so there is a test for it.

## Component 8 — Manage remotes (`Dialog`, growable list)

Raised by the same visual-validation pass as Component 7, with two asks: handle a list of remotes
that can grow, and use icons rather than words on some buttons. Unlike Preferences, desktop-plus has
a real precedent here — `manage-remotes-dialog.tsx` and `remote-list-item.tsx` — so this is closer to
a port than a design.

| Dimension | rdc before | desktop-plus | rdc's own precedent | |
|---|---|---|---|---|
| Row layout | `**name** url` in one span, wrapping | icon → name → url → action, both truncated | — | `DECIDE` → follow desktop-plus |
| Remove action | text button | icon-only trash, tooltip + aria-label | changed-files: icon, **hover-revealed** | `DECIDE` → icon, always visible |
| Add action | text button | — | — | `DECIDE` → icon |
| Long lists | unbounded, dialog grows | fixed height, bordered, rows divided | `VirtualList` past 100 items | `DECIDE` → fixed height + scroll |
| Width | 600px | 500px | — | `SETTLED` → the data-dense tier, `sm:max-w-xl`; see Convention 18 |
| Icon library | — | octicons | — | `SETTLED` → Convention 11, lucide |
| Buttons | bare `<button>` | — | vendored `Button` | `SETTLED` |

### Convention 18 — dialog widths are Tailwind steps, stated explicitly

Settled 2026-08-16. Before it, the app had seven widths — an inherited `sm:max-w-lg`, plus 400, 420,
440, 480, 520 and 600 — and nothing said which was right. The tell was the **512 against 520**: an
inherited default and an override eight pixels apart cannot both be deliberate.

**Every width is now a step on Tailwind's scale, and every dialog names its own.** shadcn's default
is `sm:max-w-lg` (32rem/512px) and the scale runs sm 384 · md 448 · lg 512 · xl 576 · 2xl 672, so
the ad-hoc numbers were all within 36px of a step already — consolidating cost almost no layout.

| Tier | Width | For | Dialogs |
|---|---|---|---|
| `sm:max-w-sm` | 384 | one field, or a few lines | Rename branch, About |
| `sm:max-w-md` | 448 | a short form | Clone, Add remote, Operation progress |
| `sm:max-w-lg` | 512 — **shadcn's default** | a decision, or a picker | Confirm, Notice, Merge, Rebase |
| `sm:max-w-xl` | 576 | data-dense: lists, tabs, terminal output | Preferences, Manage remotes, Hook failure |

Two rules, and the second is the one that decayed last time:

1. **Pick a tier, never a number.** No `sm:max-w-[520px]`. If a dialog seems to need a value between
   two steps, it is the content that needs revisiting.
2. **State it even when it is the default.** `ConfirmDialog` and `NoticeDialog` used to get 512 by
   not choosing, which is exactly why 520 could sit beside it for months looking intentional. An
   inherited width is invisible; a stated one gets compared.

`sm:max-w-2xl` (672) is deliberately unused: the window's floor is 715px wide, so a 672px dialog
leaves 43px of surround and stops reading as a dialog.

### Resolved

- **Always-visible remove, against rdc's own hover-reveal precedent.** The changed-files list hides
  its discard icon until the row is hovered. That is defensible for a frequent, per-file action in a
  long list; it is the wrong trade for a rare destructive one, and hover does not exist on touch.
  The inconsistency is deliberate and recorded here so the next reviewer does not "fix" it.
- **Fixed height and scroll, not virtualization.** `VirtualList` only engages past 100 items and a
  repository with 100 remotes does not happen. Ordinary scroll inside a bordered region is what
  desktop-plus does and what the content warrants.
- **Rows divided, not gapped.** Contiguous rows inside a border read as one list, which is what a
  scroll boundary needs to look like; gapped rows read as separate cards that happen to be clipped.

### The dialog moved to its own file

`app-dialogs.tsx` was 91 lines longer for holding this inline, and the list had **no functional test
coverage at all** — the only reference to it in the suite was a menu-inventory entry. Every other
dialog of this size already lives in `lib/ui/dialogs/`, so extracting it followed the existing
shape and gave the filtering, the empty states and the icon buttons' accessible names somewhere to
be tested.

## Progress presentation — categories, mapped from desktop-plus

Raised by the clone dialog's progress indicator (Component 6) and settled here: rdc had never
decided where progress bars belong, and desktop-plus has no single answer either — it has a
*spectrum*, chosen by what the operation does to the repository. The rule that explains the
spectrum: **progress is modal when the operation is the point — the repository's state is
incoherent (the branch tip is moving) or nothing else is worth doing until it resolves (a commit
under way, a clone with no repository yet). It is embedded only where the rest of the app stays
truthful and usable.** Rebase/squash/reorder/cherry-pick move the branch tip commit-by-commit, so
the history list would be misleading mid-flight. A commit pivots the working tree's meaning and a
clone is the whole point of the moment. Those block. Fetch, push, pull and checkout leave the rest
of the app truthful, so they ride in the control you pressed.

**Consolidation.** desktop-plus has five presentations; rdc keeps two categories, each linked to the
*same functionality* they are in desktop-plus:

| rdc category | Operations (desktop-plus link preserved) | Presentation in rdc | Radix primitive |
|---|---|---|---|
| **1. Blocking progress** | Rebase, cherry-pick, squash, reorder (history moves) · merge and revert while they run · **clone** · **commit** | A **dedicated, separate progress dialog** that replaces the action dialog the moment the operation starts (desktop-plus's step swap: `ChooseBranch` → `ShowProgress`, exactly its `multi-commit-operation/dialog/progress-dialog.tsx`). Title "X in progress"; a bar — "commit N of M" + current summary for the history moves, title + bar + description for clone, title + terminal/hook output for commit. **Not an embedded bar inside the action dialog.** The current implementation is undismissable. An optional Cancel/Stop control is permitted only when the native operation record declares that capability and the operation-specific cancellation and recovery path has been proven. The modal belongs to the initiating window; same-repository windows mirror its state, while windows for other repositories remain usable | **AlertDialog** — Radix's nondismissable primitive, mirroring desktop-plus's `dismissDisabled`. The action dialog that precedes it stays a `Dialog` (it needs a picker); the progress dialog replaces it; any cancel, abort, or recovery decision is capability-driven |
| **2. Embedded background progress** | Fetch, push, pull, checkout | Non-modal bar/percent **in the control that was pressed** — toolbar remote status, sidebar checkout row. The app stays usable | None needed (plain markup) |

**What this means for existing and planned rdc surfaces:**

- **The first step is creating the shared progress dialog itself** — the single component every
  category-1 operation mounts (rdc's translation of desktop-plus's `dialog/progress-dialog.tsx`):
  an undismissable `AlertDialog` with a themed bar and a per-operation content slot. The current
  implementation remains nondismissible; future cancellation is governed by the native operation
  contract and `OPERATION_PROGRESS_PLAN.md`, not by a button added ad hoc to an individual dialog.
- **Clone is category 1.** When cloning starts, the clone dialog gives way to the dedicated
  progress dialog ("Cloning in progress": title, bar, description, destination) — not a bar
  embedded in the form.
- **Commit is category 1.** The Changes pane starts the commit, then rdc mounts the shared
  undismissable progress dialog ("Committing in progress") with the live terminal stream as its
  operation-specific content. When an intercepted hook needs a decision, the hook-failure dialog
  temporarily owns the modal layer; the commit progress dialog returns after Abort/Ignore resolves.
- Fetch/push/pull and checkout are **category 2** — rdc already shows their text and percentage in
  the toolbar and sidebar; only the bar is missing, and it must be the same small embedded element
  everywhere, not a dialog.
- The history operations planned in `HISTORY_OPERATIONS_PLAN.md` (cherry-pick, squash, reorder,
  and revert's conflict step) own **category 1**: once confirmed, they swap to the shared progress
  dialog; abort lives in the conflict step — the desktop-plus pattern.
- One shared themed progress bar (the shadcn/Radix `Progress` primitive) serves both categories;
  what differs per category is *where* it is mounted (the dedicated progress dialog / toolbar /
  sidebar), not the element. User-initiated operations may eventually use the unified progress
  dialog, while scheduled/background work remains embedded so unrelated repository windows are not
  blocked.

**Landed:** the shared progress dialog is `src/lib/ui/dialogs/operation-progress-dialog.tsx`
(undismissable `AlertDialog`, themed `Progress` from `src/components/ui/progress.tsx`, a
per-operation content slot) with parameters `operation`, `progress.value/title/description`, the
optional commit-N-of-M, and `children` — so clone, commit and every history operation mount the
same component. **Clone is the first consumer**: its dialog swaps to it when cloning starts
(category 1), and Help → Show Dialog → **Clone in progress…** injects a canned in-flight clone
(`injectCloneProgress`) so the progress step is reviewable from the menu without a real clone; the
preview drives the bar 0→100 frame by frame (value and git line moving on a timeline, then a
synthetic finish), so it exercises the live updates the dialog exists for and still cannot lock the
UI forever. **Rebase is the second consumer:** its existing `IMultiCommitOperationProgress` Channel
now reaches `BranchStore`, and the picker swaps to the shared dialog with “commit N of M” and the
current commit summary while Git replays commits. **Commit is now the third consumer:** the Changes
pane's `commitLoading` state mounts the shared dialog and its bounded terminal buffer is rendered as
the dialog's content. **Merge is now the fourth consumer:** its branch operation publishes a
blocking generic progress state while Git determines and applies the merge. The remaining history
operations are still pending consumers. **Fetch, Push and Pull are now consumers too**, but as
category 1 rather than the category 2 this table assigned them — see the settled contract below for
why the registry's repository lock forced that move. **Checkout** renders the same shared body
inline in the branch sidebar, which is what category 2 now means in practice. Interactive
squash/reorder is not yet a consumer because interactive rebase remains outside the current MVP
scope.

### Final contract, settled by `OPERATION_PROGRESS_PLAN.md` Slice 20

The category 1/2 split above is how the question was *framed*; it is not where it landed, and the
difference is worth stating plainly rather than leaving the table to imply otherwise.

**Fetch, Push and Pull moved from category 2 to category 1.** They were the original examples of
embedded background progress. They are now blocking modal operations, because the operation registry
made them something the table did not anticipate: they take a repository-scoped write lock. An
operation that locks the repository cannot honestly present itself as background work the user may
continue past — every other action in that window is refused for its duration, and a toolbar
percentage that does not say so is a worse lie than a modal. **Checkout is what remains of category
2**, in the branch sidebar.

**One body, two wrappers.** `OperationProgressBody` is the presentation; `OperationProgressDialog`
is that body inside an undismissable `AlertDialog`. The sidebar mounts the body directly. So the
category is not a choice between two components — it is a choice about whether the body is wrapped,
and nothing about the operation's presentation may live in the wrapper. Anything that has to differ
between the modal and the embedded case belongs in the view model
(`operationProgressViewModel`), which is what decides the status line, whether cancellation is
offered, and which of owner/observer/unowned the window is.

**The view model is the whole contract.** A surface rendering progress takes an
`OperationProgressViewModel` and renders it; it does not read the registry, decide its own wording,
or infer its role. That is what makes the states reviewable from
Help → Show Dialog → **Operation progress…**, which builds a real `OperationRecord` and passes it
through the same view model the app uses — a preview that bypassed it would be previewing a
different component than the one that ships.
