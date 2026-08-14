//! Creating commits.
//!
//! Ported from `desktop-plus/app/src/lib/git/commit.ts`.
//!
//! # Hooks
//!
//! [`create_commit`] takes the hook machinery and names the hooks a commit can reach itself — the list is a
//! property of the command, not of the caller, which is why `--amend` adds `post-rewrite` here rather than
//! anywhere else. See [`crate::hooks`]. Passing `None` is not a downgrade: git runs the hooks either way,
//! it just runs them with whatever environment the app happens to have.
//!
//! Terminal output from the commit invocation can be streamed through
//! [`create_commit_with_terminal_output`]. The command layer adapts that transport-neutral stream to a
//! Tauri Channel; the store and dialog that retain and display it belong to the frontend.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, git_streaming, GitOptions};
use crate::hooks::with_env::{with_hooks_env, HookSupport};
use crate::multi_operation_terminal_output::MultiOperationTerminalOutput;
use crate::reset::unstage_all;
use crate::stage::{stage_manual_conflict_resolution_with_entries, ManualResolution};
use crate::update_index::{stage_files, FileToStage};

/// The repository state that must survive a future cancellable commit runner.
///
/// Commit stages the user's selection before invoking Git, so a HEAD-only snapshot is not enough:
/// a stopped hook must not leave the real index containing a partial, app-created selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitSnapshot {
    /// `None` represents an unborn `HEAD`.
    pub head_sha: Option<String>,
    /// Exact index bytes, including partially staged entries and extensions.
    pub index: Option<Vec<u8>>,
}

/// Captures the state that a cancellable commit operation would need to restore.
pub async fn get_commit_snapshot(repository: impl AsRef<Path>) -> Result<CommitSnapshot, GitError> {
    let repository = repository.as_ref();
    let head_sha = match crate::exec::git(
        &["rev-parse", "--verify", "HEAD"],
        repository,
        "getCommitSnapshotHead",
        GitOptions::default(),
    )
    .await
    {
        Ok(output) => Some(output.stdout_trimmed()),
        Err(GitError::UnexpectedExitCode {
            kind: Some(crate::git_error_kind::GitErrorKind::InvalidObjectName),
            ..
        }) => None,
        Err(GitError::UnexpectedExitCode {
            kind: None, stderr, ..
        }) if stderr.contains("Needed a single revision") => None,
        Err(error) => return Err(error),
    };
    let git_dir = crate::rev_parse::resolve_git_dir(repository).await?;
    let index_path = git_dir.join("index");
    let index = match tokio::fs::read(&index_path).await {
        Ok(index) => Some(index),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(GitError::Spawn {
                name: "readCommitIndex".to_owned(),
                path: index_path,
                source,
            });
        }
    };
    Ok(CommitSnapshot { head_sha, index })
}

/// Restores only the index portion of a commit snapshot.
///
/// The caller must first classify the final HEAD. Restoring after HEAD advanced would discard the
/// index Git produced for a successful commit, so this helper intentionally does not inspect refs.
pub async fn restore_commit_snapshot(
    repository: impl AsRef<Path>,
    snapshot: &CommitSnapshot,
) -> Result<(), GitError> {
    let git_dir = crate::rev_parse::resolve_git_dir(repository.as_ref()).await?;
    let index_path = git_dir.join("index");
    let Some(index) = snapshot.index.as_deref() else {
        match tokio::fs::remove_file(&index_path).await {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(GitError::Spawn {
                    name: "restoreCommitIndex".to_owned(),
                    path: index_path,
                    source,
                });
            }
        }
    };
    let mut temporary = tempfile::Builder::new()
        .prefix("rdc-commit-index-")
        .tempfile_in(&git_dir)
        .map_err(|source| GitError::Spawn {
            name: "restoreCommitIndex".to_owned(),
            path: index_path.clone(),
            source,
        })?;
    temporary
        .write_all(index)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|source| GitError::Spawn {
            name: "restoreCommitIndex".to_owned(),
            path: index_path.clone(),
            source,
        })?;
    temporary
        .persist(&index_path)
        .map_err(|error| GitError::Spawn {
            name: "restoreCommitIndex".to_owned(),
            path: index_path,
            source: error.error,
        })?;
    Ok(())
}

