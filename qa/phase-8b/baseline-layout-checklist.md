# Baseline application-shell layout gate

Complete this gate before theme variants, detailed component styling, workflow QA, native menus or
platform-integration checks. Its question is deliberately narrow: does one populated, normal-size
Light-theme window read as a coherent desktop application rather than a collection of adjacent
widgets?

Use the generated `primary` fixture with the window at approximately 1100×720 or larger. Keep the
sidebar expanded and Changes selected for the first pass. Capture one full-window before image and
one after image for every structural revision.

## Cycle-one annotated baseline decisions

The 2026-07-31 current/annotated empty-state comparison turns the first revision into concrete work:

- Use **RDC** as the visible product/window name. Keep lowercase `rdc` for executable, package and
  filesystem identities where changing case would be cosmetic churn rather than presentation.
- Remove the duplicate `rdc` heading from the sidebar. Repository and branch context, once selected,
  belongs in the persistent repository/title header defined below—not in a product-name block inside
  navigation.
- Keep the sidebar as a vertical left rail at the default 800×600 window. The current horizontal
  expansion is caused by the 52rem compact breakpoint and is a layout defect, not an acceptable
  empty-state variant. At narrow widths it may remain expanded or use its collapsed rail, but it
  must never become a full-width panel above the workspace.
- Place the whole-sidebar collapse control at the sidebar's leading/top edge. It must stay visually
  attached to the rail in both states rather than floating at the far side of a full-width region.
  When collapsed, the control remains visible with its arrow reversed and an **Expand sidebar**
  accessible name/tooltip.
- Treat the collapsed state as a compact navigation rail, not an empty gutter. Keep one icon for
  every enabled sidebar section—in the MVP, Repositories and Branches—in the same vertical order as
  the expanded panels. Do not expose icons for hidden post-MVP sections.
- Use the agreed Font Awesome Free Solid glyphs consistently in expanded and collapsed states:
  `faFolderTree` for Repositories, `faCodeBranch` for Branches, `faChevronLeft` for Collapse sidebar
  and `faChevronRight` for Expand sidebar. Import the individual SVG icons through the React package;
  do not load the full icon font or use Unicode lookalikes. The repository does not currently depend
  on Font Awesome, so adding the narrowly scoped packages and locking them is part of this slice.
- Give each collapsed section icon a live hover/focus description containing its current value:
  **Repositories: _selected repository name_** or **No repository selected**, and **Branches:
  _current branch name_** or **No branch selected**. Long values may truncate visually but the full
  value remains available to assistive technology.
- Make the section icons real controls now rather than inert glyphs that merely look clickable.
  Activating one expands the sidebar, expands its corresponding panel and moves focus to that
  panel's heading or current item. This behavior is useful today and remains a stable base for richer
  section actions later.
- Remove Clone/Add from the sidebar header. Empty-state creation actions belong together in the
  workspace; after a repository exists, equivalent commands remain available through the native
  menu rather than permanently competing with repository navigation.
- Replace the empty state's heading-plus-explanation with one compact action group: **Create
  repository**, **Add existing repository**, and **Clone repository**. Button labels carry the
  essential meaning; short descriptions may appear on hover and keyboard focus and remain available
  to assistive technology, but required guidance must not be available only to pointer users.
- The Create action must be real before it is shown. `git-ops::init_repository` already owns the Git
  operation, but Phase 8b must add the Tauri command, typed frontend wrapper, destination dialog,
  registration/selection path and regression coverage. A disabled or no-op placeholder does not
  satisfy this task.
- Add restrained repository/branch glyphs only if they improve scanning while preserving the
  disclosure indicators and accessible section names; they are supporting hierarchy, not a new icon
  language to solve during the structural pass.

## Information architecture

- Identify the five top-level regions without relying on color alone: native/title-bar area,
  application sidebar, repository identity and actions, Changes/History navigation, and the active
  workspace. Each region must have one job and a clear boundary.
