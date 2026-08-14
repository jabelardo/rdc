//! Checking out branches, commits and paths.
//!
//! Ported from `desktop-plus/app/src/lib/git/checkout.ts`.
//!
//! # Deferred
//!
//! Two things the original did are not here yet, each with a real prerequisite:
//!
//! - ~~**Submodule updates.**~~ **Done.** The original weighted the checkout itself as the first 90%
//!   and reserved the last 10% for `updateSubmodulesAfterOperation`; that split is restored, see
//!   [`CHECKOUT_STEP_WEIGHT`].
//! - **Remote environment and auth.** `envForRemoteOperation` plus `AuthenticationErrors` need the
//!   trampoline handlers, which are transport-complete but not wired to account state.
//!
//! What remains is the checkout itself, which is what everything above decorates.

use std::ffi::OsStr;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, git_with_stderr_and_lfs, GitOptions};
use crate::progress::{GitLfsProgressParser, GitProgress};

/// Repository state that must survive an interrupted checkout.
///
/// This is deliberately only the tracked-state portion of the final recovery snapshot. Checkout
/// cancellation stays unavailable until untracked paths are captured and this snapshot has a
/// tested restore operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutSnapshot {
    /// The branch ref `HEAD` pointed at, or `None` for a detached checkout.
    pub symbolic_head: Option<String>,
    /// The commit checked out before the operation started.
    pub head_sha: String,
    /// Exact on-disk index bytes, including extensions and staged file modes.
    pub index: Option<Vec<u8>>,
    /// Binary-safe patch representing the tracked worktree relative to `HEAD`.
    pub tracked_worktree_patch: Vec<u8>,
}

/// Captures the tracked repository state required to recover an interrupted checkout.
///
/// The raw index is intentional: reconstructing it from a tree would lose partially staged files,
/// intent-to-add entries, and index extensions. `git diff --binary HEAD` captures the final tracked
/// worktree state independently, so staged and unstaged versions of the same path remain distinct.
pub async fn get_checkout_snapshot(
    repository: impl AsRef<Path>,
) -> Result<CheckoutSnapshot, GitError> {
    let repository = repository.as_ref();
    let symbolic_head = crate::refs::get_symbolic_ref(repository, "HEAD").await?;
    let head_sha = crate::rev_parse::get_head_sha(repository).await?;
    let git_dir = crate::rev_parse::resolve_git_dir(repository).await?;
    let index_path = git_dir.join("index");
    let index = match tokio::fs::read(&index_path).await {
        Ok(index) => Some(index),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(GitError::Spawn {
                name: "readCheckoutIndex".to_owned(),
                path: index_path,
                source,
            });
        }
    };
    let tracked_worktree_patch = git(
        &["diff", "--binary", "--full-index", "HEAD", "--"],
        repository,
        "getCheckoutSnapshot",
        GitOptions::default(),
    )
    .await?
    .stdout;

    Ok(CheckoutSnapshot {
        symbolic_head,
        head_sha,
        index,
        tracked_worktree_patch,
    })
}

/// Restores the tracked portion of a checkout snapshot.
///
/// Callers must stop the checkout process and hold the repository operation lock first. This does
/// not restore untracked paths, so it is not yet sufficient to advertise Checkout cancellation.
pub async fn restore_checkout_snapshot(
    repository: impl AsRef<Path>,
    snapshot: &CheckoutSnapshot,
) -> Result<(), GitError> {
    let repository = repository.as_ref();
    if let Some(symbolic_head) = &snapshot.symbolic_head {
        git(
            &["symbolic-ref", "HEAD", symbolic_head],
            repository,
            "restoreCheckoutHead",
            GitOptions::default(),
        )
        .await?;
        git(
            &["reset", "--hard", &snapshot.head_sha],
            repository,
            "restoreCheckoutHead",
            GitOptions::default(),
        )
        .await?;
    } else {
        git(
            &["checkout", "--detach", "--force", &snapshot.head_sha, "--"],
            repository,
            "restoreCheckoutHead",
            GitOptions::default(),
        )
        .await?;
    }

    restore_checkout_index(repository, snapshot.index.as_deref()).await?;
    if !snapshot.tracked_worktree_patch.is_empty() {
        git(
            &["apply", "--binary", "--whitespace=nowarn", "-"],
            repository,
            "restoreCheckoutWorktree",
            GitOptions::default().with_stdin(snapshot.tracked_worktree_patch.clone()),
        )
        .await?;
    }

    Ok(())
}

