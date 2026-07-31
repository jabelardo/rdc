//! Listing branches with `git for-each-ref`.
//!
//! Ported from `desktop-plus/app/src/lib/git/for-each-ref.ts`.
//!
//! This is the module that produces the branch list itself — the local and remote branches, their
//! tips, and what each one tracks. [`crate::branch`] is the other half of upstream's split: it
//! *operates* on branches (create, rename, delete) and answers narrow questions, while everything
//! here answers "what branches are there?".
//!
//! # The wire carries constructor arguments
//!
//! `Branch` in `src/models/branch.ts` is a class with derived getters — `upstreamRemoteName`,
//! `remoteName`, `nameWithoutRemote` — so a JSON object is not assignable to it however well the
//! fields line up. [`Branch`] therefore mirrors the *constructor parameters* and the frontend builds
//! the class, exactly as `Commit` and `DiffHunk` do. Sending the derived names instead would be a
//! second implementation of rules that already exist in TypeScript.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_delimiter_parser::ForEachRefParser;
use crate::git_error_kind::GitErrorKind;

/// Whether a branch is local or lives on a remote.
///
/// A **numeric** enum in TypeScript, like [`crate::diff_index::IndexStatus`], and its values are load
/// bearing: `src/models/branch.ts` notes they're used to sort local branches ahead of remote ones. So
/// it serializes as its discriminant, not its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchType {
    Local = 0,
    Remote = 1,
}

impl Serialize for BranchType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for BranchType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(Self::Local),
            1 => Ok(Self::Remote),
            other => Err(serde::de::Error::custom(format!(
                "unknown BranchType discriminant: {other}"
            ))),
        }
    }
}

/// Who wrote a branch tip's commit, as far as the branch list cares.
///
/// Only the date, which is what the UI sorts and groups by. Mirrors `IAuthor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchAuthor {
    /// Epoch seconds, per the crate-wide convention — the TypeScript side builds the `Date`.
    pub date: i64,
}

/// The commit a branch points at. Mirrors `IBranchTip`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchTip {
    pub sha: String,
    pub author: BranchAuthor,
}

/// A branch, as the arguments `Branch`'s constructor takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name, e.g. `main` for a local branch or `origin/main` for a remote one.
    pub name: String,

    /// The remote-prefixed upstream name, e.g. `origin/main`, or `None` when nothing is tracked.
    ///
    /// Serialized as an explicit `null` rather than omitted, because the TypeScript field is
    /// `string | null`.
    pub upstream: Option<String>,

    pub tip: BranchTip,

    /// `type` is a Rust keyword, so the field is renamed on the way out.
    #[serde(rename = "type")]
    pub branch_type: BranchType,

    /// The canonical ref, e.g. `refs/heads/main`. `ref` is also a keyword.
    #[serde(rename = "ref")]
    pub canonical_ref: String,

    /// Whether the upstream this branch tracks has been deleted.
    pub is_gone: bool,
}

/// A local branch and the upstream it differs from. Mirrors `ITrackingBranch`.
///
/// The pair `(upstream_ref, canonical_ref)` is what
/// [`fast_forward_branches`](crate::fetch::fast_forward_branches) consumes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingBranch {
    #[serde(rename = "ref")]
    pub canonical_ref: String,
    pub sha: String,
    pub upstream_ref: String,
    pub upstream_sha: String,
}

/// The ref namespaces a branch listing covers when the caller doesn't narrow it.
const DEFAULT_PREFIXES: [&str; 2] = ["refs/heads", "refs/remotes"];

/// git's two spellings of a deleted upstream, from `%(upstream:track)`.
///
/// Both are accepted because the original accepted both; the square-bracket form is what current git
/// prints.
const GONE_MARKERS: [&str; 2] = ["[gone]", "(gone)"];

