# Application-menu MVP alignment checklist

Run this on every supported MVP platform after the foundation and visual checks, but before the
functional journeys. The automated recursive menu contract proves that every visible enabled leaf
has an executor; this human gate answers the different question: **is the menu surface itself the
right surface for the MVP?**

Use `src/lib/menu/default-menu.ts` and `src/lib/menu/repository-menu.ts` as the implemented inventory,
and `REMAINING.md` plus the Phase 7f section of `MIGRATION_PLAN.md` as the named post-MVP boundary.
Do not use desktop-plus as the expected inventory: parity features intentionally deferred from the
MVP must not look available merely because upstream has them.

## State matrix

Inspect the complete application menu in each state below. Use fresh fixture scenarios where an
operation would mutate repository data.

1. No repository registered or selected.
2. A clean local repository selected, first without configured editor/shell integrations and then
   with valid integrations selected.
3. `populated` in Changes, first with no file/line selection and then with a meaningful selection.
4. History with a selected commit and changed file.
5. A repository with a configured remote/upstream, including idle and one deterministic busy state.
6. Any protected/in-progress state exposed by the MVP, including merge conflict or an active Git
   operation.
7. Two repository windows with different repositories and views, alternating native focus.

## Inventory and behavior

- Every top-level menu and visible item belongs to the MVP, an operating-system-required native role,
  or a specifically recorded accepted deviation. No placeholder, empty submenu or test-only item is
  visible in a production build.
- Every enabled item performs its advertised action in the focused window. It must not open a hollow
  dialog, silently do nothing, or target the repository selected in another window.
- Every implemented MVP action that users reasonably need to discover through the application menu
  is present. Toolbar/context-menu duplication is allowed only when both entries route to the same
  behavior and state policy.
- Post-MVP actions remain hidden or honestly disabled. In particular, GitHub collaboration,
  account/enterprise networking, advanced Git operations and Phase 7f-only surfaces must not imply
  support before their named phase lands.
- Enablement follows state: selection-dependent actions, editor/shell actions, remote operations,
  conflict/protected-state actions and view navigation change at the correct time and recover after
  success or failure. Closing or refocusing a window must not leave stale enablement.
- Labels use RDC identity and current platform terminology. Dynamic editor/shell labels and any
  repository-sensitive copy are current, bounded and not duplicated with stale repository/branch
  values.
- Help/About destinations identify rdc and land only on rdc-owned/current destinations. No enabled
  item points to Desktop Plus or GitHub Desktop unless the evidence record names and accepts that
  exact deviation.
- Accelerators shown in the menu match the action they invoke, work from the relevant application
  state, and do not trigger a disabled or different item. Native operating-system roles retain their
  expected localized labels and conventions.
- Contextual menus expose only actions valid for their target row/selection and use the same
  confirmation, enablement and focused-window policy as the corresponding application-menu action.

## Platform rendering

- On macOS, inspect the real native menu bar before and after the webview finishes loading. The
  bootstrap menu must be replaced by the complete current tree without a visible stale or duplicate
  menu, and reopening a menu after state changes must show current labels and enablement.
- On Linux, inspect the platform-rendered application menu on a native Wayland session and verify
  keyboard access, dismissal, focus return and popup placement. Xvfb E2E is prerequisite evidence,
  not visual acceptance.
- Windows repeats this checklist in Phase 10 when it enters the supported surface; do not infer its
  acceptance from macOS/Linux results.

## Exit record

Record the platform, commit, states exercised and one of these outcomes in the cycle evidence:

- aligned with the MVP;
- blocker, with the exact item/state and expected disposition;
- accepted deviation, with reason and named later owner.

Any menu implementation fix invalidates the green Phase 8a prerequisite and requires this affected
state matrix to be repeated. The final packaged application gets the focused repeat named in
`final-package-smoke.md` because development-mode and packaged native menus can differ.