async fn restore_checkout_index(repository: &Path, index: Option<&[u8]>) -> Result<(), GitError> {
    let git_dir = crate::rev_parse::resolve_git_dir(repository).await?;
    let index_path = git_dir.join("index");
    let Some(index) = index else {
        match tokio::fs::remove_file(&index_path).await {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(GitError::Spawn {
                    name: "restoreCheckoutIndex".to_owned(),
                    path: index_path,
                    source,
                });
            }
        }
    };

    let mut temporary = tempfile::Builder::new()
        .prefix("rdc-checkout-index-")
        .tempfile_in(&git_dir)
        .map_err(|source| GitError::Spawn {
            name: "restoreCheckoutIndex".to_owned(),
            path: index_path.clone(),
            source,
        })?;
    temporary
        .write_all(index)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|source| GitError::Spawn {
            name: "restoreCheckoutIndex".to_owned(),
            path: index_path.clone(),
            source,
        })?;
    temporary
        .persist(&index_path)
        .map_err(|error| GitError::Spawn {
            name: "restoreCheckoutIndex".to_owned(),
            path: index_path,
            source: error.error,
        })?;
    Ok(())
}

/// A checkout progress update sent to the frontend.
///
/// Matches the ported [`src/models/progress.ts`](../../../../../src/models/progress.ts)
/// `ICheckoutProgress` shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutProgress {
    pub kind: CheckoutProgressKind,
    pub value: f64,
    pub title: String,
    pub description: String,
    pub target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutProgressKind {
    Checkout,
}

/// Incrementally parses the carriage-return-delimited progress records git writes to stderr.
#[derive(Debug, Default)]
struct CheckoutProgressParser {
    pending: Vec<u8>,
}

impl CheckoutProgressParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<(f64, String)> {
        self.pending.extend_from_slice(chunk);
        let mut records = Vec::new();
        let mut start = 0;

        for index in 0..self.pending.len() {
            if matches!(self.pending[index], b'\r' | b'\n') {
                if index > start {
                    if let Some(progress) = parse_checkout_progress_line(&String::from_utf8_lossy(
                        &self.pending[start..index],
                    )) {
                        records.push(progress);
                    }
                }
                start = index + 1;
            }
        }

        if start > 0 {
            self.pending.drain(..start);
        }
        records
    }

    fn finish(&mut self) -> Option<(f64, String)> {
        let pending = std::mem::take(&mut self.pending);
        (!pending.is_empty())
            .then(|| parse_checkout_progress_line(&String::from_utf8_lossy(&pending)))
            .flatten()
    }
}

fn parse_checkout_progress_line(line: &str) -> Option<(f64, String)> {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    static CHECKOUT: OnceLock<Regex> = OnceLock::new();

    let ansi = ANSI.get_or_init(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("the built-in ANSI regex should compile")
    });
    let checkout = CHECKOUT.get_or_init(|| {
        Regex::new(r"^Checking out files:\s+(\d{1,3})% \((\d+)/(\d+)\)(?:, done\.)?$")
            .expect("the built-in checkout progress regex should compile")
    });

    let text = ansi.replace_all(line, "").into_owned();
    let captures = checkout.captures(&text)?;
    let value: f64 = captures.get(2)?.as_str().parse().ok()?;
    let total: f64 = captures.get(3)?.as_str().parse().ok()?;
    if total == 0.0 {
        return None;
    }

    Some(((value / total).clamp(0.0, 1.0), text))
}

/// How much of a checkout's progress the checkout itself accounts for.
///
/// The original's `CheckoutStepWeight`. The remaining tenth belongs to updating submodules, which runs
/// afterwards and has no way to know how much work it will be — see
/// [`crate::submodule::update_submodules`].
const CHECKOUT_STEP_WEIGHT: f64 = 0.9;

/// What to check out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutTarget<'a> {
    /// A branch that already exists locally.
    Local(&'a str),

    /// A remote-tracking branch, checked out by creating a local branch from it.
    ///
    /// The original derived this from `BranchType.Remote`, running
    /// `checkout <remote_ref> -b <local_name>`. Note the argument order: the revision comes first
    /// and `-b` names the branch to create, so git sets up tracking against the remote ref.
    Remote {
        /// The remote-tracking ref, e.g. `origin/topic`.
        remote_ref: &'a str,
        /// The local branch to create, e.g. `topic`.
        local_name: &'a str,
    },
}

