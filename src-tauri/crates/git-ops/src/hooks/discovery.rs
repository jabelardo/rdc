//! Finding the hooks a repository actually has.
//!
//! Ported from `desktop-plus/app/src/lib/hooks/get-repo-hooks.ts`.

use std::path::{Path, PathBuf};

use crate::config::get_config_value;
use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Every hook name git recognizes.
///
/// A stand-in is only ever installed for a name on this list. Copying one for an arbitrary executable
/// in the hooks directory would mean pointing `core.hooksPath` at a directory holding files git has no
/// reason to run — and, worse, shadowing a real hook whose name we didn't recognize.
pub const KNOWN_HOOKS: [&str; 28] = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "post-index-change",
];

/// The hooks in `repository` matching `filter`, sorted by name.
///
/// `filter` restricts the result to the named hooks; `None` means every hook found. A filter
/// containing `"*"` also means every hook — see the bug note below.
///
/// # Sorted, where the original yielded in directory order
///
/// The original was an async generator yielding in `readdir` order, which is filesystem-dependent. Its
/// only consumer collected the lot, so nothing depended on the order; sorting makes the result
/// reproducible and the tests meaningful.
///
/// # UPSTREAM BUG: a `"*"` filter returned *no* hooks
///
/// The original's loop began `if (matchAll || filter?.includes(hookName) === false) continue`, so when
/// `matchAll` was true it skipped every hook — the exact opposite of the documented "Including '*'
/// will return all hooks". The condition needed `!matchAll`. No caller in desktop-plus passes `"*"`, so
/// the bug is latent rather than live, but a caller adding it would silently get no hook interception
/// at all. Fixed here, with a test. See `MIGRATION_MAP.md` §8.
///
/// # Errors are absences
///
/// A hooks directory that doesn't exist, or can't be read, yields an empty list rather than an error —
/// as the original did. A repository with no hooks and a repository whose hooks directory was deleted
/// are the same thing to the caller.
pub async fn get_repo_hooks(
    repository: impl AsRef<Path>,
    filter: Option<&[String]>,
) -> Result<Vec<String>, GitError> {
    let repository = repository.as_ref();
    let hooks_path = resolve_hooks_path(repository).await?;

    let match_all = filter.is_some_and(|filter| filter.iter().any(|name| name == "*"));

    let Ok(mut entries) = tokio::fs::read_dir(&hooks_path).await else {
        return Ok(Vec::new());
    };

    let mut hooks = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| GitError::Parse {
            context: "getRepoHooks".to_owned(),
            message: format!("could not read {}: {error}", hooks_path.display()),
        })?
    {
        // Directories can't be hooks. A symlink to a script can, so this follows links rather than
        // testing the entry's own type.
        let Ok(metadata) = tokio::fs::metadata(entry.path()).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }

        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            // A hook has to be named after a known hook, and those are all ASCII, so a non-UTF-8 name
            // cannot be one.
            continue;
        };
        // `.exe` is stripped for Windows, where hooks may be compiled executables.
        let hook_name = name.strip_suffix(".exe").unwrap_or(name);

        if !match_all && filter.is_some_and(|filter| !filter.iter().any(|f| f == hook_name)) {
            continue;
        }

        if !KNOWN_HOOKS.contains(&hook_name) {
            continue;
        }

        if is_executable(&metadata) {
            hooks.push(hook_name.to_owned());
        }
    }

    hooks.sort();
    hooks.dedup();
    Ok(hooks)
}

/// Whether git would consider this file runnable.
///
/// # Mode bits, where the original called `access(2)`
///
/// The original used `access(path, X_OK)`, which answers for the *effective user* and respects ACLs.
/// Rust's standard library has no `access`, and pulling in `libc` for one check isn't worth it, so this
/// tests the mode bits. They differ only for a file the current user can't execute despite the bit
/// being set — a hook owned by someone else with `--x` for the owner alone. In that case a stand-in is
/// installed for a hook git will then decline to run, and git says so; the failure is visible rather
/// than silent, which is why the approximation is acceptable.
#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

/// On Windows any validly-named file counts.
///
/// The original's reasoning, kept: there is no executable bit, and git looks for a shebang — too
/// expensive to reproduce here for a check that only decides whether to offer interception.
#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    true
}

