//! Identifying repositories and resolving upstream refs.
//!
//! Ported from `desktop-plus/app/src/lib/git/rev-parse.ts`.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// What, if anything, lives at a given path.
///
/// Mirrors the `RepositoryType` union in `src/models/repository-type.ts`: internally tagged on a **lowercase**
/// `kind`, with camelCase fields, which is how the original spelled it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum RepositoryType {
    /// A bare repository.
    Bare,
    /// An ordinary repository with a working tree.
    Regular {
        top_level_working_directory: PathBuf,
        git_dir: PathBuf,
    },
    /// Nothing usable here — the path doesn't exist, isn't a directory, or isn't a repository.
    Missing,
    /// A repository git refuses to work with because it's owned by a different user.
    ///
    /// The user has to add it to `safe.directory` to proceed.
    Unsafe { path: PathBuf },
}

/// Determines what kind of repository (if any) is at `path`.
///
/// Does the work of `isGitRepository` and `isBareRepository` in a single git invocation, as the
/// original did.
pub async fn get_repository_type(path: impl AsRef<Path>) -> Result<RepositoryType, GitError> {
    get_repository_type_with_env(path, HashMap::new()).await
}

/// [`get_repository_type`], with extra environment variables for the git invocation.
///
/// Exists so tests can set `GIT_TEST_ASSUME_DIFFERENT_OWNER` and a stub `HOME` per-invocation.
/// The original test mutated `process.env` instead, which leaks into anything running afterwards
/// in the same process.
pub(crate) async fn get_repository_type_with_env(
    path: impl AsRef<Path>,
    env: HashMap<String, String>,
) -> Result<RepositoryType, GitError> {
    let path = path.as_ref();

    // Checked before spawning, as the original did: a missing directory is an answer, not an error.
    if !path.is_dir() {
        return Ok(RepositoryType::Missing);
    }

    let result = git(
        &[
            "rev-parse",
            "--is-bare-repository",
            "--show-cdup",
            "--git-dir",
        ],
        path,
        "getRepositoryType",
        GitOptions {
            env,
            ..GitOptions::default()
        }
        .with_success_exit_codes([128]),
    )
    .await;

    let result = match result {
        Ok(result) => result,
        // The original caught ENOENT here to cover the path disappearing between the check above
        // and the spawn — a real race, since another process can remove the directory.
        Err(GitError::Spawn { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RepositoryType::Missing);
        }
        Err(other) => return Err(other),
    };

    if result.exit_code == 0 {
        let stdout = result.stdout_lossy();

        // Bare repositories don't report a git dir, so they're handled before the full parse.
        if stdout.starts_with("true\n") {
            return Ok(RepositoryType::Bare);
        }

        // --is-bare-repository and --show-cdup are each a single line, but --git-dir could
        // contain newlines, so the known fields are parsed first and the rest is the git dir.
        if let Some(captures) = output_pattern().captures(&stdout) {
            let is_bare = captures.get(1).map_or("", |m| m.as_str());
            let cdup = captures.get(2).map_or("", |m| m.as_str());
            let git_dir = captures.get(3).map_or("", |m| m.as_str());

            return Ok(if is_bare == "true" {
                RepositoryType::Bare
            } else {
                RepositoryType::Regular {
                    top_level_working_directory: resolve(path, cdup),
                    git_dir: resolve(path, git_dir),
                }
            });
        }
    }

    if let Some(captures) = dubious_ownership_pattern().captures(&result.stderr) {
        if let Some(unsafe_path) = captures.get(1) {
            return Ok(RepositoryType::Unsafe {
                path: PathBuf::from(unsafe_path.as_str()),
            });
        }
    }

    Ok(RepositoryType::Missing)
}

/// `^(true|false)\n(.*)\n([\s\S]*)\n$` from the original.
///
/// `(?s)` makes `.` match newlines for the git-dir group; the cdup group is spelled `[^\n]*` so it
/// stays line-bounded, which is what the original's un-flagged `.*` meant.
fn output_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?s)^(true|false)\n([^\n]*)\n(.*)\n$").expect("pattern is valid")
    })
}

fn dubious_ownership_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"fatal: detected dubious ownership in repository at '(.+)'")
            .expect("pattern is valid")
    })
}