/// Lists branches, in the order git reports them (alphabetical by ref).
///
/// `prefixes` narrows the ref namespaces searched; empty means [`DEFAULT_PREFIXES`].
///
/// A path that isn't a repository yields an **empty list rather than an error**, matching the original
/// and [`crate::remote::get_remotes`]: the caller is asking what branches exist, and somewhere that
/// isn't a repository has none.
///
/// **Symbolic refs are skipped.** `refs/remotes/origin/HEAD` is a pointer at another branch rather than
/// a branch of its own, so including it would list the remote's default branch twice.
pub async fn get_branches(
    repository: impl AsRef<Path>,
    prefixes: &[String],
) -> Result<Vec<Branch>, GitError> {
    // Field order here is the order values come back in.
    let parser = ForEachRefParser::new(&[
        "%(refname)",
        "%(refname:short)",
        "%(upstream:short)",
        "%(upstream:track)",
        "%(objectname)",
        "%(symref)",
        // The original asked for `iso8601` and handed the string to `new Date()`. That format is
        // space-separated (`2021-01-22 11:45:28 +0100`), which is *not* a format the ECMAScript spec
        // requires an engine to parse — it worked because V8 accepts it. Asking git for epoch seconds
        // instead removes the parse entirely and matches how every other timestamp crosses this
        // boundary.
        "%(authordate:unix)",
    ]);

    let mut args = vec!["for-each-ref".to_owned()];
    args.extend(parser.format_args());
    args.extend(if prefixes.is_empty() {
        DEFAULT_PREFIXES.iter().map(|p| (*p).to_owned()).collect()
    } else {
        prefixes.to_vec()
    });

    let output = git(
        &args,
        repository,
        "getBranches",
        GitOptions::default().with_expected_errors([GitErrorKind::NotAGitRepository]),
    )
    .await?;

    if output.git_error == Some(GitErrorKind::NotAGitRepository) {
        return Ok(Vec::new());
    }

    let mut branches = Vec::new();

    for fields in parser.parse(&output.stdout_lossy())? {
        let [full_name, short_name, upstream_short_name, upstream_tracking, sha, sym_ref, author_date] =
            fields.as_slice()
        else {
            return Err(GitError::Parse {
                context: "getBranches".to_owned(),
                message: format!("expected 7 fields per record, got {}", fields.len()),
            });
        };

        if !sym_ref.is_empty() {
            continue;
        }

        let date = author_date.parse::<i64>().map_err(|_| GitError::Parse {
            context: "getBranches".to_owned(),
            // Unreachable for a branch ref — for-each-ref skips refs whose object is missing — but the
            // original's `new Date("")` would have produced an Invalid Date and put an unrenderable
            // value in the UI, so this fails loudly instead.
            message: format!("{full_name} has an unreadable author date: {author_date:?}"),
        })?;

        branches.push(Branch {
            name: short_name.clone(),
            upstream: (!upstream_short_name.is_empty()).then(|| upstream_short_name.clone()),
            tip: BranchTip {
                sha: sha.clone(),
                author: BranchAuthor { date },
            },
            branch_type: if full_name.starts_with("refs/heads") {
                BranchType::Local
            } else {
                BranchType::Remote
            },
            canonical_ref: full_name.clone(),
            is_gone: GONE_MARKERS.contains(&upstream_tracking.as_str()),
        });
    }

    Ok(branches)
}

/// Local branches whose tip differs from their upstream's, so they could be fast-forwarded.
///
/// Excludes, and each exclusion is load bearing:
///
/// - **The current branch.** Fast-forwarding it would have to touch the working tree, which is a
///   checkout rather than a ref update.
/// - **Branches checked out in another worktree**, for the same reason — from here they can't be moved
///   safely.
/// - **Local branches with no upstream**, and any branch that already matches its upstream.
///
/// The comparison is by tip SHA rather than by `%(upstream:track)`, which is what makes it a single
/// git invocation: the ahead/behind counts would need a rev-list per branch.
pub async fn get_branches_differing_from_upstream(
    repository: impl AsRef<Path>,
) -> Result<Vec<TrackingBranch>, GitError> {
    let repository = repository.as_ref();
    let parser = ForEachRefParser::new(&[
        "%(refname)",
        "%(objectname)",
        "%(upstream)",
        "%(symref)",
        "%(HEAD)",
        "%(worktreepath)",
    ]);

    let mut args = vec!["for-each-ref".to_owned()];
    args.extend(parser.format_args());
    args.extend(DEFAULT_PREFIXES.iter().map(|p| (*p).to_owned()));

    let output = git(
        &args,
        repository,
        "getBranchesDifferingFromUpstream",
        GitOptions::default().with_expected_errors([GitErrorKind::NotAGitRepository]),
    )
    .await?;

    if output.git_error == Some(GitErrorKind::NotAGitRepository) {
        return Ok(Vec::new());
    }

    // Local branches that track something, and the tip of every remote branch, so the two can be
    // compared once everything has been read.
    let mut local_branches: Vec<(String, String, String)> = Vec::new();
    let mut remote_shas: HashMap<String, String> = HashMap::new();

    for fields in parser.parse(&output.stdout_lossy())? {
        let [full_name, sha, upstream, sym_ref, head, worktree_path] = fields.as_slice() else {
            return Err(GitError::Parse {
                context: "getBranchesDifferingFromUpstream".to_owned(),
                message: format!("expected 6 fields per record, got {}", fields.len()),
            });
        };

        if !sym_ref.is_empty() || head == "*" {
            continue;
        }

        if !worktree_path.is_empty() && !is_this_worktree(repository, worktree_path) {
            continue;
        }

        if full_name.starts_with("refs/heads") {
            if upstream.is_empty() {
                continue;
            }
            local_branches.push((full_name.clone(), sha.clone(), upstream.clone()));
        } else {
            remote_shas.insert(full_name.clone(), sha.clone());
        }
    }

    let mut eligible = Vec::new();
    for (canonical_ref, sha, upstream_ref) in local_branches {
        let Some(upstream_sha) = remote_shas.get(&upstream_ref) else {
            continue;
        };
        if *upstream_sha == sha {
            continue;
        }

        eligible.push(TrackingBranch {
            canonical_ref,
            sha,
            upstream_ref,
            upstream_sha: upstream_sha.clone(),
        });
    }

    Ok(eligible)
}

