# Application shell and empty-state baseline gate

Complete this gate before selecting a repository. Its deliberately narrow question is: does a clean
default-size window establish coherent native chrome, permanent navigation and repository-entry
actions without duplicated identity or controls?

Start with no registered repositories, Light theme and the default 800×600 window. Capture expanded
and collapsed states before and after every structural revision. This gate does **not** settle the
selected-repository toolbar, Changes/History navigation or workspace geometry; those belong to
`selected-repository-baseline-checklist.md`.

## Accepted macOS decisions

The three annotated 2026-07-31 review rounds established:

- Use **RDC** as the visible product/window name. Keep lowercase `rdc` for executable, package and
  filesystem identities where changing case would be cosmetic churn rather than presentation.
- Remove the duplicate product heading from the sidebar. Repository and branch context, once
  selected, belongs to the selected-repository foundation—not to a product-name block in navigation.
- Keep the sidebar as a vertical left rail at the default 800×600 window. It must never become a
  full-width panel above the workspace.
- Treat the collapsed state as a compact navigation rail, not an empty gutter. Show only enabled MVP
  sections: Repositories and Branches.
- Use the agreed Font Awesome Free Solid glyphs: `faFolderTree`, `faCodeBranch`, `faChevronLeft` and
  `faChevronRight`. Import individual SVG icons rather than the full icon font or Unicode lookalikes.
- Give each collapsed section a live tooltip/accessibility description containing its current value.
  Activating it expands both the sidebar and corresponding panel and moves focus to that section.
- Remove Clone/Add from the sidebar. Keep the empty-state actions together in the workspace as
  **Create repository**, **Add existing repository** and **Clone repository**, each real and carrying
  a concise contextual description.
- Increase the macOS overlay drag strip from `1.75rem` to `2.4rem`, keeping it visually intentional
  and persistently available.
- Make the sidebar and its divider own the full height below the title bar even with no content.
- Keep the empty-state action group near the top of the workspace rather than offsetting it by
  viewport height.
- Center all collapsed controls in the rail. The expanded collapse control uses the same
  x-coordinate, so it does not jump when the width changes.
- Make the collapsed controls borderless and shadowless on the rail surface, with a restrained hover
  treatment. Every control has a contextual native tooltip.
- Give the expand/collapse control the same `2.25rem` square hit area as the repository and branch
  controls; its different glyph must not change the control dimensions.

## Revalidation checks

- Verify product identity and repository-entry actions appear exactly once.
- Verify the sidebar remains a left rail at 800×600, fills the available height and retains a
  continuous divider.
- Collapse and expand by pointer and keyboard. The control must not move horizontally; its arrow,
  accessible name and tooltip describe the action that will occur.
- In the collapsed state, verify equal control dimensions, borderless rail styling, live
  repository/branch descriptions and section restoration with a sensible focus target.
- Exercise Create, Add existing and Clone without completing a repository workflow. Each must open
  its real native path rather than act as a placeholder.
- Move, maximize, restore and resize the empty window. The drag region remains available and the
  sidebar never becomes a horizontal top panel.

## Gate decision

Passing this gate establishes the **shell/empty-state baseline on one OS only**. Linux repeats it
before the macOS/Linux MVP ships; Windows repeats it in Phase 10. Another platform's result is a
design reference, not acceptance evidence.

- [x] RDC identity and repository-entry actions appear once.
- [x] The default 800×600 window retains a full-height left rail and top-aligned action group.
- [x] The collapsed rail retains equal-size borderless controls, live descriptions and stable
      alignment, and restores the matching panel with keyboard focus.
- [x] Create, Add existing and Clone are real, keyboard-reachable actions with concise descriptions.
- [x] Native/title-bar space, sidebar and empty workspace form one clear hierarchy.
- [x] Empty-shell resizing preserves the hierarchy without a horizontal-sidebar breakpoint.

macOS accepted this shell/empty-state baseline on 2026-07-31. The selected-repository foundation,
visual matrix and functional workflows remain separate open gates.
