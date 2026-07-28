//! Comparing the index against a tree.
//!
//! Ported from `desktop-plus/app/src/lib/git/diff-index.ts`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// The SHA of git's empty tree.
///
/// A constant of the object format, not of any repository — every git repository can resolve it
/// without it having been written. Diffing against it means "compare against nothing", which is how
/// a repository with no commits gets a diff at all.
pub const NULL_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// How an index entry differs from the tree it was compared against.
///
/// See `git diff-index`. A **numeric** enum in TypeScript, like `DiffLineType`, so it serializes as
/// its discriminant rather than its name — see the manual `Serialize` below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexStatus {
    Unknown = 0,
    Added = 1,
    Copied = 2,
    Deleted = 3,
    Modified = 4,
    Renamed = 5,
    TypeChanged = 6,
    Unmerged = 7,
}

impl Serialize for IndexStatus {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for IndexStatus {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(Self::Unknown),
            1 => Ok(Self::Added),
            2 => Ok(Self::Copied),
            3 => Ok(Self::Deleted),
            4 => Ok(Self::Modified),
            5 => Ok(Self::Renamed),
            6 => Ok(Self::TypeChanged),
            7 => Ok(Self::Unmerged),
            other => Err(serde::de::Error::custom(format!(
                "unknown IndexStatus discriminant: {other}"
            ))),
        }
    }
}

impl IndexStatus {
    /// Interprets a `diff-index --name-status` status field.
    ///
    /// Only the first character is significant; rename and copy statuses carry a similarity score
    /// after it.
    fn parse(status: &str) -> Result<Self, GitError> {
        match status.chars().next() {
            Some('A') => Ok(Self::Added),
            Some('C') => Ok(Self::Copied),
            Some('D') => Ok(Self::Deleted),
            Some('M') => Ok(Self::Modified),
            Some('R') => Ok(Self::Renamed),
            Some('T') => Ok(Self::TypeChanged),
            Some('U') => Ok(Self::Unmerged),
            Some('X') => Ok(Self::Unknown),
            _ => Err(GitError::Parse {
                context: "getIndexChanges".to_owned(),
                message: format!("unknown index status: {status:?}"),
            }),
        }
    }

    /// Interprets a status field from an invocation that passed `--no-renames`.
    ///
    /// Rejects `Copied` and `Renamed`: with rename detection off git shouldn't report them, so seeing
    /// one means the invocation and the parser disagree about the flags. The original threw here for
    /// the same reason.
    fn parse_no_rename(status: &str) -> Result<Self, GitError> {
        let parsed = Self::parse(status)?;

        if matches!(parsed, Self::Copied | Self::Renamed) {
            return Err(GitError::Parse {
                context: "getIndexChanges".to_owned(),
                message: format!("invalid index status for a --no-renames invocation: {parsed:?}"),
            });
        }

        Ok(parsed)
    }
}