/// Resolves `relative` against `base`, **lexically**.
///
/// Equivalent to Node's `path.resolve`, and deliberately not [`std::fs::canonicalize`]: canonicalize
/// resolves symlinks, which would make the returned working-directory path differ from the one the
/// caller passed in. That matters immediately on macOS, where the temp directory is a symlink
/// (`/var` → `/private/var`), so canonicalizing would break any comparison against the input path.
fn resolve(base: &Path, relative: &str) -> PathBuf {
    let joined = if relative.is_empty() {
        base.to_path_buf()
    } else {
        base.join(relative)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

/// The absolute path to a repository's git directory.
///
/// The original derived this as `gitDir ?? join(path, '.git')` on the `Repository` model, where
/// `gitDir` was populated from [`get_repository_type`] only for linked worktrees. Asking git
/// directly is both simpler and correct in more cases: in a worktree or a submodule `.git` is a
/// *file* pointing elsewhere, so the naive join yields a path that isn't a directory at all.
pub async fn resolve_git_dir(repository: impl AsRef<Path>) -> Result<PathBuf, GitError> {
    let output = git(
        &["rev-parse", "--absolute-git-dir"],
        repository,
        "resolveGitDir",
        GitOptions::default(),
    )
    .await?;

    Ok(PathBuf::from(output.stdout_trimmed()))
}

/// The full symbolic name of a ref's upstream, or `None` if it has none.
///
/// `ref_name` defaults to the current branch when omitted.
pub async fn get_upstream_ref_for_ref(
    path: impl AsRef<Path>,
    ref_name: Option<&str>,
) -> Result<Option<String>, GitError> {
    let rev = format!("{}@{{upstream}}", ref_name.unwrap_or_default());
    let result = git(
        &["rev-parse", "--symbolic-full-name", &rev],
        path,
        "getUpstreamRefForRef",
        // 128 covers "no upstream configured", which is a normal answer.
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    Ok(if result.exit_code == 0 {
        Some(result.stdout_trimmed())
    } else {
        None
    })
}

/// The remote name from a ref's upstream, e.g. `origin`.
pub async fn get_upstream_remote_name_for_ref(
    path: impl AsRef<Path>,
    ref_name: Option<&str>,
) -> Result<Option<String>, GitError> {
    let Some(upstream) = get_upstream_ref_for_ref(path, ref_name).await? else {
        return Ok(None);
    };

    Ok(remote_name_pattern()
        .captures(&upstream)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned()))
}

fn remote_name_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^refs/remotes/([^/]+)/").expect("pattern is valid"))
}

/// The upstream ref of the current branch.
pub async fn get_current_upstream_ref(path: impl AsRef<Path>) -> Result<Option<String>, GitError> {
    get_upstream_ref_for_ref(path, None).await
}

/// The upstream remote name of the current branch.
pub async fn get_current_upstream_remote_name(
    path: impl AsRef<Path>,
) -> Result<Option<String>, GitError> {
    get_upstream_remote_name_for_ref(path, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, fixture_repository};

    #[tokio::test]
    async fn returns_regular_for_a_default_initialized_repository() {
        let repo = empty_repository().await;
        let result = get_repository_type(repo.path())
            .await
            .expect("rev-parse should succeed");

        match result {
            RepositoryType::Regular {
                top_level_working_directory,
                git_dir,
            } => {
                // Compared without canonicalizing, which is why `resolve` is lexical.
                assert_eq!(top_level_working_directory, repo.path());
                assert_eq!(
                    std::fs::canonicalize(&git_dir).expect("git dir should exist"),
                    std::fs::canonicalize(repo.path().join(".git")).expect("should exist")
                );
            }
            other => panic!("expected Regular, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_bare_for_a_bare_repository() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        git(
            &["init", "--bare"],
            dir.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("init --bare should succeed");

        assert_eq!(
            get_repository_type(dir.path())
                .await
                .expect("rev-parse should succeed"),
            RepositoryType::Bare
        );
    }

    #[tokio::test]
    async fn returns_missing_for_an_empty_directory() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        assert_eq!(
            get_repository_type(dir.path())
                .await
                .expect("should not error"),
            RepositoryType::Missing
        );
    }

    #[tokio::test]
    async fn returns_missing_for_a_missing_directory() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        assert_eq!(
            get_repository_type(dir.path().join("missing-folder"))
                .await
                .expect("should not error"),
            RepositoryType::Missing
        );
    }

    #[tokio::test]
    async fn returns_the_working_directory_when_run_from_a_subdirectory() {
        let repo = empty_repository().await;
        let nested = repo.path().join("a/b");
        std::fs::create_dir_all(&nested).expect("failed to create nested directories");

        match get_repository_type(&nested)
            .await
            .expect("rev-parse should succeed")
        {
            RepositoryType::Regular {
                top_level_working_directory,
                ..
            } => {
                // Exercises the --show-cdup handling: the answer is the repository root, not the
                // directory git ran in.
                assert_eq!(top_level_working_directory, repo.path());
            }
            other => panic!("expected Regular, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_unsafe_when_git_reports_dubious_ownership() {
        let repo = fixture_repository("test-repo").await;

        // A stub HOME with an empty safe.directory clears any system-wide `*` entry that would
        // otherwise suppress the ownership warning — CI images set one, which is what makes this
        // neutralization necessary rather than defensive.
        let home = tempfile::tempdir().expect("failed to create a temporary HOME");
        let config = home.path().join(".gitconfig");
        std::fs::write(&config, "[safe]\ndirectory=\n").expect("failed to write the stub config");

        let env = HashMap::from([
            (
                "HOME".to_owned(),
                home.path().to_string_lossy().into_owned(),
            ),
            // `GIT_CONFIG_GLOBAL` outranks HOME, so an ambient one would put the machine's own config
            // back in play and the stub above would do nothing. Same reasoning as `GlobalConfig::env`.
            (
                "GIT_CONFIG_GLOBAL".to_owned(),
                config.to_string_lossy().into_owned(),
            ),
            ("GIT_TEST_ASSUME_DIFFERENT_OWNER".to_owned(), "1".to_owned()),
        ]);

        let result = get_repository_type_with_env(repo.path(), env)
            .await
            .expect("should not error");

        assert!(
            matches!(result, RepositoryType::Unsafe { .. }),
            "expected Unsafe, got {result:?}"
        );
    }

    // --- upstream refs ---

    #[tokio::test]
    async fn returns_none_when_a_branch_has_no_upstream() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");

        assert_eq!(
            get_current_upstream_ref(repo.path())
                .await
                .expect("should not error"),
            None
        );
        assert_eq!(
            get_current_upstream_remote_name(repo.path())
                .await
                .expect("should not error"),
            None
        );
    }

    #[tokio::test]
    async fn resolves_an_upstream_ref_and_remote_name() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");

        // Set up remote tracking without needing a second repository to fetch from.
        //
        // `git remote add` is used rather than writing branch.*.remote/merge by hand: resolving
        // `@{upstream}` needs the remote's *fetch refspec* to map refs/heads/main on origin to
        // refs/remotes/origin/main, and hand-written branch config alone leaves it unresolvable.
        let head = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse HEAD should succeed")
        .stdout_trimmed();

        git(
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/repo.git",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("remote add should succeed");
        git(
            &["update-ref", "refs/remotes/origin/main", &head],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("update-ref should succeed");
        git(
            &["branch", "--set-upstream-to=origin/main", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("--set-upstream-to should succeed once the tracking ref exists");

        assert_eq!(
            get_current_upstream_ref(repo.path())
                .await
                .expect("should not error")
                .as_deref(),
            Some("refs/remotes/origin/main")
        );
        assert_eq!(
            get_current_upstream_remote_name(repo.path())
                .await
                .expect("should not error")
                .as_deref(),
            Some("origin")
        );
    }

    // --- lexical path resolution ---

    #[test]
    fn resolve_handles_empty_cdup() {
        assert_eq!(resolve(Path::new("/a/b"), ""), PathBuf::from("/a/b"));
    }

    #[test]
    fn resolve_normalizes_the_repository_root_when_cdup_is_empty() {
        assert_eq!(
            resolve(Path::new("/a/nested/../repository"), ""),
            PathBuf::from("/a/repository")
        );
    }

    #[test]
    fn resolve_walks_up_for_cdup() {
        assert_eq!(resolve(Path::new("/a/b/c"), "../../"), PathBuf::from("/a"));
    }

    #[test]
    fn resolve_joins_a_relative_git_dir() {
        assert_eq!(
            resolve(Path::new("/a/b"), ".git"),
            PathBuf::from("/a/b/.git")
        );
    }

    #[test]
    fn resolve_keeps_an_absolute_git_dir() {
        assert_eq!(
            resolve(Path::new("/a/b"), "/elsewhere/.git"),
            PathBuf::from("/elsewhere/.git")
        );
    }
}
