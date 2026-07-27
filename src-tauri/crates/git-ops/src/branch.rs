//! Branch creation, renaming, deletion and enumeration.
//!
//! Ported from `desktop-plus/app/src/lib/git/branch.ts`.
//!
//! `deleteRemoteBranch` is **not** ported yet: it pushes a deletion, which needs
//! `envForRemoteOperation` — i.e. `envForAuthentication` (the trampoline/askpass credential
//! helper) and `envForProxy`. Both are outstanding, so it lands with the credential work.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_delimiter_parser::ForEachRefParser;
use crate::git_error_kind::GitErrorKind;
use crate::refs::format_as_local_ref;

/// Creates a branch at `start_point`, or at HEAD when `start_point` is `None`.
///
/// `no_track` suppresses upstream tracking. It matters when branching directly from a remote
/// branch: without it git would set that remote branch as the upstream, which makes the rest of
/// the app treat it as the push target — likely the upstream of a fork rather than the user's own.
pub async fn create_branch(
    repository: impl AsRef<Path>,
    name: &str,
    start_point: Option<&str>,
    no_track: bool,
) -> Result<(), GitError> {
    let mut args = vec!["branch".to_owned(), name.to_owned()];
    if let Some(start_point) = start_point {
        args.push(start_point.to_owned());
    }
    if no_track {
        args.push("--no-track".to_owned());
    }

    git(&args, repository, "createBranch", GitOptions::default()).await?;

    Ok(())
}

/// Lists local branch names, shortest form.
pub async fn get_branch_names(repository: impl AsRef<Path>) -> Result<Vec<String>, GitError> {
    let parser = ForEachRefParser::new(&["%(refname:short)"]);
    let mut args = vec!["branch".to_owned()];
    args.extend(parser.format_args());

    let output = git(&args, repository, "getBranchNames", GitOptions::default()).await?;

    Ok(parser
        .parse(&output.stdout_lossy())?
        .into_iter()
        .filter_map(|mut fields| {
            // Exactly one field was requested, so each record has one value.
            (!fields.is_empty()).then(|| fields.swap_remove(0))
        })
        .collect())
}

/// Renames a branch.
///
/// `force` maps to `-M` instead of `-m`. When `force` is `None` and git rejects the rename because
/// the target already exists, this retries with `-M` **only** if the collision is a case-only
/// rename — see [`is_case_only_rename`].
pub async fn rename_branch(
    repository: impl AsRef<Path>,
    current_name: &str,
    new_name: &str,
    force: Option<bool>,
) -> Result<(), GitError> {
    let repository = repository.as_ref();
    let flag = if force.unwrap_or(false) { "-M" } else { "-m" };

    let result = git(
        &["branch", flag, current_name, new_name],
        repository,
        "renameBranch",
        GitOptions::default(),
    )
    .await;

    let error = match result {
        Ok(_) => return Ok(()),
        Err(error) => error,
    };

    // Only consider a retry if the caller didn't already express an intent about forcing.
    if force.is_some() {
        return Err(error);
    }

    // Copy what's needed out of the error so it can still be returned unchanged below.
    let (kind, stderr) = match &error {
        GitError::UnexpectedExitCode { kind, stderr, .. } => (*kind, stderr.clone()),
        _ => return Err(error),
    };

    if kind != Some(GitErrorKind::BranchAlreadyExists) {
        return Err(error);
    }

    if !is_case_only_rename(&stderr, new_name) {
        return Err(error);
    }

    // Almost certainly a case-only rename on a case-insensitive filesystem — but not certainly:
    // NTFS can be configured case-sensitive, and macOS can mount case-sensitive volumes. So
    // confirm the target genuinely doesn't exist before forcing.
    //
    // If listing branches fails, report the original rename failure rather than the listing one:
    // that's the error the caller actually needs.
    let Ok(names) = get_branch_names(repository).await else {
        return Err(error);
    };
    // Compare exactly: a *different* branch already using the new name means this isn't a
    // case-only rename and forcing would clobber it.
    if names.iter().any(|existing| existing == new_name) {
        return Err(error);
    }

    Box::pin(rename_branch(
        repository,
        current_name,
        new_name,
        Some(true),
    ))
    .await
}