/// Checks out a branch.
///
/// Fails if `local_name` already exists when checking out a remote branch — git refuses rather than
/// silently repointing an existing branch, which the original's tests relied on.
pub async fn checkout_branch(
    repository: impl AsRef<Path>,
    target: CheckoutTarget<'_>,
) -> Result<(), GitError> {
    let mut args: Vec<&OsStr> = vec![OsStr::new("checkout")];

    match target {
        CheckoutTarget::Local(name) => args.push(OsStr::new(name)),
        CheckoutTarget::Remote {
            remote_ref,
            local_name,
        } => {
            args.push(OsStr::new(remote_ref));
            args.push(OsStr::new("-b"));
            args.push(OsStr::new(local_name));
        }
    }

    // The original appended `--` for branch checkouts, which stops a branch whose name looks like a
    // path from being taken as one.
    args.push(OsStr::new("--"));

    git(&args, repository, "checkoutBranch", GitOptions::default()).await?;

    Ok(())
}

/// Checks out a branch while reporting progress as git updates the working tree.
pub async fn checkout_branch_with_progress<F>(
    repository: impl AsRef<Path>,
    target: CheckoutTarget<'_>,
    mut on_progress: F,
) -> Result<(), GitError>
where
    F: FnMut(CheckoutProgress) + Send,
{
    let mut args: Vec<&OsStr> = vec![OsStr::new("checkout"), OsStr::new("--progress")];
    let repository = repository.as_ref();
    let target_name = match target {
        CheckoutTarget::Local(name) => {
            args.push(OsStr::new(name));
            name
        }
        CheckoutTarget::Remote {
            remote_ref,
            local_name,
        } => {
            args.push(OsStr::new(remote_ref));
            args.push(OsStr::new("-b"));
            args.push(OsStr::new(local_name));
            remote_ref
        }
    };
    args.push(OsStr::new("--"));

    let title = format!("Checking out branch {target_name}");
    let make_progress = |value, description| CheckoutProgress {
        kind: CheckoutProgressKind::Checkout,
        value,
        title: title.clone(),
        description,
        target: target_name.to_owned(),
    };

    on_progress(make_progress(0.0, "Switching to branch".to_owned()));
    let mut parser = CheckoutProgressParser::default();
    let progress = Arc::new(Mutex::new(&mut on_progress));
    let regular_progress = Arc::clone(&progress);
    let lfs_progress = Arc::clone(&progress);
    let mut lfs_parser = GitLfsProgressParser::default();
    git_with_stderr_and_lfs(
        &args,
        repository,
        "checkoutBranch",
        GitOptions::default(),
        |chunk| {
            for (value, description) in parser.push(chunk) {
                // Scaled into the first 90%; submodules own the rest.
                with_progress_callback(&regular_progress, |callback| {
                    callback(make_progress(value * CHECKOUT_STEP_WEIGHT, description));
                });
            }
        },
        |line| {
            let parsed = lfs_parser.parse(line);
            if let GitProgress::Progress { percent, details } = parsed {
                with_progress_callback(&lfs_progress, |callback| {
                    callback(make_progress(percent * CHECKOUT_STEP_WEIGHT, details.text));
                });
            }
        },
    )
    .await?;
    drop(regular_progress);
    drop(lfs_progress);
    drop(progress);
    if let Some((value, description)) = parser.finish() {
        on_progress(make_progress(value * CHECKOUT_STEP_WEIGHT, description));
    }
    // Small repositories often produce no intermediate records, so mark the checkout step complete
    // explicitly before moving on to submodules.
    on_progress(make_progress(CHECKOUT_STEP_WEIGHT, title.clone()));

    update_submodules_for_checkout(repository, &mut on_progress, &make_progress).await?;

    Ok(())
}

