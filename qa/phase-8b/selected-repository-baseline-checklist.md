# Selected-repository foundation gate

Enter only after `baseline-layout-checklist.md` passes on the platform being tested. Complete both
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
- Base compact behavior on the space actually available to the repository workspace. Verify normal,
  800×600 and 620×720 widths with both sidebar widths; controls may condense or move to overflow but
  must not clip, create accidental horizontal scrolling or wrap unpredictably.

Gate A passes only when:

- [ ] Repository and branch context have one persistent, unambiguous home.
- [ ] Identity, local shortcuts, remote state/actions and Changes/History navigation have distinct
      visual jobs and hierarchy.
- [ ] Remote progress/errors and long identity values do not change the workspace's top edge.
- [ ] Toolbar controls have intentional priority, grouping, overflow, focus and accessible names.
- [ ] Expanded/collapsed and normal/default/compact widths preserve the same information architecture.

## Gate B — Changes and History workspace frame

- Set intentional proportions for the changed-file list, selected diff and commit area. The diff is
  the primary reading surface; navigation and commit controls support rather than crowd it.
- Establish scroll ownership and minimum useful pane sizes. Scrolling one pane must not accidentally
  remove persistent navigation, repository context or the window drag region.
- Verify empty selection, long file names, representative text diff and commit-form presence do not
  change the outer geometry unexpectedly.
- Place merge-conflict status so it is visible without introducing an accidental extra grid row or
  pushing the primary workspace unpredictably.
- Set intentional History list/details proportions. Commit metadata, changed files and selected diff
  must have a stable reading order and useful truncation.
- Switch Changes → History → Changes. The toolbar, navigation, workspace top edge and repository
  context remain fixed even though the internal pane layouts differ.
- At compact width, define one deliberate stacking order for Changes and one for History. Avoid
  nested page scrolling, unreachable controls and oversized fixed-height gutters.

Gate B passes only when:

- [ ] Changes has deliberate file/diff/commit proportions and clear scroll ownership.
- [ ] History has deliberate list/details proportions and a coherent reading order.
- [ ] Merge-conflict, empty-selection, long-content and commit-form states preserve the outer frame.
- [ ] Switching Changes/History preserves repository context, navigation and workspace geometry.
- [ ] Normal/default/compact layouts remain usable with the sidebar expanded and collapsed.

## Platform ownership

Passing both gates establishes the selected-repository foundation only for the OS recorded in the
evidence. macOS, native-Wayland Linux and Phase 10 Windows each run it independently and record any
necessary native variation explicitly.