/// Whether git's rejection names a branch that differs from `new_name` only by case.
fn is_case_only_rename(stderr: &str, new_name: &str) -> bool {
    already_exists_pattern()
        .captures(stderr)
        .and_then(|c| c.get(1))
        .is_some_and(|existing| existing.as_str().eq_ignore_ascii_case(new_name))
}

fn already_exists_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"fatal: a branch named '(.+?)' already exists").expect("pattern is valid")
    })
}

/// Deletes a local branch, discarding unmerged commits (`-D`).
pub async fn delete_local_branch(
    repository: impl AsRef<Path>,
    branch_name: &str,
) -> Result<(), GitError> {
    git(
        &["branch", "-D", branch_name],
        repository,
        "deleteLocalBranch",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

/// Branch names whose tip is `committish`, or `None` if it couldn't be resolved.
pub async fn get_branches_pointed_at(
    repository: impl AsRef<Path>,
    committish: &str,
) -> Result<Option<Vec<String>>, GitError> {
    let output = git(
        &[
            "branch".to_owned(),
            format!("--points-at={committish}"),
            "--format=%(refname:short)".to_owned(),
        ],
        repository,
        "branchPointedAt",
        // 1: no common ancestor could be resolved. 129: the ref is malformed.
        GitOptions::default().with_success_exit_codes([1, 129]),
    )
    .await?;

    if output.exit_code == 1 || output.exit_code == 129 {
        return Ok(None);
    }

    // This format is newline-delimited, with a trailing newline after the last entry.
    Ok(Some(
        output
            .stdout_lossy()
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect(),
    ))
}

/// Branches merged into `branch_name`, as canonical ref → tip SHA.
///
/// `branch_name` itself is excluded — it is trivially merged into itself and including it would
/// make callers filter it out every time.
pub async fn get_merged_branches(
    repository: impl AsRef<Path>,
    branch_name: &str,
) -> Result<HashMap<String, String>, GitError> {
    let canonical_branch_ref = format_as_local_ref(branch_name);
    let parser = ForEachRefParser::new(&["%(objectname)", "%(refname)"]);

    let mut args = vec!["branch".to_owned()];
    args.extend(parser.format_args());
    args.push("--merged".to_owned());
    args.push(branch_name.to_owned());

    let output = git(&args, repository, "mergedBranches", GitOptions::default()).await?;

    let mut merged = HashMap::new();
    for fields in parser.parse(&output.stdout_lossy())? {
        let [sha, canonical_ref] = fields.as_slice() else {
            return Err(GitError::Parse {
                context: "mergedBranches".to_owned(),
                message: format!("expected 2 fields per record, got {}", fields.len()),
            });
        };
        if canonical_ref != &canonical_branch_ref {
            merged.insert(canonical_ref.clone(), sha.clone());
        }
    }

    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, fixture_repository};

    /// A repository with one commit on `main`.
    async fn repo_with_commit() -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");
        repo
    }

    async fn head_sha(repo: &Path) -> String {
        git(&["rev-parse", "HEAD"], repo, "test", GitOptions::default())
            .await
            .expect("rev-parse should succeed")
            .stdout_trimmed()
    }

    // --- createBranch / getBranchNames ---

    #[tokio::test]
    async fn creates_a_branch_at_head() {
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "feature", None, false)
            .await
            .expect("creating a branch should succeed");

        let names = get_branch_names(repo.path())
            .await
            .expect("listing should succeed");
        assert!(names.contains(&"feature".to_owned()), "got {names:?}");
    }

    #[tokio::test]
    async fn creates_a_branch_at_a_start_point() {
        let repo = repo_with_commit().await;
        let first = head_sha(&repo.path()).await;
        commit_file(&repo.path(), "foo", "second contents", "second");

        create_branch(repo.path(), "from-first", Some(&first), false)
            .await
            .expect("creating a branch should succeed");

        let tip = git(
            &["rev-parse", "from-first"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();
        assert_eq!(tip, first, "the branch should point at its start point");
    }

    #[tokio::test]
    async fn no_track_suppresses_upstream_tracking() {
        let repo = repo_with_commit().await;
        let head = head_sha(&repo.path()).await;
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
            &["update-ref", "refs/remotes/origin/upstream-branch", &head],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("update-ref should succeed");

        create_branch(
            repo.path(),
            "tracked",
            Some("origin/upstream-branch"),
            false,
        )
        .await
        .expect("creating should succeed");
        create_branch(
            repo.path(),
            "untracked",
            Some("origin/upstream-branch"),
            true,
        )
        .await
        .expect("creating should succeed");

        let tracked = crate::config::get_config_value(repo.path(), "branch.tracked.remote", true)
            .await
            .expect("config read should succeed");
        let untracked =
            crate::config::get_config_value(repo.path(), "branch.untracked.remote", true)
                .await
                .expect("config read should succeed");

        assert_eq!(
            tracked.as_deref(),
            Some("origin"),
            "should track by default"
        );
        assert_eq!(untracked, None, "--no-track should leave no upstream");
    }

    #[tokio::test]
    async fn lists_every_local_branch() {
        let repo = repo_with_commit().await;
        for name in ["alpha", "beta", "feature/nested"] {
            create_branch(repo.path(), name, None, false)
                .await
                .expect("creating should succeed");
        }

        let mut names = get_branch_names(repo.path())
            .await
            .expect("listing should succeed");
        names.sort();
        assert_eq!(names, ["alpha", "beta", "feature/nested", "main"]);
    }

    // --- renameBranch ---

    #[tokio::test]
    async fn renames_a_branch() {
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "before", None, false)
            .await
            .expect("creating should succeed");

        rename_branch(repo.path(), "before", "after", None)
            .await
            .expect("renaming should succeed");

        let names = get_branch_names(repo.path())
            .await
            .expect("listing should succeed");
        assert!(names.contains(&"after".to_owned()), "got {names:?}");
        assert!(!names.contains(&"before".to_owned()), "got {names:?}");
    }

    #[tokio::test]
    async fn renames_a_branch_differing_only_by_case() {
        // The retry path, which the original code has but the original tests never covered. On a
        // case-insensitive filesystem git rejects this with BranchAlreadyExists and the retry with
        // -M is what makes it work; on a case-sensitive one it succeeds outright. Either way the
        // observable outcome must be the same, so this test is platform-independent.
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "casetest", None, false)
            .await
            .expect("creating should succeed");

        rename_branch(repo.path(), "casetest", "CaseTest", None)
            .await
            .expect("a case-only rename should succeed on either filesystem");

        let names = get_branch_names(repo.path())
            .await
            .expect("listing should succeed");
        assert!(names.contains(&"CaseTest".to_owned()), "got {names:?}");
        assert!(!names.contains(&"casetest".to_owned()), "got {names:?}");
    }

    #[tokio::test]
    async fn refuses_to_rename_over_a_different_existing_branch() {
        // The guard on the retry: the target exists and is *not* a case variant, so forcing would
        // destroy it. The original error must propagate.
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "source", None, false)
            .await
            .expect("creating should succeed");
        create_branch(repo.path(), "occupied", None, false)
            .await
            .expect("creating should succeed");

        let error = rename_branch(repo.path(), "source", "occupied", None)
            .await
            .expect_err("renaming onto an existing branch should fail");
        assert!(
            matches!(
                error,
                GitError::UnexpectedExitCode {
                    kind: Some(GitErrorKind::BranchAlreadyExists),
                    ..
                }
            ),
            "got {error:?}"
        );

        // Both branches must survive.
        let names = get_branch_names(repo.path())
            .await
            .expect("listing should succeed");
        assert!(names.contains(&"source".to_owned()), "got {names:?}");
        assert!(names.contains(&"occupied".to_owned()), "got {names:?}");
    }

    #[test]
    fn recognizes_a_case_only_collision() {
        let stderr = "fatal: a branch named 'CaseTest' already exists\n";
        assert!(is_case_only_rename(stderr, "casetest"));
        assert!(is_case_only_rename(stderr, "CASETEST"));
    }

    #[test]
    fn does_not_treat_a_different_name_as_a_case_only_collision() {
        let stderr = "fatal: a branch named 'occupied' already exists\n";
        assert!(!is_case_only_rename(stderr, "source"));
    }

    #[test]
    fn does_not_treat_unrelated_stderr_as_a_collision() {
        assert!(!is_case_only_rename(
            "fatal: something else entirely",
            "foo"
        ));
    }

    // --- deleteLocalBranch ---

    #[tokio::test]
    async fn deletes_a_local_branch() {
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "doomed", None, false)
            .await
            .expect("creating should succeed");

        delete_local_branch(repo.path(), "doomed")
            .await
            .expect("deleting should succeed");

        let names = get_branch_names(repo.path())
            .await
            .expect("listing should succeed");
        assert!(!names.contains(&"doomed".to_owned()), "got {names:?}");
    }

    #[tokio::test]
    async fn deleting_a_missing_branch_fails() {
        let repo = repo_with_commit().await;
        let error = delete_local_branch(repo.path(), "never-existed")
            .await
            .expect_err("deleting a missing branch should fail");
        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "got {error:?}"
        );
    }

    // --- getBranchesPointedAt ---

    #[tokio::test]
    async fn finds_one_branch_pointing_at_head() {
        let repo = fixture_repository("test-repo").await;
        let branches = get_branches_pointed_at(repo.path(), "HEAD")
            .await
            .expect("should not error")
            .expect("HEAD resolves, so this should be Some");
        assert_eq!(branches, ["master"]);
    }

    #[tokio::test]
    async fn finds_multiple_branches_pointing_at_the_same_commit() {
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "alias", None, false)
            .await
            .expect("creating should succeed");

        let mut branches = get_branches_pointed_at(repo.path(), "HEAD")
            .await
            .expect("should not error")
            .expect("HEAD resolves, so this should be Some");
        branches.sort();
        assert_eq!(branches, ["alias", "main"]);
    }

    #[tokio::test]
    async fn finds_no_branches_for_a_commit_without_any() {
        let repo = repo_with_commit().await;
        let first = head_sha(&repo.path()).await;
        commit_file(&repo.path(), "foo", "second", "second");

        // The first commit has no branch tip pointing at it any more.
        let branches = get_branches_pointed_at(repo.path(), &first)
            .await
            .expect("should not error")
            .expect("a valid committish should be Some");
        assert!(branches.is_empty(), "got {branches:?}");
    }

    #[tokio::test]
    async fn returns_none_for_a_malformed_committish() {
        let repo = repo_with_commit().await;
        assert_eq!(
            get_branches_pointed_at(repo.path(), "no-such-thing")
                .await
                .expect("a malformed committish is not an error"),
            None
        );
    }

    // --- getMergedBranches ---

    #[tokio::test]
    async fn lists_branches_merged_into_the_given_branch() {
        let repo = repo_with_commit().await;
        // `merged` points at the same commit as main, so it counts as merged.
        create_branch(repo.path(), "merged", None, false)
            .await
            .expect("creating should succeed");
        // `ahead` has its own commit, so it is not merged into main.
        create_branch(repo.path(), "ahead", None, false)
            .await
            .expect("creating should succeed");
        git(
            &["checkout", "ahead"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");
        commit_file(&repo.path(), "bar", "contents", "on ahead");
        git(
            &["checkout", "main"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("checkout should succeed");

        let merged = get_merged_branches(repo.path(), "main")
            .await
            .expect("should not error");

        assert!(
            merged.contains_key("refs/heads/merged"),
            "expected refs/heads/merged, got {merged:?}"
        );
        assert!(
            !merged.contains_key("refs/heads/ahead"),
            "a branch with its own commits is not merged: {merged:?}"
        );
        assert!(
            !merged.contains_key("refs/heads/main"),
            "the base branch must be excluded: {merged:?}"
        );
    }

    #[tokio::test]
    async fn maps_merged_branches_to_their_tip_sha() {
        let repo = repo_with_commit().await;
        create_branch(repo.path(), "merged", None, false)
            .await
            .expect("creating should succeed");
        let head = head_sha(&repo.path()).await;

        let merged = get_merged_branches(repo.path(), "main")
            .await
            .expect("should not error");
        assert_eq!(merged.get("refs/heads/merged"), Some(&head));
    }
}
