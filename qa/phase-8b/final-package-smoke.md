# Final package smoke pass

Run this only after development-build QA has no agreed blocker and the final MVP icon and bundle
identifier have been chosen. Build both artifacts from the same recorded commit after its complete
Phase 8a gate is green; `qualify:phase8a` checks packaging *inputs*, not the produced artifact.
Record whether the MVP is presented as Preview/Beta, the exact label and where it appears; About and
package metadata must agree rather than implying different release maturity.

For both the local macOS `.app` and installable Linux bundle:

- Record the exact commit, package filename, size and SHA-256.
- Inspect product name, version, identifier, icons, executable and bundled `rdc-cli` resource.
- Install from a clean state and launch without a development server or repository checkout.
- Confirm the installed window enforces the 715×356 floor, keeps sidebar width stable across views
  and reveals prepared History without intermediate loading paints.
- Confirm configuration and logs use the final identifier-scoped platform directories.
- Add the generated `primary` fixture, select it, quit the entire process, relaunch and confirm
  persistence.
- Smoke status/diff, commit, History, branch checkout, Fetch/Pull/Push and Clone.
- Exercise menus, dialogs, close/relaunch and external editor/terminal/file-manager integration.
- Confirm no Desktop Plus/GitHub Desktop identity or destination appears.
- Confirm all packaged resources and executable sidecars are present with the permissions the target
  requires; the development checkout must not be needed at runtime.
- Inspect logs for startup, IPC, renderer rejection, shutdown failures or secret values.
- Uninstall/remove the test installation through the platform's ordinary path and confirm no fixture
  repository or unrelated user data is removed.

A packaging-only failure requires a fix, the complete Phase 8a gate, a fresh package and repetition of
every affected item. Signing, notarization, updater installation and public-release credentials remain
Phase 9 work.