/// Whether `worktree_path` is the worktree this call is operating on.
///
/// The original compared the two strings. That is fragile: git prints a fully resolved path, so on a
/// macOS temp directory (`/var` symlinked to `/private/var`) — or anywhere the caller's path reaches
/// the repository through a symlink — the comparison fails and a branch checked out *here* looks like
/// it belongs to another worktree. Comparing canonical paths is the same test without that failure
/// mode.
///
/// Falls back to the string comparison when either path can't be resolved, so a worktree that has been
/// deleted behaves as it did before rather than erroring.
fn is_this_worktree(repository: &Path, worktree_path: &str) -> bool {
    match (
        std::fs::canonicalize(repository),
        std::fs::canonicalize(worktree_path),
    ) {
        (Ok(repository), Ok(worktree)) => repository == worktree,
        _ => repository.as_os_str() == worktree_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository, fixture_repository};

    /// The upstream fixture's three local branches, with the SHAs its own test asserts.
    const MANY_REFS_BRANCHES: [(&str, &str); 3] = [
        (
            "commit-with-long-description",
            "dfa96676b65e1c0ed43ca25492252a5e384c8efd",
        ),
        (
            "commit-with-no-body",
            "49ec1e05f39eef8d1ab6200331a028fb3dd96828",
        ),
        ("master", "b9ccfc3307240b86447bca2bd6c51a4bb4ade493"),
    ];

    // --- getBranches ---

    #[tokio::test]
    async fn lists_branches_with_their_tips() {
        let repo = fixture_repository("repo-with-many-refs").await;

        let branches = get_branches(repo.path(), &[])
            .await
            .expect("listing should succeed");
        let local: Vec<&Branch> = branches
            .iter()
            .filter(|branch| branch.branch_type == BranchType::Local)
            .collect();

        assert_eq!(local.len(), 3);
        for (branch, (name, sha)) in local.iter().zip(MANY_REFS_BRANCHES) {
            assert_eq!(branch.name, name);
            assert_eq!(branch.tip.sha, sha);
            assert_eq!(branch.upstream, None, "{name} tracks nothing");
            assert_eq!(branch.canonical_ref, format!("refs/heads/{name}"));
            assert!(!branch.is_gone);
        }
    }

    #[tokio::test]
    async fn reads_the_tip_date_as_epoch_seconds() {
        // The one field that isn't a string in git's output. Asserted against `git log` rather than a
        // literal, so the test says "the same instant git reports" rather than pinning a number.
        let repo = fixture_repository("repo-with-many-refs").await;

        let branches = get_branches(repo.path(), &["refs/heads/master".to_owned()])
            .await
            .expect("listing should succeed");

        let expected = git(
            &["log", "-1", "--format=%at", "master"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_lossy()
        .trim()
        .parse::<i64>()
        .expect("an epoch timestamp");

        assert_eq!(branches[0].tip.author.date, expected);
        assert!(expected > 0);
    }

    #[tokio::test]
    async fn narrows_to_the_given_prefixes() {
        let repo = fixture_repository("repo-with-non-updated-branches").await;

        let remotes = get_branches(repo.path(), &["refs/remotes".to_owned()])
            .await
            .expect("listing should succeed");

        assert!(!remotes.is_empty());
        assert!(
            remotes
                .iter()
                .all(|branch| branch.branch_type == BranchType::Remote),
            "only remote branches: {remotes:?}"
        );
        assert!(remotes.iter().any(|branch| branch.name == "origin/main"
            && branch.canonical_ref == "refs/remotes/origin/main"));
    }

    #[tokio::test]
    async fn records_what_a_branch_tracks() {
        let repo = fixture_repository("repo-with-non-updated-branches").await;

        let branches = get_branches(repo.path(), &[])
            .await
            .expect("listing should succeed");
        let ahead = branches
            .iter()
            .find(|branch| branch.name == "branch-ahead")
            .expect("the fixture has branch-ahead");

        assert_eq!(ahead.upstream.as_deref(), Some("origin/branch-ahead"));
        assert!(!ahead.is_gone);
    }

    #[tokio::test]
    async fn reports_a_deleted_upstream_as_gone() {
        let repo = fixture_repository("repo-with-non-updated-branches").await;
        // Delete the remote-tracking ref the branch tracks, which is what `[gone]` means.
        git(
            &["update-ref", "-d", "refs/remotes/origin/branch-ahead"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("deleting the ref should succeed");

        let branches = get_branches(repo.path(), &["refs/heads".to_owned()])
            .await
            .expect("listing should succeed");
        let ahead = branches
            .iter()
            .find(|branch| branch.name == "branch-ahead")
            .expect("the branch is still there");

        assert!(ahead.is_gone, "its upstream is gone");
        assert_eq!(
            ahead.upstream.as_deref(),
            Some("origin/branch-ahead"),
            "and it still says what it tracked, so the UI can offer to clean up"
        );
    }

    #[tokio::test]
    async fn skips_symbolic_refs() {
        // `refs/remotes/origin/HEAD` points at another branch. Listing it would show the remote's
        // default branch twice.
        let repo = fixture_repository("repo-with-non-updated-branches").await;
        git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("creating the symref should succeed");

        let branches = get_branches(repo.path(), &[])
            .await
            .expect("listing should succeed");

        assert!(
            !branches
                .iter()
                .any(|branch| branch.canonical_ref == "refs/remotes/origin/HEAD"),
            "the symref must not be listed: {branches:?}"
        );
        assert!(
            branches
                .iter()
                .any(|branch| branch.canonical_ref == "refs/remotes/origin/main"),
            "what it points at still is"
        );
    }

    #[tokio::test]
    async fn lists_nothing_in_a_repository_with_no_commits() {
        let repo = empty_repository().await;

        assert_eq!(
            get_branches(repo.path(), &[])
                .await
                .expect("listing should succeed"),
            Vec::new(),
            "an unborn HEAD is not yet a branch"
        );
    }

    #[tokio::test]
    async fn lists_nothing_outside_a_repository() {
        // Asking what branches a plain directory has is a question with an answer, not an error.
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");

        assert_eq!(
            get_branches(dir.path(), &[])
                .await
                .expect("listing should succeed"),
            Vec::new()
        );
    }

    // --- getBranchesDifferingFromUpstream ---

    #[tokio::test]
    async fn finds_the_branches_that_differ_from_their_upstream() {
        let repo = fixture_repository("repo-with-non-updated-branches").await;

        let branches = get_branches_differing_from_upstream(repo.path())
            .await
            .expect("listing should succeed");
        let refs: Vec<&str> = branches
            .iter()
            .map(|branch| branch.canonical_ref.as_str())
            .collect();

        assert_eq!(refs.len(), 3, "{refs:?}");
        // Ahead, behind and both all qualify — any of them can be examined, and the behind ones are
        // what fast-forwarding exists for.
        assert!(refs.contains(&"refs/heads/branch-behind"));
        assert!(refs.contains(&"refs/heads/branch-ahead"));
        assert!(refs.contains(&"refs/heads/branch-ahead-and-behind"));
        // `main` is checked out here.
        assert!(!refs.contains(&"refs/heads/main"));
        // And this one already matches its upstream.
        assert!(!refs.contains(&"refs/heads/branch-up-to-date"));
    }

    #[tokio::test]
    async fn pairs_each_branch_with_its_upstream_ref_and_sha() {
        // The fields exist so `fast_forward_branches` can build `<upstream>:<local>` and so the caller
        // can show what it would move to.
        let repo = fixture_repository("repo-with-non-updated-branches").await;

        let branches = get_branches_differing_from_upstream(repo.path())
            .await
            .expect("listing should succeed");
        let behind = branches
            .iter()
            .find(|branch| branch.canonical_ref == "refs/heads/branch-behind")
            .expect("branch-behind differs");

        assert_eq!(behind.upstream_ref, "refs/remotes/origin/branch-behind");
        assert_ne!(behind.sha, behind.upstream_sha);
        assert_eq!(behind.sha.len(), 40);
        assert_eq!(behind.upstream_sha.len(), 40);
    }

    #[tokio::test]
    async fn ignores_a_branch_checked_out_in_another_worktree() {
        let repo = fixture_repository("repo-with-non-updated-branches").await;
        // Its own directory, not `repo/../…`: a relative escape resolves into the shared temp
        // directory, where a leftover from another test would be found instead.
        let elsewhere = tempfile::tempdir().expect("failed to create a temporary directory");
        let linked = elsewhere.path().join("linked");
        git(
            &[
                "worktree",
                "add",
                linked.to_str().expect("a UTF-8 path"),
                "branch-behind",
            ],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("adding the worktree should succeed");

        let branches = get_branches_differing_from_upstream(repo.path())
            .await
            .expect("listing should succeed");
        let refs: Vec<&str> = branches
            .iter()
            .map(|branch| branch.canonical_ref.as_str())
            .collect();

        assert!(
            !refs.contains(&"refs/heads/branch-behind"),
            "it can't be moved from here: {refs:?}"
        );
        assert!(
            refs.contains(&"refs/heads/branch-ahead"),
            "the others are unaffected: {refs:?}"
        );
    }

    // Unix-only by construction, not by neglect: `std::os::unix::fs::symlink` has no portable
    // equivalent — Windows splits it into `symlink_file`/`symlink_dir` and creating one normally
    // needs Developer Mode or elevation, so the Windows version of this test is a Phase 10 decision
    // rather than a rename. The behaviour under test (canonicalizing before comparing worktree
    // paths) is platform-neutral and covered on every platform by the sibling tests.
    #[cfg(unix)]
    #[tokio::test]
    async fn recognizes_its_own_worktree_through_a_symlink() {
        // Why the path comparison canonicalizes. Reached through a symlink, the original's string
        // comparison would classify a branch checked out *here* as belonging to another worktree.
        let repo = fixture_repository("repo-with-non-updated-branches").await;
        let link_dir = tempfile::tempdir().expect("failed to create a temporary directory");
        let link = link_dir.path().join("link");
        std::os::unix::fs::symlink(repo.path(), &link).expect("failed to symlink");

        assert!(
            is_this_worktree(&link, repo.path().to_str().expect("a UTF-8 path")),
            "the same worktree by two names"
        );
        assert!(!is_this_worktree(
            &link,
            link_dir.path().to_str().expect("a UTF-8 path")
        ));
    }

    #[tokio::test]
    async fn compares_paths_literally_when_one_cannot_be_resolved() {
        let repo = empty_repository().await;
        let missing = repo.path().join("gone");
        let missing = missing.to_str().expect("a UTF-8 path");

        assert!(!is_this_worktree(&repo.path(), missing));
        assert!(
            is_this_worktree(Path::new(missing), missing),
            "identical unresolvable paths are still the same worktree"
        );
    }

    #[tokio::test]
    async fn finds_nothing_when_no_branch_tracks_anything() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert_eq!(
            get_branches_differing_from_upstream(repo.path())
                .await
                .expect("listing should succeed"),
            Vec::new()
        );
    }

    #[tokio::test]
    async fn finds_nothing_outside_a_repository() {
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");

        assert_eq!(
            get_branches_differing_from_upstream(dir.path())
                .await
                .expect("listing should succeed"),
            Vec::new()
        );
    }

    // --- serialization ---

    #[test]
    fn branch_type_serializes_as_its_discriminant() {
        // A name would leave every `=== BranchType.Local` comparison false, and the values also decide
        // sort order in the UI.
        assert_eq!(
            serde_json::to_value(BranchType::Local).expect("serializes"),
            serde_json::json!(0)
        );
        assert_eq!(
            serde_json::to_value(BranchType::Remote).expect("serializes"),
            serde_json::json!(1)
        );
        assert!(serde_json::from_value::<BranchType>(serde_json::json!(2)).is_err());
    }
}