/// Runs the submodule update that finishes a checkout, mapping its progress into the last tenth.
///
/// A submodule failure is **not** propagated. The checkout itself already succeeded and the branch has
/// changed; failing the whole call here would tell the user their checkout failed when it didn't, and
/// leave them with no way to see that it had. A submodule left un-updated is visible in the status list
/// and fixable, which is the better of the two.
async fn update_submodules_for_checkout<F, M>(
    repository: &Path,
    on_progress: &mut F,
    make_progress: &M,
) -> Result<(), GitError>
where
    F: FnMut(CheckoutProgress) + Send,
    M: Fn(f64, String) -> CheckoutProgress + Sync,
{
    let result = crate::submodule::update_submodules(
        repository,
        &std::collections::HashMap::new(),
        false,
        Some(|value: f64, description: String| {
            let scaled = CHECKOUT_STEP_WEIGHT + value * (1.0 - CHECKOUT_STEP_WEIGHT);
            on_progress(make_progress(scaled, description));
        }),
    )
    .await;

    if result.is_err() {
        // Report completion anyway: the checkout is done, and leaving progress at 90% for ever would be
        // a worse lie than a submodule that didn't update.
        on_progress(make_progress(
            1.0,
            "Submodules could not be updated".to_owned(),
        ));
    }

    Ok(())
}

/// Checks out a commit, leaving `HEAD` detached.
///
/// No `--` here, matching the original: a full SHA is unambiguous, and git needs to accept it as a
/// revision.
pub async fn checkout_commit(repository: impl AsRef<Path>, commit: &str) -> Result<(), GitError> {
    let args: [&OsStr; 2] = [OsStr::new("checkout"), OsStr::new(commit)];

    git(&args, repository, "checkoutCommit", GitOptions::default()).await?;

    Ok(())
}

/// Checks out a commit while reporting progress as git updates the working tree.
pub async fn checkout_commit_with_progress<F>(
    repository: impl AsRef<Path>,
    commit: &str,
    mut on_progress: F,
) -> Result<(), GitError>
where
    F: FnMut(CheckoutProgress) + Send,
{
    let args: [&OsStr; 3] = [
        OsStr::new("checkout"),
        OsStr::new("--progress"),
        OsStr::new(commit),
    ];
    let target = commit.chars().take(7).collect::<String>();
    let title = "Checking out commit".to_owned();
    let make_progress = |value, description| CheckoutProgress {
        kind: CheckoutProgressKind::Checkout,
        value,
        title: title.clone(),
        description,
        target: target.clone(),
    };

    on_progress(make_progress(0.0, title.clone()));
    let mut parser = CheckoutProgressParser::default();
    let progress = Arc::new(Mutex::new(&mut on_progress));
    let regular_progress = Arc::clone(&progress);
    let lfs_progress = Arc::clone(&progress);
    let mut lfs_parser = GitLfsProgressParser::default();
    git_with_stderr_and_lfs(
        &args,
        repository,
        "checkoutCommit",
        GitOptions::default(),
        |chunk| {
            for (value, description) in parser.push(chunk) {
                with_progress_callback(&regular_progress, |callback| {
                    callback(make_progress(value, description));
                });
            }
        },
        |line| {
            let parsed = lfs_parser.parse(line);
            if let GitProgress::Progress { percent, details } = parsed {
                with_progress_callback(&lfs_progress, |callback| {
                    callback(make_progress(percent, details.text));
                });
            }
        },
    )
    .await?;
    drop(regular_progress);
    drop(lfs_progress);
    drop(progress);
    if let Some((value, description)) = parser.finish() {
        on_progress(make_progress(value, description));
    }
    on_progress(make_progress(1.0, title.clone()));
    Ok(())
}

fn with_progress_callback<F, R>(callback: &Mutex<&mut F>, invoke: impl FnOnce(&mut F) -> R) -> R {
    let mut callback = callback
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    invoke(&mut callback)
}

/// Restores the given paths from `HEAD`, discarding working-tree changes to them.
///
/// A no-op when `paths` is empty — without the guard, `checkout HEAD --` with no pathspec would
/// still run.
pub async fn checkout_paths(
    repository: impl AsRef<Path>,
    paths: &[impl AsRef<Path>],
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut args: Vec<&OsStr> = vec![OsStr::new("checkout"), OsStr::new("HEAD"), OsStr::new("--")];
    args.extend(paths.iter().map(|path| path.as_ref().as_os_str()));

    git(&args, repository, "checkoutPaths", GitOptions::default()).await?;

    Ok(())
}

/// Which side of a conflict the user chose.
///
/// Mirrors `src/models/manual-conflict-resolution.ts`. The serialized values are passed straight to
/// git as `--ours`/`--theirs`, so they are not cosmetic — the original's model file carries the same
/// warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManualConflictResolution {
    Theirs,
    Ours,
}

