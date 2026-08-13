//! Test helpers for building real git repositories.
//!
//! Ported from `desktop-plus/app/test/helpers/repositories.ts`. 36 of the 45 files in
//! `app/test/unit/git/**` set up a real repository, so this is the gate for most of Phase 2.
//!
//! Setup deliberately uses [`std::process::Command`] rather than this crate's own
//! [`crate::exec::git`], so that a bug in the code under test surfaces as a failing assertion
//! rather than as broken fixtures.
//!
//! Currently `#[cfg(test)]` only. When the first integration test under `tests/` needs these,
//! promote the module behind a `test-support` feature instead of duplicating it.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

/// A git repository in a temporary directory, removed when dropped.
pub struct TempRepository {
    dir: TempDir,
}

impl TempRepository {
    /// The repository's working directory.
    pub fn path(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }
}

/// A local SSH transport whose upload-pack blocks after emitting Fetch activity.
///
/// The fixture lives behind the Unix gate because it is a shell executable. Linux is where the
/// E2E suite runs, and keeping the OS calls inside this module preserves the portable test-support
/// surface for the future Windows arm.
#[cfg(unix)]
mod blocking_ssh {
    use std::collections::HashMap;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use tempfile::TempDir;

    use super::{commit_file, empty_repository, run, TempRepository};

    pub struct BlockingSshFetch {
        _transport: TempDir,
        _upstream: TempRepository,
        client: TempRepository,
        ready: PathBuf,
        release: PathBuf,
        env: HashMap<String, String>,
    }

    impl BlockingSshFetch {
        pub async fn new() -> Self {
            let upstream = empty_repository().await;
            commit_file(&upstream.path(), "upstream.txt", "one\n", "upstream commit");
            let client = empty_repository().await;
            run(
                &client.path(),
                &["remote", "add", "origin", "ssh://fixture/repository"],
            );

            let transport = tempfile::tempdir().expect("temporary SSH transport");
            let script = transport.path().join("blocking-ssh");
            let ready = transport.path().join("ready");
            let release = transport.path().join("release");
            fs::write(
                &script,
                r#"#!/bin/sh
printf '%s\n' 'remote: Counting objects: 50% (1/2)' >&2
: > "$RDC_BLOCKING_FETCH_READY"
while [ ! -e "$RDC_BLOCKING_FETCH_RELEASE" ]; do
  sleep 0.01
done
exec git-upload-pack "$RDC_BLOCKING_FETCH_UPSTREAM"
"#,
            )
            .expect("blocking SSH fixture should be written");
            let mut permissions = fs::metadata(&script)
                .expect("blocking SSH fixture metadata")
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&script, permissions)
                .expect("blocking SSH fixture should be executable");

            let env = HashMap::from([
                ("GIT_SSH".to_owned(), path_text(&script)),
                ("GIT_SSH_VARIANT".to_owned(), "ssh".to_owned()),
                (
                    "RDC_BLOCKING_FETCH_UPSTREAM".to_owned(),
                    path_text(&upstream.path()),
                ),
                ("RDC_BLOCKING_FETCH_READY".to_owned(), path_text(&ready)),
                ("RDC_BLOCKING_FETCH_RELEASE".to_owned(), path_text(&release)),
            ]);

            Self {
                _transport: transport,
                _upstream: upstream,
                client,
                ready,
                release,
                env,
            }
        }

        pub fn repository(&self) -> PathBuf {
            self.client.path()
        }

        pub fn env(&self) -> HashMap<String, String> {
            self.env.clone()
        }

