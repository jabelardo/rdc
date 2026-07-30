# Final package smoke pass

Run this only after development-build QA has no agreed blocker and the final MVP icon and bundle
identifier have been chosen.

For both the local macOS `.app` and installable Linux bundle:

- Record the exact commit, package filename, size and SHA-256.
- Inspect product name, version, identifier, icons, executable and bundled `rdc-cli` resource.
- Install from a clean state and launch without a development server or repository checkout.
- Confirm configuration and logs use the final identifier-scoped platform directories.
- Add the generated `primary` fixture, select it, quit the entire process, relaunch and confirm
  persistence.
- Smoke status/diff, commit, History, branch checkout, Fetch/Pull/Push and Clone.
- Exercise menus, dialogs, close/relaunch and external editor/terminal/file-manager integration.
- Confirm no Desktop Plus/GitHub Desktop identity or destination appears.
- Inspect logs for startup, IPC, renderer rejection and shutdown failures.

A packaging-only failure requires a fix, the complete Phase 8a gate, a fresh package and repetition of
every affected item. Signing, notarization, updater installation and public-release credentials remain
Phase 9 work.