impl ManualConflictResolution {
    /// The git flag for this side, without the leading dashes.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Theirs => "theirs",
            Self::Ours => "ours",
        }
    }
}

/// Checks out one side of a conflicted file — stage #2 (`ours`) or stage #3 (`theirs`).
///
/// This only rewrites the working-tree file; the index entry stays conflicted until the file is
/// staged. [`crate::stage::stage_manual_conflict_resolution`] does both.
pub async fn checkout_conflicted_file(
    repository: impl AsRef<Path>,
    file: impl AsRef<Path>,
    resolution: ManualConflictResolution,
) -> Result<(), GitError> {
    let flag = format!("--{}", resolution.as_str());
    let args: [&OsStr; 4] = [
        OsStr::new("checkout"),
        OsStr::new(&flag),
        OsStr::new("--"),
        file.as_ref().as_os_str(),
    ];

    git(
        &args,
        repository,
        "checkoutConflictedFile",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::get_symbolic_ref;
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

    /// The branch `HEAD` points at, or `None` when detached.
    async fn current_branch(repo: &Path) -> Option<String> {
        get_symbolic_ref(repo, "HEAD")
            .await
            .expect("symbolic-ref should not error")
            .map(|value| value.trim_start_matches("refs/heads/").to_owned())
    }

    #[tokio::test]
    async fn checkout_snapshot_keeps_head_index_and_tracked_worktree_separate() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file.txt", "base\n", "base");
        std::fs::write(repo.path().join("file.txt"), "staged\n")
            .expect("staged contents should be written");
        git(
            &["add", "file.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("staged contents should be indexed");
        std::fs::write(repo.path().join("file.txt"), "worktree\n")
            .expect("worktree contents should be written");

        let snapshot = get_checkout_snapshot(repo.path())
            .await
            .expect("checkout state should be captured");
        let git_dir = crate::rev_parse::resolve_git_dir(repo.path())
            .await
            .expect("git directory should resolve");
        let expected_index =
            std::fs::read(git_dir.join("index")).expect("index should be readable");

        assert_eq!(snapshot.symbolic_head.as_deref(), Some("refs/heads/main"));
        assert_eq!(
            snapshot.head_sha,
            crate::rev_parse::get_head_sha(repo.path())
                .await
                .expect("HEAD should resolve")
        );
        assert_eq!(snapshot.index.as_deref(), Some(expected_index.as_slice()));
        let patch = String::from_utf8(snapshot.tracked_worktree_patch)
            .expect("the textual fixture should produce a UTF-8 patch");
        assert!(patch.contains("-base"));
        assert!(patch.contains("+worktree"));
    }

    #[tokio::test]
    async fn checkout_snapshot_records_a_detached_head() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file.txt", "base\n", "base");
        let first = crate::rev_parse::get_head_sha(repo.path())
            .await
            .expect("first commit should resolve");
        commit_file(&repo.path(), "file.txt", "second\n", "second");
        git(
            &["checkout", "--detach", &first],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("HEAD should detach");

        let snapshot = get_checkout_snapshot(repo.path())
            .await
            .expect("detached checkout state should be captured");

        assert_eq!(snapshot.symbolic_head, None);
        assert_eq!(snapshot.head_sha, first);
    }

    #[tokio::test]
    async fn checkout_snapshot_restores_branch_index_and_tracked_worktree() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "file.txt", "base\n", "base");
        git(
            &["checkout", "-b", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("topic branch should be created");
        commit_file(&repo.path(), "file.txt", "topic\n", "topic");
        git(
            &["checkout", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("main should be restored");
        std::fs::write(repo.path().join("file.txt"), "staged\n")
            .expect("staged contents should be written");
        git(
            &["add", "file.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("staged contents should be indexed");
        std::fs::write(repo.path().join("file.txt"), "worktree\n")
            .expect("worktree contents should be written");
        let snapshot = get_checkout_snapshot(repo.path())
            .await
            .expect("checkout state should be captured");
        git(
            &["checkout", "--force", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the interrupted checkout state should be simulated");

        restore_checkout_snapshot(repo.path(), &snapshot)
            .await
            .expect("tracked checkout state should restore");

        assert_eq!(current_branch(&repo.path()).await.as_deref(), Some("main"));
        assert_eq!(
            git(
                &["show", ":file.txt"],
                repo.path(),
                "test",
                GitOptions::default(),
            )
            .await
            .expect("staged file should be readable")
            .stdout,
            b"staged\n"
        );
        assert_eq!(
            std::fs::read(repo.path().join("file.txt")).expect("worktree file should be readable"),
            b"worktree\n"
        );
        assert_eq!(
            git(
                &["status", "--porcelain", "--", "file.txt"],
                repo.path(),
                "test",
                GitOptions::default(),
            )
            .await
            .expect("status should be readable")
            .stdout_trimmed(),
            "MM file.txt"
        );
    }

    #[tokio::test]
    async fn checkout_snapshot_uses_a_binary_patch_for_tracked_binary_content() {
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("binary.dat"), [0, 1, 2, 3])
            .expect("binary fixture should be written");
        git(
            &["add", "binary.dat"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("binary fixture should be staged");
        git(
            &["commit", "-m", "binary"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("binary fixture should be committed");
        std::fs::write(repo.path().join("binary.dat"), [0, 4, 5, 6])
            .expect("binary change should be written");

        let snapshot = get_checkout_snapshot(repo.path())
            .await
            .expect("binary checkout state should be captured");

        assert!(snapshot
            .tracked_worktree_patch
            .windows(b"GIT binary patch".len())
            .any(|window| window == b"GIT binary patch"));
    }

    #[tokio::test]
    async fn checks_out_an_existing_branch() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        git(
            &["branch", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        checkout_branch(repo.path(), CheckoutTarget::Local("topic"))
            .await
            .expect("checkout should succeed");

        assert_eq!(current_branch(&repo.path()).await.as_deref(), Some("topic"));
    }

    #[tokio::test]
    async fn fails_for_an_invalid_branch_name() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let error = checkout_branch(repo.path(), CheckoutTarget::Local(".."))
            .await
            .expect_err("'..' is not a valid branch name");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn creates_a_local_branch_from_a_remote_one() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        let tip = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        // A remote-tracking ref, without needing a real remote to fetch from.
        git(
            &["update-ref", "refs/remotes/origin/topic", &tip],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("update-ref should succeed");

        checkout_branch(
            repo.path(),
            CheckoutTarget::Remote {
                remote_ref: "origin/topic",
                local_name: "topic",
            },
        )
        .await
        .expect("checkout should succeed");

        assert_eq!(current_branch(&repo.path()).await.as_deref(), Some("topic"));
    }

    #[tokio::test]
    async fn fails_when_the_local_branch_already_exists() {
        // The original had this case: git refuses rather than repointing an existing branch, and the
        // app depends on the failure to prompt the user.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        let tip = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        git(
            &["update-ref", "refs/remotes/origin/topic", &tip],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("update-ref should succeed");
        git(
            &["branch", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        let error = checkout_branch(
            repo.path(),
            CheckoutTarget::Remote {
                remote_ref: "origin/topic",
                local_name: "topic",
            },
        )
        .await
        .expect_err("creating a branch that already exists should fail");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn checks_out_a_commit_and_detaches_head() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "first\n", "first");
        let first = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        commit_file(&repo.path(), "foo", "second\n", "second");

        checkout_commit(repo.path(), &first)
            .await
            .expect("checkout should succeed");

        assert_eq!(
            current_branch(&repo.path()).await,
            None,
            "checking out a commit detaches HEAD"
        );
        let contents =
            std::fs::read_to_string(repo.path().join("foo")).expect("failed to read back");
        assert_eq!(contents, "first\n");
    }

    #[tokio::test]
    async fn restores_paths_from_head() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "committed\n", "first");
        std::fs::write(repo.path().join("foo"), "scribbled\n").expect("failed to write");

        checkout_paths(repo.path(), &["foo"])
            .await
            .expect("checkout should succeed");

        let contents =
            std::fs::read_to_string(repo.path().join("foo")).expect("failed to read back");
        assert_eq!(contents, "committed\n");
    }

    #[tokio::test]
    async fn restoring_no_paths_is_a_noop() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "committed\n", "first");
        std::fs::write(repo.path().join("foo"), "scribbled\n").expect("failed to write");

        let empty: [&str; 0] = [];
        checkout_paths(repo.path(), &empty)
            .await
            .expect("an empty pathspec should not run git at all");

        let contents =
            std::fs::read_to_string(repo.path().join("foo")).expect("failed to read back");
        assert_eq!(
            contents, "scribbled\n",
            "an empty list must not be treated as 'everything'"
        );
    }

    #[tokio::test]
    async fn checks_out_our_side_of_a_conflict() {
        let repo = conflicted_repository().await;

        checkout_conflicted_file(repo.path(), "foo", ManualConflictResolution::Ours)
            .await
            .expect("checkout --ours should succeed");

        let contents =
            std::fs::read_to_string(repo.path().join("foo")).expect("failed to read back");
        assert!(
            !contents.contains("<<<<<<<"),
            "picking a side removes the markers, got {contents:?}"
        );
    }

    #[tokio::test]
    async fn checks_out_their_side_of_a_conflict() {
        let repo = conflicted_repository().await;

        let ours = std::fs::read_to_string(repo.path().join("foo")).expect("failed to read");
        checkout_conflicted_file(repo.path(), "foo", ManualConflictResolution::Theirs)
            .await
            .expect("checkout --theirs should succeed");
        let theirs = std::fs::read_to_string(repo.path().join("foo")).expect("failed to read back");

        assert_ne!(ours, theirs, "the two sides should differ");
        assert!(!theirs.contains("<<<<<<<"));
    }

    #[tokio::test]
    async fn the_checkout_step_stops_at_ninety_percent_leaving_the_rest_to_submodules() {
        // The split the original had and this port previously flattened: the checkout itself is the
        // first 90%, the submodule update the last 10%. Without it a checkout that does have submodules
        // would jump straight from mid-checkout to done.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        git(
            &["branch", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        let mut values: Vec<f64> = Vec::new();
        checkout_branch_with_progress(
            repo.path(),
            CheckoutTarget::Local("topic"),
            |progress: CheckoutProgress| values.push(progress.value),
        )
        .await
        .expect("checkout should succeed");

        assert!(values.len() >= 2, "got {values:?}");
        assert_eq!(values[0], 0.0, "starts at zero");
        assert_eq!(
            values.last().copied(),
            Some(1.0),
            "and finishes at one: {values:?}"
        );
        assert!(
            values.contains(&CHECKOUT_STEP_WEIGHT),
            "the checkout step should be marked complete at {CHECKOUT_STEP_WEIGHT}: {values:?}"
        );

        for pair in values.windows(2) {
            assert!(pair[1] >= pair[0], "progress went backwards: {values:?}");
        }
    }

    #[test]
    fn resolution_values_are_the_git_flags() {
        // These strings are passed straight to git, so they can't be renamed for style.
        assert_eq!(ManualConflictResolution::Ours.as_str(), "ours");
        assert_eq!(ManualConflictResolution::Theirs.as_str(), "theirs");
        assert_eq!(
            serde_json::to_string(&ManualConflictResolution::Theirs).expect("serializes"),
            "\"theirs\"",
            "must match the ported TypeScript enum's values"
        );
    }

    #[test]
    fn parses_checkout_progress_across_arbitrary_chunk_boundaries() {
        let mut parser = CheckoutProgressParser::default();
        assert!(parser.push(b"Checking out fi").is_empty());
        assert_eq!(
            parser.push(b"les:  25% (1/4)\rChecking out files:  100% (4/4), done.\n"),
            vec![
                (0.25, "Checking out files:  25% (1/4)".to_owned()),
                (1.0, "Checking out files:  100% (4/4), done.".to_owned()),
            ]
        );
    }

    #[test]
    fn ignores_non_checkout_stderr_and_zero_totals() {
        assert_eq!(
            parse_checkout_progress_line("Switched to branch 'topic'"),
            None
        );
        assert_eq!(
            parse_checkout_progress_line("Checking out files:  0% (0/0)"),
            None
        );
    }

    #[tokio::test]
    async fn progress_checkout_always_reports_start_and_completion() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        git(
            &["branch", "topic"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");
        let mut progress = Vec::new();

        checkout_branch_with_progress(repo.path(), CheckoutTarget::Local("topic"), |event| {
            progress.push(event);
        })
        .await
        .expect("checkout should succeed");

        assert_eq!(progress.first().map(|event| event.value), Some(0.0));
        assert_eq!(progress.last().map(|event| event.value), Some(1.0));
        assert!(progress
            .iter()
            .all(|event| event.kind == CheckoutProgressKind::Checkout));
    }
}