/// Where this repository's hooks live.
///
/// `core.hooksPath` wins when set, exactly as it does for git. Otherwise `rev-parse --git-path hooks`
/// answers it, which is correct in a worktree or submodule where `.git` is a file pointing elsewhere.
///
/// A relative value is resolved against the repository root, as the original did — git resolves
/// `core.hooksPath` relative to the current working directory, and every caller here runs git *in* the
/// repository.
async fn resolve_hooks_path(repository: &Path) -> Result<PathBuf, GitError> {
    // Neither invocation may go through anything that installs hook interception, or discovery would
    // recurse: git runs the stand-in, which asks the app, which discovers hooks by running git. The
    // original called dugite directly to avoid exactly that, and noted it. `exec::git` performs no
    // interception — when that changes, this must opt out.
    if let Some(configured) = get_config_value(repository, "core.hooksPath", false).await? {
        if !configured.is_empty() {
            return Ok(resolve_against(repository, &configured));
        }
    }

    let output = git(
        &["rev-parse", "--git-path", "hooks"],
        repository,
        "getRepoHooks",
        GitOptions::default(),
    )
    .await?;

    Ok(resolve_against(
        repository,
        output.stdout_lossy().trim_end_matches(['\r', '\n']),
    ))
}

/// Joins `path` onto the repository root unless it is already absolute.
fn resolve_against(repository: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        repository.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, TempRepository};

    /// Writes a file into the repository's hooks directory, executable or not.
    fn write_hook(repo: &Path, name: &str, executable: bool) {
        let dir = repo.join(".git").join("hooks");
        std::fs::create_dir_all(&dir).expect("failed to create the hooks directory");
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").expect("failed to write the hook");
        set_executable(&path, executable);
    }

    #[cfg(unix)]
    fn set_executable(path: &Path, executable: bool) {
        use std::os::unix::fs::PermissionsExt;

        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .expect("failed to set permissions");
    }

    #[cfg(not(unix))]
    fn set_executable(_path: &Path, _executable: bool) {}

    async fn repo() -> TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        repo
    }

    #[tokio::test]
    async fn finds_an_executable_hook() {
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", true);

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            vec!["pre-commit".to_owned()]
        );
    }

    #[tokio::test]
    async fn ignores_a_hook_that_is_not_executable() {
        // git wouldn't run it, so intercepting it would change behaviour rather than preserve it.
        // This is also what git's own `.sample` files are: present, not executable.
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", false);

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn ignores_a_name_git_does_not_recognize() {
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", true);
        write_hook(&repo.path(), "my-own-script", true);

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            vec!["pre-commit".to_owned()],
            "a stand-in must never shadow something git wouldn't have run"
        );
    }

    #[tokio::test]
    async fn ignores_the_sample_hooks_git_installs() {
        // A fresh repository is full of `pre-commit.sample` and friends. They are neither known names
        // nor executable, and reporting them would mean intercepting hooks nobody wrote.
        let repo = repo().await;
        let samples = repo.path().join(".git").join("hooks");
        std::fs::create_dir_all(&samples).expect("failed to create the hooks directory");
        std::fs::write(samples.join("pre-commit.sample"), "#!/bin/sh\n")
            .expect("failed to write the sample");
        set_executable(&samples.join("pre-commit.sample"), true);

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn restricts_the_result_to_the_filter() {
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", true);
        write_hook(&repo.path(), "post-commit", true);
        write_hook(&repo.path(), "pre-push", true);

        assert_eq!(
            get_repo_hooks(repo.path(), Some(&["pre-commit".to_owned()]))
                .await
                .expect("discovery should succeed"),
            vec!["pre-commit".to_owned()]
        );
    }

    #[tokio::test]
    async fn a_star_filter_returns_every_hook() {
        // UPSTREAM BUG FIX. The original's condition skipped every hook when the filter contained
        // `"*"`, which is the opposite of what it documented. No caller passed `"*"`, so it was latent
        // — a caller adding it would have got silent no-op interception.
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", true);
        write_hook(&repo.path(), "post-commit", true);

        assert_eq!(
            get_repo_hooks(repo.path(), Some(&["*".to_owned()]))
                .await
                .expect("discovery should succeed"),
            vec!["post-commit".to_owned(), "pre-commit".to_owned()]
        );
    }

    #[tokio::test]
    async fn an_empty_filter_matches_nothing() {
        // Distinct from `None`, which matches everything. An empty list is a caller that asked for no
        // hooks, and it must not be read as "no preference".
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", true);

        assert_eq!(
            get_repo_hooks(repo.path(), Some(&[]))
                .await
                .expect("discovery should succeed"),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn reports_hooks_sorted_rather_than_in_directory_order() {
        let repo = repo().await;
        for name in ["pre-push", "commit-msg", "post-commit"] {
            write_hook(&repo.path(), name, true);
        }

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            vec![
                "commit-msg".to_owned(),
                "post-commit".to_owned(),
                "pre-push".to_owned()
            ],
            "readdir order is filesystem-dependent; the result must not be"
        );
    }

    #[tokio::test]
    async fn honours_core_hooks_path() {
        let repo = repo().await;
        // Deliberately inside the repository, so the test can't be satisfied by the default location.
        let elsewhere = repo.path().join("my-hooks");
        std::fs::create_dir_all(&elsewhere).expect("failed to create the directory");
        let path = elsewhere.join("pre-commit");
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").expect("failed to write the hook");
        set_executable(&path, true);
        // And a decoy in the default location, which must be ignored.
        write_hook(&repo.path(), "pre-push", true);

        git(
            &["config", "core.hooksPath", "my-hooks"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("config should succeed");

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            vec!["pre-commit".to_owned()],
            "core.hooksPath replaces the default location, it doesn't add to it"
        );
    }

    #[tokio::test]
    async fn accepts_an_absolute_core_hooks_path() {
        let repo = repo().await;
        let elsewhere = tempfile::tempdir().expect("failed to create a temporary directory");
        let path = elsewhere.path().join("commit-msg");
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").expect("failed to write the hook");
        set_executable(&path, true);

        git(
            &[
                "config",
                "core.hooksPath",
                elsewhere.path().to_str().expect("a UTF-8 path"),
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("config should succeed");

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            vec!["commit-msg".to_owned()]
        );
    }

    #[tokio::test]
    async fn finds_hooks_in_a_linked_worktree() {
        // `rev-parse --git-path hooks` is what makes this work: a linked worktree's `.git` is a file,
        // so joining `.git/hooks` onto the path would not be a directory at all. The hooks live in the
        // *common* directory, shared with the main worktree.
        let repo = repo().await;
        write_hook(&repo.path(), "pre-commit", true);

        let elsewhere = tempfile::tempdir().expect("failed to create a temporary directory");
        let linked = elsewhere.path().join("linked");
        git(
            &[
                "worktree",
                "add",
                linked.to_str().expect("a UTF-8 path"),
                "-b",
                "topic",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("adding the worktree should succeed");

        assert_eq!(
            get_repo_hooks(&linked, None)
                .await
                .expect("discovery should succeed"),
            vec!["pre-commit".to_owned()],
            "the linked worktree shares the main worktree's hooks"
        );
    }

    #[tokio::test]
    async fn reports_nothing_when_the_hooks_directory_is_missing() {
        let repo = repo().await;
        std::fs::remove_dir_all(repo.path().join(".git").join("hooks"))
            .expect("failed to remove the hooks directory");

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("a missing hooks directory is an absence, not an error"),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn ignores_a_directory_named_after_a_hook() {
        let repo = repo().await;
        let dir = repo.path().join(".git").join("hooks").join("pre-commit");
        std::fs::create_dir_all(&dir).expect("failed to create the directory");

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            Vec::<String>::new()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn follows_a_symlink_to_an_executable_hook() {
        // A shared hooks setup often symlinks into a checked-in directory, and the link itself carries
        // no useful mode — which is why the metadata call follows it.
        let repo = repo().await;
        let real = repo.path().join("real-pre-commit");
        std::fs::write(&real, "#!/bin/sh\nexit 0\n").expect("failed to write");
        set_executable(&real, true);

        let hooks = repo.path().join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("failed to create the hooks directory");
        std::os::unix::fs::symlink(&real, hooks.join("pre-commit")).expect("failed to symlink");

        assert_eq!(
            get_repo_hooks(repo.path(), None)
                .await
                .expect("discovery should succeed"),
            vec!["pre-commit".to_owned()]
        );
    }

    #[test]
    fn the_known_hook_list_has_no_duplicates() {
        // It gates what a stand-in may be installed for, so a typo'd duplicate hiding a missing name
        // would be easy to miss.
        let mut sorted = KNOWN_HOOKS.to_vec();
        sorted.sort_unstable();
        let unique = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), unique);
    }
}