- Confirm the current repository and branch occupy the intended persistent title/header position.
  They must not compete with duplicated identity elsewhere in the toolbar or sidebar.
- Make the Changes/History switch read as primary workspace navigation, not as another unrelated row
  of buttons.
- Keep unavailable post-MVP panels and actions hidden. Empty placeholders must not consume baseline
  layout space merely because their implementation exists behind a feature flag.

## Sidebar

- Establish a deliberate expanded width, minimum width and collapsed width. The repository/workspace
  balance must remain useful at the smallest supported normal window.
- Verify the collapse control, repository actions and panel disclosure controls form one stable
  header rather than floating independently.
- Verify Repositories and Branches have a clear parent/child hierarchy, useful density, aligned
  labels and predictable truncation for long names and paths.
- Collapse and expand the whole sidebar and each visible panel. The workspace must resize without
  jumps, clipped controls or unexplained empty gutters.
- In the collapsed rail, verify the reversed expand arrow and every enabled section icon by pointer
  and keyboard. Tooltips/current-value descriptions must update after selecting another repository
  or checking out another branch; activating a section icon must restore the matching expanded
  panel and a sensible focus target.
- Confirm the expanded panel headings and collapsed rail use the same `folder-tree`/`code-branch`
  visual identities, and the chevron direction always describes the action that will occur rather
  than the sidebar's current state.

## Repository header, toolbar and navigation

- Separate repository identity, repository navigation and actions by purpose. Do not use three
  equally prominent horizontal strips when one header with subordinate controls would communicate
  the structure better.
- Group local/open actions separately from remote synchronization actions. Make the next likely
  remote action recognizable without giving every shortcut equal visual weight.
- Keep header and navigation heights stable while progress, ahead/behind state, long repository
  names and disabled integrations appear. Wrapping must not cause the workspace to jump vertically.
- Verify toolbar controls align to a shared baseline and have intentional spacing, grouping and
  overflow behavior at both the target width and its narrow edge.

## Active workspace

- Set intentional proportions for the changed-file list, selected diff and commit area. The diff is
  the primary reading surface; navigation and commit controls must support it rather than crowd it.
- Align pane edges, headings and separators across the sidebar, toolbar/navigation and workspace so
  the eye can follow a small number of continuous lines.
- Verify long file names, an unselected file, selected text diff, progress/error content and the
  commit form do not change the top-level geometry unexpectedly.
- Switch to History and back. The two workspaces may have different internal layouts, but their outer
  frame, navigation position and repository context must remain stable.

## Window behavior at the structural level

- Move the window using the persistent drag region before and after scrolling; the region must stay
  available without looking like accidental blank space.
- Resize slowly from the target normal size down to the compact breakpoint. Record the exact width
  where the composition changes and confirm it changes once, deliberately, without intermediate
  broken arrangements.
- Maximize and restore. The shell must use the extra space intentionally rather than merely producing
  oversized gutters or stretched controls.

## Gate decision

Do not proceed to `visual-matrix.md` or the platform workflow checklists until all are true:

- [ ] A first-time user can point to repository context, workspace navigation, primary content and
      primary action without explanation.
- [ ] At the default 800×600 window, the sidebar remains a left rail and the empty-state action group
      occupies the workspace without duplicated product labels or actions.
- [ ] The collapsed rail retains the reverse expand arrow and enabled section controls; repository
      and branch descriptions expose current values, stay synchronized, and restore the matching
      panel with keyboard focus.
- [ ] Create, Add existing and Clone are three real, keyboard-reachable actions with concise
      hover/focus descriptions; none is a hollow control.
- [ ] The title/header, sidebar, toolbar/navigation and workspace form one hierarchy with no
      duplicated identity or competing top-level bars.
- [ ] Expanded/collapsed sidebar and normal-to-compact resizing preserve useful content proportions.
- [ ] Changes and History retain a stable outer frame.
- [ ] No agreed top-level layout blocker remains; remaining findings are component-level refinement
      suitable for the visual matrix.
