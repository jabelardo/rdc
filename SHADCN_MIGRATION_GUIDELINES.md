# shadcn Migration Guidelines

**Status:** the dialog migration these rules were written for is complete; they stand as the
conventions new components follow. Where a rule here and
[`COMPONENT_MIGRATION_PROCESS.md`](./COMPONENT_MIGRATION_PROCESS.md) disagree, that document wins —
it carries the numbered conventions and the reasoning each was settled with.

**Purpose:** Establish rules for migrating rdc's hand-rolled components to shadcn/Radix primitives. The goal is to adopt shadcn's **component structure** (Radix primitives, accessibility, focus trapping, portal behavior) while preserving rdc's **visual design language** (colors, sizing, fonts, layout) that was established in desktop-plus and refined during Phase 0.

## Core principle

**shadcn provides the behavior, rdc provides the look.** Adopt Radix's accessibility contracts (focus trap, keyboard nav, aria roles, portal behavior) but override visual defaults to match rdc's established design. The visual validation checklist exists because automated gates can't catch "this dialog looks wrong against the app background."

## Guidelines

### 1. Width

| Dialog type | Width | Rationale |
|---|---|---|
| Simple dialogs (About, Preferences, Clone) | 480px (`w-[min(30rem,calc(100vw-2rem))]`) | Matches rdc's existing `confirmationDialogClassName` |
| Content-heavy dialogs (Manage remotes, Hook failure, Merge picker) | 600px | Matches desktop-plus's 500-600px range for data-dense dialogs |
| Narrow dialogs (Remove repository confirmation) | 384px (`sm:max-w-sm`) | shadcn default is fine for simple confirmations |

**Never use shadcn's `sm:max-w-sm` (384px) for dialogs with terminal output, lists, or forms with multiple fields.** The terminal needs 80 columns at monospace 12px ≈ 600px minimum.

### 2. Backdrop

| Theme | Desktop-plus | shadcn default | rdc guideline |
|---|---|---|---|
| Light | `rgba(0,0,0,0.4)` solid | `rgba(0,0,0,0.10)` + blur | **`rgba(0,0,0,0.4)` solid** — matches desktop-plus, no blur |
| Dark | `rgba(0,0,0,0.5)` solid | same as light | **`rgba(0,0,0,0.5)` solid** — desktop-plus had a darker dark-mode backdrop |

Override `DialogOverlay`'s `bg-black/10 backdrop-blur-xs` to `bg-black/40` (light) / `bg-black/50` (dark) to match desktop-plus. The blur is a modern UI trend but rdc's established design didn't use it.

### 3. Panel styling