/// Classifies a terminated commit without making a destructive guess.
pub async fn classify_commit_termination(
    repository: impl AsRef<Path>,
    snapshot: &CommitSnapshot,
) -> Result<bool, GitError> {
    let current = get_commit_snapshot(repository).await?.head_sha;
    Ok(current != snapshot.head_sha)
}

/// Options for [`create_commit`], all off by default.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOptions {
    /// Replace the previous commit instead of adding one.
    pub amend: bool,
    /// Skip the `pre-commit` and `commit-msg` hooks.
    pub no_verify: bool,
    /// Append a `Signed-off-by` trailer.
    pub sign_off: bool,
    /// Allow a commit that changes nothing.
    pub allow_empty: bool,
}

/// Creates a commit containing exactly `files`, and returns its SHA.
///
/// # The message is passed on stdin
///
/// `-F -` rather than `-m`, which is what the original did and is load-bearing: with `-m`, git
/// applies `--cleanup=strip` and silently deletes any line starting with `#`. Reading the message
/// from a file switches the default to `--cleanup=whitespace`, so a line like `# TODO` survives —
/// the original had a test pinning exactly that, and so does this module.
///
/// # The returned SHA differs from the original, deliberately
///
/// The original parsed git's summary line — `parseCommitSHA` did
/// `stdout.split(']')[0].split(' ')[1]` on output like `[main 1a2b3c4] message`. That has two
/// problems. It yields an abbreviated SHA, unlike every other SHA in the codebase; and for a
/// repository's first commit git prints `[main (root-commit) 1a2b3c4]`, so the parse returns the
/// literal string `"(root-commit)"`. Verified against real git — and the original's own test suite
/// asserted `sha === '(root-commit)'`, pinning the bug as expected behaviour rather than catching it.
///
/// This asks git instead of parsing its prose, and returns the full SHA. Recorded in
/// `MIGRATION_MAP.md` §8.
pub async fn create_commit(
    repository: impl AsRef<Path>,
    message: &str,
    files: &[FileToStage],
    options: CommitOptions,
    hooks: Option<&HookSupport>,
) -> Result<String, GitError> {
    create_commit_inner(repository, message, files, options, hooks, None).await
}

/// Creates a commit while capturing the commit process's combined stdout and stderr.
///
/// Staging and the final `rev-parse` are deliberately absent from the stream: upstream attached its
/// terminal listener only to `git commit`, which is the operation the progress dialog describes.
pub async fn create_commit_with_terminal_output(
    repository: impl AsRef<Path>,
    message: &str,
    files: &[FileToStage],
    options: CommitOptions,
    hooks: Option<&HookSupport>,
    terminal_output: &MultiOperationTerminalOutput,
) -> Result<String, GitError> {
    create_commit_inner(
        repository,
        message,
        files,
        options,
        hooks,
        Some(terminal_output.clone()),
    )
    .await
}

async fn create_commit_inner(
    repository: impl AsRef<Path>,
    message: &str,
    files: &[FileToStage],
    options: CommitOptions,
    hooks: Option<&HookSupport>,
    terminal_output: Option<MultiOperationTerminalOutput>,
) -> Result<String, GitError> {
    let repository = repository.as_ref();

    // The diffs the user acted on describe working-tree-vs-HEAD, so the commit should too. Whatever
    // was already staged is not part of what they chose.
    unstage_all(repository).await?;
    stage_files(repository, files).await?;

    let mut args = vec!["commit", "-F", "-"];
    if options.amend {
        args.push("--amend");
    }
    if options.no_verify {
        args.push("--no-verify");
    }
    if options.sign_off {
        args.push("--signoff");
    }
    if options.allow_empty {
        args.push("--allow-empty");
    }

    // The hooks a commit can reach, from the original — which took them from
    // <https://git-scm.com/docs/githooks>. `post-rewrite` only when amending, because that is the only
    // case where a commit rewrites one. `pre-auto-gc` is here even though a user rarely writes one: a
    // stand-in for it is how a commit delayed by garbage collection can say so.
    let mut hook_names = vec![
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
    ];
    if options.amend {
        hook_names.push("post-rewrite");
    }
    hook_names.push("pre-auto-gc");

    let interception = hooks.map(|support| support.intercepting(hook_names));

    with_hooks_env(
        repository,
        interception.as_ref(),
        HashMap::new(),
        |env| async move {
            let mut git_options = GitOptions::default().with_stdin(message);
            for (name, value) in env {
                git_options = git_options.with_env(name, value);
            }

            if let Some(terminal_output) = terminal_output {
                let stdout = terminal_output.clone();
                git_streaming(
                    &args,
                    repository,
                    "createCommit",
                    git_options,
                    move |chunk| stdout.push(chunk),
                    move |chunk| terminal_output.push(chunk),
                )
                .await
            } else {
                git(&args, repository, "createCommit", git_options).await
            }
        },
    )
    .await??;

    resolve_head(repository).await
}

