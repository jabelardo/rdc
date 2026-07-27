# Git test fixtures

Byte-exact snapshots of repositories, vendored from
`desktop-plus/app/test/fixtures/`. Materialized into a temp directory at test time by
`fixture_repository()` in `crates/git-ops/src/test_support.rs`, which copies the directory and
renames every `_git` back to `.git`.

## Do not edit these files — including with repo-wide search/replace

**These are git internals stored as plain files.** `_git/HEAD`, `_git/COMMIT_EDITMSG`,
`_git/logs/*` and the object store are all data, and they must stay internally consistent.
Editing any of them by hand — or catching them in a project-wide find/replace — produces a
repository that git rejects.

This has already happened once: renaming the project's default branch from `master` to `main`
rewrote `test-repo/_git/HEAD` to `ref: refs/heads/main` while the actual ref was still
`refs/heads/master`, leaving HEAD dangling. The failure surfaced as
`fatal: ambiguous argument 'HEAD': unknown revision`.

A fixture's internal branch name is **part of the snapshot**, not a project convention. Ported
tests from `desktop-plus` refer to `master` inside these fixtures. Leave it alone.

If a fixture is ever suspected of being corrupt, restore it by re-copying from
`desktop-plus/app/test/fixtures/<name>` and confirming `diff -r` is clean.

## Adding a fixture

Vendor **lazily** — only what a test you are porting actually needs. The full set in
`desktop-plus` is 8.7 MB, 4.6 MB of which is a single image-diff repository.

```sh
cp -R ../../../../../../desktop-plus/app/test/fixtures/<name> ./<name>
```

Copy it verbatim: keep the `_git` naming (the rename to `.git` happens at runtime, in the temp
copy), and don't run any formatter or line-ending conversion over it.

## Currently vendored

| Fixture | Size | Used by |
|---|---|---|
| `test-repo` | 88K | `exec.rs` harness tests |
