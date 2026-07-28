//! Creating commits.
//!
//! Ported from `desktop-plus/app/src/lib/git/commit.ts`.
//!
//! # Deferred: hook interception
//!
//! The original passed `interceptHooks: ['pre-commit', 'prepare-commit-msg', …]` along with
//! `onHookProgress`/`onHookFailure`/`onTerminalOutputAvailable` callbacks, so the UI could show hook
//! output as it streamed. That maps to a Tauri **Channel**, not to these functions' return values —
//! see `MIGRATION_MAP.md` §9. Commits work without it; hook *output* is what's missing, not hook
//! *execution*, since git runs the hooks either way.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::reset::unstage_all;
use crate::update_index::{stage_files, FileToStage};

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

    git(
        &args,
        repository,
        "createCommit",
        GitOptions::default().with_stdin(message),
    )
    .await?;

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
    manual_resolutions: &[(String, crate::stage::ManualConflictResolution)],
) -> Result<String, GitError> {
    let repository = repository.as_ref();

    for (path, resolution) in manual_resolutions {
        // The original logged and skipped when a resolution named a file that wasn't in the list.
        // Here the caller passes resolutions for paths it also passes as files, so an unmatched
        // resolution is still applied by path rather than silently dropped.
        crate::stage::stage_manual_conflict_resolution(repository, path, *resolution).await?;
    }

    let resolved: Vec<FileToStage> = files
        .iter()
        .filter(|file| {
            !manual_resolutions
                .iter()
                .any(|(path, _)| *path == file.path)
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
    use super::*;
    use crate::stage::ManualConflictResolution;
    use crate::status::get_status;
    use crate::test_support::{commit_file, conflicted_repository, empty_repository};

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
    async fn commits_the_given_files() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "README.md", "Hello\n", "first");
        std::fs::write(repo.path().join("README.md"), "Hi world\n").expect("failed to write");

        let sha = create_commit(
            repo.path(),
            "Special commit",
            &[FileToStage::new("README.md")],
            CommitOptions::default(),
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

        let error = create_commit(repo.path(), "should fail", &[], CommitOptions::default())
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
            &[("foo".to_owned(), ManualConflictResolution::Theirs)],
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
}