/// Creates the commit that concludes an in-progress merge, and returns its SHA.
///
/// Assumes conflicts are already resolved. **Does not clear the index first** — unlike
/// [`create_commit`] — because a merge's staged state is what git built during the merge, and
/// discarding it would throw away the resolution.
///
/// `manual_resolutions` maps a path to the side the user picked; those files are staged through
/// [`crate::stage::stage_manual_conflict_resolution`] before the rest.
pub async fn create_merge_commit(
    repository: impl AsRef<Path>,
    files: &[FileToStage],
    manual_resolutions: &[ManualResolution],
) -> Result<String, GitError> {
    let repository = repository.as_ref();

    for manual in manual_resolutions {
        // The original logged and skipped when a resolution named a file that wasn't in the list.
        // Here the caller passes resolutions for paths it also passes as files, so an unmatched
        // resolution is still applied by path rather than silently dropped.
        //
        // `entries` is passed through, which is what lets a side that deleted the file resolve to a
        // deletion. Without them this took the content-only path, and a modify/delete resolved in
        // favour of the deleting side failed outright — see the note in `stage::ManualResolution`.
        stage_manual_conflict_resolution_with_entries(
            repository,
            &manual.path,
            manual.resolution,
            manual.entries,
        )
        .await?;
    }

    let resolved: Vec<FileToStage> = files
        .iter()
        .filter(|file| {
            !manual_resolutions
                .iter()
                .any(|manual| manual.path == file.path)
        })
        .cloned()
        .collect();

    stage_files(repository, &resolved).await?;

    git(
        &[
            "commit",
            // Without this git would open the user's editor, which an app must never do.
            "--no-edit",
            // And this is the consequence of `--no-edit`. git's cleanup default is "strip if the
            // message will be edited, otherwise whitespace" — so suppressing the editor also
            // suppresses comment stripping, and the merge message git generates is full of `#`
            // commentary that would end up in the commit. Asking for `strip` explicitly restores
            // what the user would have got had they edited it themselves.
            "--cleanup=strip",
        ],
        repository,
        "createMergeCommit",
        GitOptions::default(),
    )
    .await?;

    resolve_head(repository).await
}