| Property | Desktop-plus | shadcn default | rdc guideline |
|---|---|---|---|
| Background | `var(--background-color)` (#ffffff) | `bg-popover` (#ffffff) | **`bg-popover`** — both are white, this matches |
| Border | `1px solid var(--box-border-color)` (gray-200) | `ring-1 ring-foreground/10` | **`border border-[var(--border)]`** — visible border, not ring |
| Radius | 6px | `rounded-xl` (12px) | **`rounded-[var(--radius-medium)]`** (8px) — rdc's established value |
| Shadow | `0 2px 7px rgba(71,83,95,0.19)` | none (ring replaces shadow) | **`shadow-[var(--shadow-dialog)]`** — rdc's established shadow |
| Padding | 20px | `p-4` (16px) | **`p-5`** (20px) — matches desktop-plus |

### 4. Warning/error icon

For dialogs with `role="alertdialog"` or warning semantics:
- **Icon**: lucide `CircleAlert`. FontAwesome was removed from the project entirely — see
  `COMPONENT_MIGRATION_PROCESS.md` Convention 11.
- **Colour**: `text-[var(--warning-text)]`. **Not** `text-yellow-500`: a raw Tailwind palette colour
  bypasses the token system, so it does not respond to the theme — it was the single such violation
  in the whole `tsx` tree and is fixed.
- **Size**: inherited. `LucideProvider` sets `size-[1em]` app-wide, so an icon scales with the font
  size of wherever it sits. Do not hardcode 24px.
- **Position**: inline in the title, before the title text — not desktop-plus's separate gutter
  column, which costs horizontal space and needs layout CSS in the shared primitive.

desktop-plus used a CSS mask for its alert-triangle icon; rdc uses a real lucide component.

### 5. Terminal output

**Use a styled `<pre>`, not xterm.js.** This guideline said the opposite until 2026-08-16, when the
paths in it were checked and the module it pointed at turned out not to exist.

xterm.js was never ported and is not a dependency. `MIGRATION_MAP.md` records the decision and the
measurements behind it: xterm exists to render ANSI escape sequences, and rdc's captured hook output
contains none — hooks are spawned with stderr as a pipe and no `TERM`, so npm, eslint, prettier and
git all emit plain text. That is 283 KB against no benefit, on a bundle already past Vite's warning
threshold.

`src/components/terminal-output.tsx` is what to use: a `<pre>` with
`commit-terminal-output`, a max height, and horizontal scroll inside its own box. It is what Hook
failure and the commit progress dialog both render.

Deferred, not rejected — if coloured output is ever wanted, the precondition is one line in
`hook_environment` (`FORCE_COLOR=1`) and the proportionate answer is a small SGR-to-`<span>` pass,
not a terminal emulator.

### 6. Title font

Title font should be **smaller** than button font. This is a desktop-plus convention:
- Title: `font-size: 16px`, `font-weight: 600`
- Buttons: `font-size: 14px`, `font-weight: 600`

shadcn's `DialogTitle` uses `text-base leading-none font-medium` (16px). This is correct for the title. Buttons use shadcn's `Button` component which is 14px. The hierarchy is preserved.

### 7. Button order

**Platform-specific**, matching desktop-plus:
- **macOS**: Cancel/Abort first, then OK/Ignore (Apple HIG: cancel on left)
- **Windows/Linux**: OK/Ignore first, then Cancel/Abort (NN/g guidelines: primary on left)

Use `__DARWIN__` to detect platform:
```tsx
{__DARWIN__ ? (
  <>
    <Button onClick={onAbort}>Abort</Button>
    <Button onClick={onIgnore}>Ignore and Continue</Button>
  </>
) : (
  <>
    <Button onClick={onIgnore}>Ignore and Continue</Button>
    <Button onClick={onAbort}>Abort</Button>
  </>
)}
```

### 8. Destructive buttons

desktop-plus's destructive button: red-tinted background with red border (not solid red fill).

| State | Desktop-plus light | rdc guideline |
|---|---|---|
| Background | `#ffeef0` (red-100) | `bg-red-50` or `bg-[var(--color-error-surface)]` |
| Border | `1px solid #fdaeb7` (red-200) | `border border-red-200` |
| Text | `#cb2431` (red-800) | `text-red-700` or `text-[var(--color-error-text)]` |
| Hover bg | `#fdaeb7` (red-200) | `hover:bg-red-100` |

shadcn's `destructive` variant (`bg-destructive/10 text-destructive`) is close but uses rdc's `--destructive` token which may not match the red palette exactly. Override to use explicit red values that match the established error colors.

### 9. Background color matching

**The dialog background must match the app's established light/dark colors.** The app uses:
- Light background: `#f5f7fa` (`--background`)
- Light card/popover: `#ffffff` (`--popover`)
- Dark background: `#1d2129` (`--background`)
- Dark card/popover: `#303642` (`--popover`)

Dialogs use `--popover` (white in light, dark gray in dark) which is correct — it's the card/surface color. But the **contrast between popover and background** must be visually comfortable. If the white dialog looks odd against the light gray app background, the issue might be the shadow/ring/border, not the background color itself.

**Before changing token values**, verify the contrast in both themes with a visual pass.

### 10. Footer

desktop-plus had a bordered footer (`border-top: 1px solid var(--box-border-color)`) with buttons right-aligned. shadcn's `DialogFooter` adds `bg-muted/50` which desktop-plus didn't have.

**Override**: Use `border-t border-[var(--border)]` without the `bg-muted/50` background, matching desktop-plus's cleaner footer.

## Migration checklist per dialog

Before migrating each dialog, verify:
- [ ] Width matches the guideline (480px / 600px / 384px)
- [ ] Backdrop matches desktop-plus (40% solid, no blur)
- [ ] Panel has visible border (not ring), correct radius (8px), correct shadow
- [ ] Padding is 20px (not 16px)
- [ ] Warning/error dialogs have the circle-exclamation icon in yellow-300
- [ ] Terminal output uses the shared `TerminalOutput` `<pre>`, not xterm.js (see §5)
- [ ] Title font is smaller than button font
- [ ] Button order is platform-specific
- [ ] Destructive buttons use red tint + red border (not solid red)
- [ ] Background colors match the app's established tokens
- [ ] Footer has border-top but no background color