/// Lists what the index holds that `HEAD` does not, and how each path differs.
///
/// Returned as pairs rather than a map because a repository path is an arbitrary byte string and so
/// is not a safe JavaScript object key — the same reasoning as `manualResolutions` on
/// `create_merge_commit`. Order follows git's.
///
/// An **unborn `HEAD`** is handled by re-running the diff against [`NULL_TREE_SHA`]. `diff-index`
/// exits 128 both when the path isn't a repository and, far more commonly, when there is no `HEAD`
/// to compare against; a fresh repository with staged files is a normal state, and the null tree is
/// what makes "everything staged is an addition" fall out naturally.
pub async fn get_index_changes(
    repository: impl AsRef<Path>,
) -> Result<Vec<(String, IndexStatus)>, GitError> {
    let repository = repository.as_ref();
    let base = [
        "diff-index",
        "--cached",
        "--name-status",
        "--no-renames",
        "-z",
    ];

    let mut args: Vec<&str> = base.to_vec();
    args.extend(["HEAD", "--"]);

    let output = git(
        &args,
        repository,
        "getIndexChanges",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    let output = if output.exit_code == 128 {
        let mut fallback: Vec<&str> = base.to_vec();
        fallback.push(NULL_TREE_SHA);
        // Deliberately not tolerant of 128 the second time: if diffing against the null tree also
        // fails, the path really isn't a usable repository and that is an error.
        git(
            &fallback,
            repository,
            "getIndexChanges",
            GitOptions::default(),
        )
        .await?
    } else {
        output
    };

    parse_index_changes(&output.stdout_lossy())
}

/// Parses `--name-status -z` output: alternating status and path fields.
fn parse_index_changes(stdout: &str) -> Result<Vec<(String, IndexStatus)>, GitError> {
    let fields: Vec<&str> = stdout.split('\0').collect();
    let mut changes = Vec::new();

    // Steps in pairs, stopping when there is no field left to read a path from. For well-formed
    // output that drops the empty field after the trailing NUL.
    //
    // Note a *dangling* status pairs with that empty field instead, yielding an entry with an empty
    // path — the original did the same, and a test pins it. git doesn't emit a status without a path,
    // so this is a shape neither implementation has to be right about.
    let mut index = 0;
    while index + 1 < fields.len() {
        changes.push((
            fields[index + 1].to_owned(),
            IndexStatus::parse_no_rename(fields[index])?,
        ));
        index += 2;
    }

    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    async fn stage(repo: &Path, args: &[&str]) {
        git(args, repo, "test", GitOptions::default())
            .await
            .expect("git should succeed");
    }

    // --- status parsing ---

    #[test]
    fn parses_the_status_letters() {
        assert_eq!(IndexStatus::parse("A").expect("ok"), IndexStatus::Added);
        assert_eq!(IndexStatus::parse("C75").expect("ok"), IndexStatus::Copied);
        assert_eq!(IndexStatus::parse("D").expect("ok"), IndexStatus::Deleted);
        assert_eq!(IndexStatus::parse("M").expect("ok"), IndexStatus::Modified);
        assert_eq!(
            IndexStatus::parse("R100").expect("ok"),
            IndexStatus::Renamed
        );
        assert_eq!(
            IndexStatus::parse("T").expect("ok"),
            IndexStatus::TypeChanged
        );
        assert_eq!(IndexStatus::parse("U").expect("ok"), IndexStatus::Unmerged);
        assert_eq!(IndexStatus::parse("X").expect("ok"), IndexStatus::Unknown);
    }

    #[test]
    fn rejects_an_unrecognized_status() {
        for value in ["", "?", "hello"] {
            assert!(
                matches!(IndexStatus::parse(value), Err(GitError::Parse { .. })),
                "{value:?} should not parse"
            );
        }
    }

    #[test]
    fn rejects_a_rename_or_copy_when_rename_detection_is_off() {
        // Guards the invocation against the parser drifting apart: `--no-renames` is passed, so these
        // cannot legitimately appear.
        assert!(matches!(
            IndexStatus::parse_no_rename("R100"),
            Err(GitError::Parse { .. })
        ));
        assert!(matches!(
            IndexStatus::parse_no_rename("C75"),
            Err(GitError::Parse { .. })
        ));
        assert_eq!(
            IndexStatus::parse_no_rename("M").expect("ok"),
            IndexStatus::Modified
        );
    }

    #[test]
    fn serializes_as_its_numeric_discriminant() {
        // A numeric TypeScript enum, so the wire value is the number and not the variant name.
        assert_eq!(
            serde_json::to_string(&IndexStatus::Modified).expect("serializes"),
            "4"
        );
        assert_eq!(
            serde_json::from_str::<IndexStatus>("1").expect("deserializes"),
            IndexStatus::Added
        );
        assert!(serde_json::from_str::<IndexStatus>("99").is_err());
    }

    // --- output parsing ---

    #[test]
    fn parses_alternating_status_and_path_fields() {
        let changes = parse_index_changes("M\0one\0A\0two\0").expect("should parse");
        assert_eq!(
            changes,
            vec![
                ("one".to_owned(), IndexStatus::Modified),
                ("two".to_owned(), IndexStatus::Added),
            ]
        );
    }

    #[test]
    fn parses_empty_output() {
        assert!(parse_index_changes("").expect("should parse").is_empty());
    }

    #[test]
    fn pairs_a_trailing_status_with_the_empty_field_after_the_final_nul() {
        // Faithful to the original, and pinned because it looks like a bug: `-z` output ends with a
        // trailing NUL, so `split` yields a final empty field that a dangling status pairs with,
        // producing an entry with an empty path. The original's loop did exactly the same.
        //
        // Left alone rather than "fixed" for the same reason as the equivalent case in `log.rs`: git
        // does not emit a status without a path, so a stricter rule would only risk rejecting output
        // git does emit.
        assert_eq!(
            parse_index_changes("M\0one\0A\0").expect("should parse"),
            vec![
                ("one".to_owned(), IndexStatus::Modified),
                (String::new(), IndexStatus::Added),
            ]
        );
    }

    #[test]
    fn drops_the_empty_field_after_a_complete_record() {
        // The ordinary case: well-formed output must not gain a phantom trailing entry.
        assert_eq!(
            parse_index_changes("M\0one\0").expect("should parse"),
            vec![("one".to_owned(), IndexStatus::Modified)]
        );
    }

    #[test]
    fn keeps_a_path_containing_a_newline() {
        // Why the invocation uses -z: a newline in a path is data, not a delimiter.
        let changes = parse_index_changes("M\0we\nird\0").expect("should parse");
        assert_eq!(changes, vec![("we\nird".to_owned(), IndexStatus::Modified)]);
    }

    // --- against real repositories ---

    #[tokio::test]
    async fn reports_nothing_when_the_index_matches_head() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");

        let changes = get_index_changes(repo.path())
            .await
            .expect("should succeed");
        assert!(changes.is_empty(), "got {changes:?}");
    }

    #[tokio::test]
    async fn reports_a_staged_modification() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        stage(&repo.path(), &["add", "--", "a.txt"]).await;

        let changes = get_index_changes(repo.path())
            .await
            .expect("should succeed");
        assert_eq!(changes, vec![("a.txt".to_owned(), IndexStatus::Modified)]);
    }

    #[tokio::test]
    async fn reports_a_staged_addition_and_deletion() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "doomed", "hello\n", "first");
        std::fs::write(repo.path().join("added"), "new\n").expect("failed to write");
        std::fs::remove_file(repo.path().join("doomed")).expect("failed to remove");
        stage(&repo.path(), &["add", "-A"]).await;

        let mut changes = get_index_changes(repo.path())
            .await
            .expect("should succeed");
        changes.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(
            changes,
            vec![
                ("added".to_owned(), IndexStatus::Added),
                ("doomed".to_owned(), IndexStatus::Deleted),
            ]
        );
    }

    #[tokio::test]
    async fn ignores_changes_that_are_not_staged() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "hello\n", "first");
        std::fs::write(repo.path().join("a.txt"), "changed\n").expect("failed to write");
        // Not added, so the index still matches HEAD.

        assert!(get_index_changes(repo.path())
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn reports_a_rename_as_a_delete_and_an_add() {
        // `--no-renames` is what makes this predictable, and is why the parser refuses R/C statuses.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "before", "hello\n", "first");
        stage(&repo.path(), &["mv", "before", "after"]).await;

        let mut changes = get_index_changes(repo.path())
            .await
            .expect("should succeed");
        changes.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(
            changes,
            vec![
                ("after".to_owned(), IndexStatus::Added),
                ("before".to_owned(), IndexStatus::Deleted),
            ]
        );
    }

    #[tokio::test]
    async fn diffs_against_the_null_tree_when_head_is_unborn() {
        // The fallback path. `diff-index HEAD` exits 128 with no commits, and every staged file
        // should read as an addition rather than the call failing.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("first.txt"), "hello\n").expect("failed to write");
        stage(&repo.path(), &["add", "--", "first.txt"]).await;

        let changes = get_index_changes(repo.path())
            .await
            .expect("an unborn HEAD should fall back to the null tree");

        assert_eq!(changes, vec![("first.txt".to_owned(), IndexStatus::Added)]);
    }

    #[tokio::test]
    async fn reports_nothing_for_an_unborn_head_with_an_empty_index() {
        let repo = empty_repository().await;
        assert!(get_index_changes(repo.path())
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn fails_for_a_directory_that_is_not_a_repository() {
        // The other reason diff-index exits 128. The null-tree retry fails too, which is what turns
        // this into an error rather than an empty list.
        let dir = tempfile::tempdir().expect("failed to create a temporary directory");
        assert!(get_index_changes(dir.path()).await.is_err());
    }

    #[tokio::test]
    async fn the_null_tree_sha_resolves_in_any_repository() {
        // It is a constant of the object format, not something a repository has to contain.
        let repo = empty_repository().await;
        let output = git(
            &["cat-file", "-t", NULL_TREE_SHA],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the null tree should resolve");

        assert_eq!(output.stdout_trimmed(), "tree");
    }
}