        pub async fn wait_until_blocked(&self) {
            tokio::time::timeout(Duration::from_secs(2), async {
                while !self.ready.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("SSH transport did not reach its deterministic barrier");
        }

        pub fn release(&self) {
            fs::write(&self.release, []).expect("SSH transport should be released");
        }
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}

#[cfg(unix)]
pub use blocking_ssh::BlockingSshFetch;

/// Runs a setup command, panicking with the captured output if it fails.
///
/// Panicking is correct here: a failure means the test environment is broken, not that the
/// behaviour under test is wrong.
fn run(cwd: &Path, args: &[&str]) {
    let output = run_allowing_failure(cwd, args);

    assert!(
        output.status.success(),
        "setup command `git {}` failed ({}): {}",
        args.join(" "),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Runs a setup command that is *expected* to be able to fail, returning its output.
///
/// Needed for steps like a deliberately conflicting `git merge`, which exits non-zero by design.
/// The TypeScript helpers got this for free because dugite's `exec` returns a result rather than
/// throwing; here the distinction has to be explicit.
fn run_allowing_failure(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("failed to run `git {}`: {e}", args.join(" ")))
}

/// Applies the deterministic config every test repository gets.
///
/// Identity and signing are set locally so commits don't depend on the developer's global git
/// config — the same determinism the TypeScript suite got from the env vars in
/// `app/test/unit-test-env.ts`.
fn apply_deterministic_config(path: &Path) {
    run(path, &["config", "user.name", "Joe Bloggs"]);
    run(path, &["config", "user.email", "joe.bloggs@somewhere.com"]);
    run(path, &["config", "commit.gpgsign", "false"]);
    run(path, &["config", "tag.gpgsign", "false"]);
}

/// Creates an initialized but empty repository with deterministic settings.
///
/// The branch name is pinned rather than inheriting the developer's `init.defaultBranch`, so
/// tests are deterministic. Note this is `main`, whereas the original helper defaulted to
/// `master` — if a ported test asserts a branch name, that's the reason it needs adjusting.
pub async fn empty_repository() -> TempRepository {
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let path = dir.path().to_path_buf();

    run(&path, &["init", "-b", "main"]);
    apply_deterministic_config(&path);

    TempRepository { dir }
}

/// Materializes one of the vendored fixture repositories into a temporary directory.
///
/// Ported from `setupFixtureRepository` in `app/test/helpers/repositories.ts`: the fixture is
/// copied and every `_git` directory is renamed to `.git`. Fixtures are stored with `_git` so
/// that they aren't themselves treated as repositories by the outer repo's tooling.
///
/// `name` is a directory under `crates/git-ops/tests/fixtures/`. Fixtures are vendored from
/// `desktop-plus/app/test/fixtures/` **lazily** — only what ported tests actually need, because
/// the full set is 8.7 MB (4.6 MB of it a single image-diff repository).
pub async fn fixture_repository(name: &str) -> TempRepository {
    let source = fixture_path(name);
    assert!(
        source.is_dir(),
        "fixture {name:?} not found at {}. Fixtures are vendored lazily from \
         desktop-plus/app/test/fixtures/ — copy the one this test needs (renaming nothing; the \
         _git -> .git rename happens here at runtime).",
        source.display()
    );

    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let path = dir.path().to_path_buf();

    copy_dir(&source, &path);
    rename_git_dirs(&path);
    apply_deterministic_config(&path);

    TempRepository { dir }
}

/// Location of the vendored fixtures, relative to this crate.
fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// Recursively copies `from` into the existing directory `to`.
fn copy_dir(from: &Path, to: &Path) {
    let entries = std::fs::read_dir(from)
        .unwrap_or_else(|e| panic!("failed to read fixture dir {}: {e}", from.display()));

    for entry in entries {
        let entry = entry.expect("failed to read a fixture directory entry");
        let target = to.join(entry.file_name());
        let file_type = entry.file_type().expect("failed to stat a fixture entry");

        if file_type.is_dir() {
            std::fs::create_dir_all(&target)
                .unwrap_or_else(|e| panic!("failed to create {}: {e}", target.display()));
            copy_dir(&entry.path(), &target);
        } else {
            // Fixtures contain no symlinks; copying resolves any that appear later rather than
            // producing a dangling link into the source tree.
            std::fs::copy(entry.path(), &target)
                .unwrap_or_else(|e| panic!("failed to copy to {}: {e}", target.display()));
        }
    }
}

/// Renames every `_git` directory under `root` to `.git`, matching the original's
/// `glob('**/_git')` pass. Submodule fixtures have more than one, hence the recursion.
fn rename_git_dirs(root: &Path) {
    let entries = std::fs::read_dir(root)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", root.display()));

    for entry in entries {
        let entry = entry.expect("failed to read a directory entry");
        if !entry
            .file_type()
            .expect("failed to stat a directory entry")
            .is_dir()
        {
            continue;
        }

        let path = entry.path();
        if entry.file_name() == "_git" {
            let renamed = path.with_file_name(".git");
            std::fs::rename(&path, &renamed)
                .unwrap_or_else(|e| panic!("failed to rename {}: {e}", path.display()));
            // A .git directory has no nested fixtures to rewrite.
        } else {
            rename_git_dirs(&path);
        }
    }
}

/// Writes a file and commits it.
///
/// Stands in for the `makeCommit` helper in `app/test/helpers/repository-scaffolding.ts`.
pub fn commit_file(repo: &Path, name: &str, contents: &str, message: &str) {
    std::fs::write(repo.join(name), contents)
        .unwrap_or_else(|e| panic!("failed to write {name}: {e}"));
    run(repo, &["add", "--", name]);
    run(repo, &["commit", "-m", message]);
}

/// Builds a repository with a merge conflict in a file named `foo`.
///
/// Ported from `setupConflictedRepo` in `app/test/helpers/repositories.ts`: two divergent commits
/// touch the same file, then a merge is attempted.
///
/// Note the merge target is `main`, whereas the original merged `master` — see
/// [`empty_repository`] for why the branch name differs.
pub async fn conflicted_repository() -> TempRepository {
    let repo = empty_repository().await;
    let path = repo.path();

    commit_file(&path, "foo", "", "first");

    // Branch from the first commit without checking out, so the histories diverge.
    run(&path, &["branch", "other-branch"]);
    commit_file(&path, "foo", "b1", "second");

    run(&path, &["checkout", "other-branch"]);
    commit_file(&path, "foo", "b2", "third");

    // Expected to fail: this is the conflict the fixture exists to produce.
    let merge = run_allowing_failure(&path, &["merge", "main"]);
    assert!(
        !merge.status.success(),
        "the merge was supposed to conflict but succeeded; the setup no longer produces a \
         conflicted repository"
    );

    repo
}

/// Builds a repository with a **modify/delete** conflict in a file named `foo`.
///
/// `HEAD` modified it and the merged branch deleted it, so git reports `UD` — "deleted by them". This
/// is the conflict whose resolution cannot be expressed by content alone: choosing the side that
/// deleted the file means staging a removal, and `git checkout --theirs` refuses the path outright
/// ("does not have their version").
pub async fn delete_modify_conflicted_repository() -> TempRepository {
    let repo = empty_repository().await;
    let path = repo.path();

    commit_file(&path, "foo", "base\n", "first");

    run(&path, &["branch", "deletes-it"]);
    commit_file(&path, "foo", "changed\n", "modified on the current branch");

    run(&path, &["checkout", "deletes-it"]);
    run(&path, &["rm", "--", "foo"]);
    run(&path, &["commit", "-m", "deleted on the other branch"]);

    run(&path, &["checkout", "main"]);

    // Expected to fail: this is the conflict the fixture exists to produce.
    let merge = run_allowing_failure(&path, &["merge", "deletes-it"]);
    assert!(
        !merge.status.success(),
        "the merge was supposed to conflict but succeeded; the setup no longer produces a \
         modify/delete conflict"
    );

    repo
}

/// Paths with unmerged (conflicted) entries in the index.
///
/// Uses git as the oracle — `git ls-files -u` lists unmerged entries — so tests don't have to go
/// through the app's status parser, which is not part of this crate.
pub async fn unmerged_paths(repo: &Path) -> Vec<String> {
    let output = crate::exec::git(
        &["ls-files", "-u", "-z"],
        repo,
        "test-support",
        crate::exec::GitOptions::default(),
    )
    .await
    .expect("ls-files -u should succeed in a repository");

    let mut paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|entry| !entry.is_empty())
        // Each record is "<mode> <sha> <stage>\t<path>"; the same path appears once per stage.
        .filter_map(|entry| entry.split_once('\t').map(|(_, path)| path.to_owned()))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}