/// The full SHA that `HEAD` now points at.
async fn resolve_head(repository: impl AsRef<Path>) -> Result<String, GitError> {
    Ok(git(
        &["rev-parse", "HEAD"],
        repository,
        "createCommit",
        GitOptions::default(),
    )
    .await?
    .stdout_trimmed())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::stage::ManualConflictResolution;
    use crate::status::get_status;
    use crate::status_parser::GitStatusEntry;
    use crate::test_support::{
        commit_file, conflicted_repository, delete_modify_conflicted_repository, empty_repository,
    };

    /// The subject and body of a commit, as git formats them.
    async fn commit_message(repo: &Path, revision: &str) -> (String, String) {
        let subject = git(
            &["log", "-1", "--format=%s", revision],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_trimmed();

        let body = git(
            &["log", "-1", "--format=%b", revision],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_lossy()
        .into_owned();

        // `--format` terminates its output with a newline of its own, on top of the one the body
        // already ends with. Strip exactly that one so the value matches the body as stored.
        let body = body.strip_suffix('\n').unwrap_or(&body).to_owned();

        (subject, body)
    }

    async fn commit_count(repo: &Path) -> usize {
        git(
            &["rev-list", "--count", "HEAD"],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-list should succeed")
        .stdout_trimmed()
        .parse()
        .expect("a count")
    }

    #[tokio::test]
    async fn commit_snapshot_restores_a_partial_index_when_head_is_unchanged() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README.md", "initial\n", "initial");
        std::fs::write(repo.path().join("README.md"), "changed\n").expect("write should succeed");
        let snapshot = get_commit_snapshot(repo.path())
            .await
            .expect("snapshot should succeed");
        let original_index = snapshot.index.clone().expect("initial index should exist");

        stage_files(repo.path(), &[FileToStage::new("README.md")])
            .await
            .expect("staging should succeed");
        assert!(!classify_commit_termination(repo.path(), &snapshot)
            .await
            .expect("classification should succeed"));

        restore_commit_snapshot(repo.path(), &snapshot)
            .await
            .expect("index restoration should succeed");
        let restored = get_commit_snapshot(repo.path())
            .await
            .expect("snapshot should succeed")
            .index
            .expect("restored index should exist");
        assert_eq!(restored, original_index);
    }

    #[tokio::test]
    async fn commit_snapshot_classifies_an_advanced_head_as_completed() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README.md", "initial\n", "initial");
        let snapshot = get_commit_snapshot(repo.path())
            .await
            .expect("snapshot should succeed");
        std::fs::write(repo.path().join("README.md"), "committed\n").expect("write should succeed");
        commit_file(&repo.path(), "README.md", "committed\n", "completed");

        assert!(classify_commit_termination(repo.path(), &snapshot)
            .await
            .expect("classification should succeed"));
    }

    #[tokio::test]
    async fn commit_snapshot_supports_an_unborn_head() {
        let repo = empty_repository().await;
        let snapshot = get_commit_snapshot(repo.path())
            .await
            .expect("snapshot should succeed");
        assert_eq!(snapshot.head_sha, None);
    }

    #[tokio::test]
    async fn commits_the_given_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README.md", "Hello\n", "first");
        std::fs::write(repo.path().join("README.md"), "Hi world\n").expect("failed to write");

        let sha = create_commit(
            repo.path(),
            "Special commit",
            &[FileToStage::new("README.md")],
            CommitOptions::default(),
            None,
        )
        .await
        .expect("committing should succeed");

        assert_eq!(
            sha.len(),
            40,
            "the port returns a full SHA, not git's abbreviation"
        );
        assert_eq!(commit_count(&repo.path()).await, 2);

        let (subject, _) = commit_message(&repo.path(), "HEAD").await;
        assert_eq!(subject, "Special commit");

        let status = get_status(repo.path(), true)
            .await
            .expect("status should succeed")
            .expect("a repository");
        assert!(
            status.files.is_empty(),
            "the working directory should be clean, got {:?}",
            status.files
        );
    }

    #[tokio::test]
    async fn streams_the_commit_process_terminal_output() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README.md", "Hello\n", "first");
        std::fs::write(repo.path().join("README.md"), "Hi world\n").expect("failed to write");

        let terminal_output = MultiOperationTerminalOutput::default();
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&chunks);
        let _subscription = terminal_output.subscribe(move |chunk| {
            received
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(chunk.to_owned());
        });

        create_commit_with_terminal_output(
            repo.path(),
            "streamed commit",
            &[FileToStage::new("README.md")],
            CommitOptions::default(),
            None,
            &terminal_output,
        )
        .await
        .expect("committing should succeed");

        let transcript = chunks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .join("");
        assert!(
            transcript.contains("streamed commit"),
            "the git commit summary should be streamed, got {transcript:?}"
        );
    }

    #[tokio::test]
    async fn does_not_strip_commentary() {
        // This is why the message goes over stdin with `-F -`. Were it passed with `-m`, git would
        // apply `--cleanup=strip` and drop the `#` line entirely.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README.md", "Hello\n", "first");
        std::fs::write(repo.path().join("README.md"), "Hi world\n").expect("failed to write");

        create_commit(
            repo.path(),
            "Special commit\n\n# this is a comment",
            &[FileToStage::new("README.md")],
            CommitOptions::default(),
            None,
        )
        .await
        .expect("committing should succeed");

        let (subject, body) = commit_message(&repo.path(), "HEAD").await;
        assert_eq!(subject, "Special commit");
        assert_eq!(body, "# this is a comment\n");
    }

    #[tokio::test]
    async fn commits_in_a_repository_with_no_commits() {
        // The original returned the string "(root-commit)" here, and asserted it. A root commit has
        // a real SHA like any other, and that's what this returns.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("foo"), "foo\n").expect("failed to write");
        std::fs::write(repo.path().join("bar"), "bar\n").expect("failed to write");

        let sha = create_commit(
            repo.path(),
            "added two files\n\nthis is a description",
            &[FileToStage::new("foo"), FileToStage::new("bar")],
            CommitOptions::default(),
            None,
        )
        .await
        .expect("committing should succeed");

        assert_eq!(sha.len(), 40, "got {sha:?}");
        assert!(
            sha.chars().all(|c| c.is_ascii_hexdigit()),
            "a root commit's SHA is a SHA like any other, got {sha:?}"
        );
        assert_eq!(commit_count(&repo.path()).await, 1);

        let (subject, body) = commit_message(&repo.path(), "HEAD").await;
        assert_eq!(subject, "added two files");
        assert_eq!(body, "this is a description\n");
    }

    #[tokio::test]
    async fn commits_a_rename() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "before", "contents\n", "first");
        std::fs::rename(repo.path().join("before"), repo.path().join("after"))
            .expect("failed to rename");

        create_commit(
            repo.path(),
            "renamed",
            &[FileToStage::renamed("after", "before")],
            CommitOptions::default(),
            None,
        )
        .await
        .expect("committing should succeed");

        let names = git(
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-status",
                "-M",
                "-r",
                "HEAD",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("diff-tree should succeed")
        .stdout_lossy()
        .into_owned();

        assert!(
            names.starts_with("R100"),
            "the commit should record a rename, got {names:?}"
        );
    }

    #[tokio::test]
    async fn amends_the_previous_commit() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        let before = commit_count(&repo.path()).await;

        std::fs::write(repo.path().join("foo"), "amended\n").expect("failed to write");
        create_commit(
            repo.path(),
            "first, amended",
            &[FileToStage::new("foo")],
            CommitOptions {
                amend: true,
                ..CommitOptions::default()
            },
            None,
        )
        .await
        .expect("amending should succeed");

        assert_eq!(
            commit_count(&repo.path()).await,
            before,
            "amending replaces the commit rather than adding one"
        );
        let (subject, _) = commit_message(&repo.path(), "HEAD").await;
        assert_eq!(subject, "first, amended");
    }

    #[tokio::test]
    async fn appends_a_sign_off_trailer() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        std::fs::write(repo.path().join("foo"), "changed\n").expect("failed to write");

        create_commit(
            repo.path(),
            "signed",
            &[FileToStage::new("foo")],
            CommitOptions {
                sign_off: true,
                ..CommitOptions::default()
            },
            None,
        )
        .await
        .expect("committing should succeed");

        let (_, body) = commit_message(&repo.path(), "HEAD").await;
        assert!(
            body.contains("Signed-off-by:"),
            "expected a sign-off trailer, got {body:?}"
        );
    }

    #[tokio::test]
    async fn creates_an_empty_commit_when_allowed() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");
        let tip_before = resolve_head(repo.path())
            .await
            .expect("HEAD should resolve");

        let sha = create_commit(
            repo.path(),
            "empty commit",
            &[],
            CommitOptions {
                allow_empty: true,
                ..CommitOptions::default()
            },
            None,
        )
        .await
        .expect("an empty commit should be allowed");

        assert_ne!(sha, tip_before, "the tip should have moved");
        let (subject, _) = commit_message(&repo.path(), "HEAD").await;
        assert_eq!(subject, "empty commit");
    }

    #[tokio::test]
    async fn refuses_an_empty_commit_by_default() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let error = create_commit(
            repo.path(),
            "should fail",
            &[],
            CommitOptions::default(),
            None,
        )
        .await
        .expect_err("committing nothing should fail");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn commits_when_a_staged_new_file_was_then_deleted() {
        // An index corner case from the original: the file was added to the index and then removed
        // from disk, so the commit should simply not contain it.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "keep", "contents\n", "first");

        std::fs::write(repo.path().join("transient"), "here\n").expect("failed to write");
        git(
            &["add", "--", "transient"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        std::fs::remove_file(repo.path().join("transient")).expect("failed to remove");

        std::fs::write(repo.path().join("keep"), "changed\n").expect("failed to write");
        create_commit(
            repo.path(),
            "only keep",
            &[FileToStage::new("keep")],
            CommitOptions::default(),
            None,
        )
        .await
        .expect("committing should succeed");

        let files = git(
            &["ls-tree", "--name-only", "-r", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("ls-tree should succeed")
        .stdout_lossy()
        .into_owned();

        assert!(
            !files.contains("transient"),
            "the deleted file should not be in the commit, got {files:?}"
        );
    }

    #[tokio::test]
    async fn creates_a_merge_commit() {
        let repo = conflicted_repository().await;
        // Resolve the conflict the way a user would.
        std::fs::write(repo.path().join("foo"), "resolved\n").expect("failed to write");

        let sha = create_merge_commit(repo.path(), &[FileToStage::new("foo")], &[])
            .await
            .expect("the merge commit should succeed");

        assert_eq!(sha.len(), 40);

        let parents = git(
            &["rev-list", "--parents", "-n", "1", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-list should succeed")
        .stdout_trimmed();

        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "a merge commit has two parents, got {parents:?}"
        );
    }

    #[tokio::test]
    async fn strips_commentary_from_a_merge_commit_message() {
        // The `--cleanup=strip` half of the `--no-edit` pairing. git's generated MERGE_MSG carries
        // `# Conflicts:` commentary that must not end up in the commit.
        let repo = conflicted_repository().await;
        std::fs::write(repo.path().join("foo"), "resolved\n").expect("failed to write");

        create_merge_commit(repo.path(), &[FileToStage::new("foo")], &[])
            .await
            .expect("the merge commit should succeed");

        let (subject, body) = commit_message(&repo.path(), "HEAD").await;
        assert!(
            !subject.contains('#') && !body.contains("# Conflicts"),
            "commentary should be stripped, got subject {subject:?} body {body:?}"
        );
    }

    #[tokio::test]
    async fn a_merge_commit_with_no_changes_fails() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let error = create_merge_commit(repo.path(), &[], &[])
            .await
            .expect_err("there is nothing to commit");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn a_merge_commit_applies_a_manual_resolution() {
        let repo = conflicted_repository().await;

        let sha = create_merge_commit(
            repo.path(),
            &[FileToStage::new("foo")],
            &[ManualResolution {
                path: "foo".to_owned(),
                resolution: ManualConflictResolution::Theirs,
                entries: Some((
                    GitStatusEntry::UpdatedButUnmerged,
                    GitStatusEntry::UpdatedButUnmerged,
                )),
            }],
        )
        .await
        .expect("the merge commit should succeed");

        assert_eq!(sha.len(), 40);

        let committed = git(
            &["show", "HEAD:foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("show should succeed")
        .stdout_lossy()
        .into_owned();

        assert!(
            !committed.contains("<<<<<<<"),
            "choosing a side must not commit conflict markers, got {committed:?}"
        );
    }

    #[tokio::test]
    async fn a_merge_commit_stages_a_chosen_deletion_as_a_deletion() {
        // The case index entries exist for. `foo` was modified here and deleted on the merged branch,
        // and the user chose the deleting side. Content alone cannot express that: `checkout --theirs`
        // fails with "does not have their version", so before the entries were passed through this
        // could not be committed at all rather than merely being committed wrongly.
        let repo = delete_modify_conflicted_repository().await;

        let sha = create_merge_commit(
            repo.path(),
            &[FileToStage::new("foo")],
            &[ManualResolution {
                path: "foo".to_owned(),
                resolution: ManualConflictResolution::Theirs,
                entries: Some((GitStatusEntry::UpdatedButUnmerged, GitStatusEntry::Deleted)),
            }],
        )
        .await
        .expect("the merge commit should succeed");

        assert_eq!(sha.len(), 40);

        // git as the oracle: the tree the commit points at must not contain the file.
        let tree = git(
            &["ls-tree", "--name-only", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("ls-tree should succeed")
        .stdout_lossy()
        .into_owned();

        assert!(
            !tree.lines().any(|line| line == "foo"),
            "the file the user chose to delete should not be in the commit, got {tree:?}"
        );
    }
}
