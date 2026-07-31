# Selected-repository foundation gate

Enter only after `baseline-layout-checklist.md` passes on the platform being tested. Complete all four
gates below before the visual matrix or functional workflow QA. Their question is structural: does a
populated repository produce a stable application frame whose controls can be tested without an
expected redesign moving or regrouping them?

Use the generated `primary` fixture in Light theme. Begin at normal size (at least 1100×720), then
repeat at the default 800×600 window and compact 620×720 window, with the sidebar expanded and
collapsed. Do not perform discard, commit, branch or remote mutations during this gate. Capture a
full-window before/after image for every structural revision.

## Gate A — repository context, toolbar and navigation

- Decide the persistent placement and relative prominence of current repository and branch. Avoid
  duplicating either identity across title/header, toolbar and sidebar.
- Decide whether the full repository path belongs in persistent chrome, a secondary disclosure or a
  tooltip. Long names and paths must truncate predictably without increasing header height.
- Separate repository identity, local/open shortcuts and remote synchronization by purpose. The four
  local shortcuts and Fetch/Pull/Push must not read as seven equally important primary actions.
- Make the next likely remote action recognizable for no-remote, no-upstream, behind, ahead,
  diverged, loading, running and failed states. Disabled controls still need understandable context.
- Reserve stable space or use a non-displacing presentation for progress and errors. Remote state
  changes must not push the workspace vertically.
- Make Changes/History read as primary workspace navigation attached to the active workspace, not as
  an unrelated strip of generic buttons.
- Verify toolbar semantics, tab order, focus indication, labels/tooltips and grouping without
  requiring pointer hover to understand an action.
- Prefer stable, recognizable icon-only toolbar controls where the action has an established visual
  metaphor. This keeps translated visible labels from changing command-bar geometry or creating
  locale-specific breakpoints. It does not remove localized text: every icon retains a localized
  accessible name and contextual tooltip, and an action without a clear icon keeps a visible label.
- Base compact behavior on the space actually available to the repository workspace. Verify normal,
  800×600 and 620×720 widths with both sidebar widths; controls may condense or move to overflow but
  must not clip, create accidental horizontal scrolling or wrap unpredictably.

Gate A passes only when:

- [x] Repository and branch context have one persistent, unambiguous home.
- [x] Identity, local shortcuts, remote state/actions and Changes/History navigation have distinct
      visual jobs and hierarchy.
- [x] Remote progress/errors and long identity values do not change the workspace's top edge.
- [x] Toolbar controls have intentional priority, grouping, overflow, focus and accessible names.
- [x] Expanded/collapsed and normal/default/compact widths preserve the same information architecture.

Accepted as the macOS baseline by Jose Gutierrez on 2026-07-31. Linux and Windows must repeat this
gate independently; this approval does not prescribe their native window-chrome details.

## Gate B — left-pane design refinement

- Establish a clear hierarchy between the Repositories and Branches panel headers, their current
  values and their secondary controls. Disclosure arrows and section icons must support scanning
  without competing with repository or branch names.
- Refine repository rows as navigation rather than generic form controls. Selection, path
  truncation, hover/focus, contextual-menu affordance and long or similarly named repositories must
  remain distinguishable without making each row unnecessarily tall.
- Refine the Branches panel around its primary job: understanding and changing the current branch.
  Branch selection and branch creation need distinct hierarchy; labels, fields and the Create action
  must not read as an undifferentiated form block.
- Decide the expanded sidebar's useful width and density at normal, default and compact window sizes.
  It must leave the workspace useful, but paths, repository names and branch names need predictable
  truncation and contextual disclosure.
- Establish scroll ownership when repository or branch lists grow. The command-bar control remains
  fixed; scrolling one panel must not hide unrelated panel headers or make the lower panel
  unreachable.
- Use an exclusive accordion for the backed sections: the expanded panel owns the remaining
  vertical space and scrolls internally, while every other enabled section collapses to a header
  that remains visible and operable. Opening Branches therefore collapses Repositories, and vice
  versa; this is deliberately not an overlay that hides the rest of the navigation.
- Reuse the useful repository-selector patterns from desktop-plus — a filterable, dense,
  single-line navigation list with selected-row emphasis and contextual disclosure for full names
  and paths — without implying unsupported data. Account/recent grouping, pinned state, pull
  status, Pull All and the selector's overlay geometry remain post-MVP until their backing behavior
  exists.
- Apply the same boundary to the upstream branch selector: keep its filter/New branch hierarchy,
  compact current-row treatment and grouped scrolling list. Default Branch is inferred only from
  the locally recorded remote `HEAD`; Recent Branches comes from the native
  reflog reader; all remaining local refs become Other Branches. A group is omitted when its fact
  cannot be established. Remote-branch checkout, Pull Requests, merge-target selection, relative
  activity and branch context actions remain absent until their stores and workflows exist. Remote
  refs stay in fetch state; they are not rendered as inert navigation rows.
- Verify empty, loading, error, detached/unborn branch, long-content and many-item states without
  changing the outer shell geometry.
- Recheck the collapsed rail transition. Icons keep current-value tooltips and accessible names,
  focus moves deliberately when a section expands, and no stale expanded-pane content remains
  visible or keyboard-reachable.

Gate B passes only when:

- [x] Repository and Branches panels have a deliberate hierarchy, density and disclosure treatment.
- [x] Repository selection, contextual actions and long values remain clear and accessible.
- [x] Current-branch selection and branch creation have distinct, understandable visual jobs.
- [x] Panel and list scrolling preserve fixed shell controls and access to every enabled section.
- [x] Expanded/collapsed and normal/default/compact states preserve the accepted toolbar and useful
      workspace width.

Accepted as the macOS baseline by Jose Gutierrez on 2026-07-31 after four assisted visual
iterations. Linux and Windows must repeat Gate B independently; the data-backed accordion and
grouping semantics are shared, but this approval does not prescribe platform-specific rendering.

## Gate C — Changes workspace frame

- Set intentional proportions for the changed-file list, selected diff and commit area. The diff is
  the primary reading surface; navigation and commit controls support rather than crowd it.
- Establish scroll ownership and minimum useful pane sizes. Scrolling one pane must not accidentally
  remove persistent navigation, repository context or the window drag region.
- Verify empty selection, long file names, representative text diff and commit-form presence do not
  change the outer geometry unexpectedly.
- Place merge-conflict status so it is visible without introducing an accidental extra grid row or
  pushing the primary workspace unpredictably.
- Leave and re-enter Changes without moving its outer top edge, changing its pane proportions or
  losing a still-valid file selection.
- At compact width, preserve the file-navigation pane on the left and the selected diff on the
  right; do not move the diff below the file list. Keep both useful through deliberate proportions,
  independent scrolling and a bounded commit dock without introducing page scrolling.
- Keep secondary commit behavior behind a quiet options disclosure. Hooks run through RDC's
  shell-environment interception by default; the explicit override is named **Bypass hooks** and
  means `--no-verify`, not “run hooks” or “change the hook environment.”

Gate C passes only when:

- [x] Changes has deliberate file/diff/commit proportions and clear scroll ownership.
- [x] Merge-conflict, empty-selection, long-content and commit-form states preserve the outer frame.
- [x] Re-entering Changes preserves its geometry and every still-valid selection.
- [x] Normal/default/compact Changes layouts remain usable with the sidebar expanded and collapsed.

Accepted as the macOS baseline by Jose Gutierrez on 2026-07-31 after three assisted visual
iterations. Linux and Windows must repeat Gate C independently; the permanent file-left/diff-right
relationship is shared, but this approval does not prescribe platform-specific rendering.

## Gate D — History workspace frame

- Set intentional proportions for the commit list and commit details. History navigation must remain
  scannable while leaving the selected commit enough room to be understood.
- Establish a stable reading order for commit metadata, changed files and selected diff. Their visual
  hierarchy must not depend on a particular commit having a short summary or few files.
- Establish scroll ownership and minimum useful pane sizes independently from Changes. Scrolling a
  long commit list, long metadata or a long diff must not remove repository context, primary
  navigation or the window drag region.
- Verify empty history, no selected commit, long summaries, long author/ref metadata, many changed
  files and a representative text diff without changing the outer geometry unexpectedly.
- At compact width, define one deliberate History stacking order. Avoid nested page scrolling,
  unreachable commit/file navigation and oversized fixed-height gutters.
- Switch Changes → History → Changes → History after both frames are individually stable. The
  toolbar, navigation, workspace top edge and repository context remain fixed even though the two
  internal layouts differ; each frame restores every still-valid local selection.

Gate D passes only when:

- [ ] History has deliberate list/details proportions and clear scroll ownership.
- [ ] Commit metadata, changed files and selected diff have a coherent reading order and truncation.
- [ ] Empty, unselected, long-content and many-file states preserve the outer frame.
- [ ] Switching Changes/History preserves repository context, navigation, workspace geometry and
      still-valid per-frame selections.
- [ ] Normal/default/compact History layouts remain usable with the sidebar expanded and collapsed.

## Platform ownership

Passing all four gates establishes the selected-repository foundation only for the OS recorded in the
evidence. macOS, native-Wayland Linux and Phase 10 Windows each run it independently and record any
necessary native variation explicitly.
