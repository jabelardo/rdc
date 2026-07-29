//! Resetting the index and the working tree.
//!
//! Ported from `desktop-plus/app/src/lib/git/reset.ts`.

use std::ffi::OsStr;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// How far a reset reaches.
///
/// A **numeric** enum in TypeScript (`GitResetMode`), so it serializes as its discriminant — the same
/// convention as `DiffType` and `IndexStatus`. The values are upstream's, and `Hard` being **0** is worth
/// noticing: the most destructive mode is the one a missing or zeroed field would select, so this is never
/// given a `Default`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    /// Resets the index *and* the working tree, discarding changes to tracked files.
    Hard = 0,
    /// Moves `HEAD` only. Everything that was different stays staged.
    Soft = 1,
    /// Resets the index but leaves the working tree — git's own default.
    Mixed = 2,
}

impl Serialize for ResetMode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for ResetMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(Self::Hard),
            1 => Ok(Self::Soft),
            2 => Ok(Self::Mixed),
            other => Err(serde::de::Error::custom(format!(
                "unknown ResetMode discriminant: {other}"
            ))),
        }
    }
}

impl ResetMode {
    /// The flag this mode adds, if any.
    ///
    /// `Mixed` adds nothing because it is what `git reset` does with no mode given.
    fn flag(self) -> Option<&'static str> {
        match self {
            Self::Hard => Some("--hard"),
            Self::Soft => Some("--soft"),
            Self::Mixed => None,
        }
    }
}

/// Resets `ref_name` with the given mode.
///
/// **`Hard` discards work.** Everything different from `ref_name` in the working tree is gone, with no
/// reflog entry for the file contents — so the caller is expected to have asked the user first.
pub async fn reset(
    repository: impl AsRef<Path>,
    mode: ResetMode,
    ref_name: &str,
) -> Result<(), GitError> {
    let mut args = vec!["reset"];
    if let Some(flag) = mode.flag() {
        args.push(flag);
    }
    args.push(ref_name);

    git(&args, repository, "reset", GitOptions::default()).await?;

    Ok(())
}

/// Updates the index for `paths` from the tree at `ref_name`.
///
/// A no-op when `paths` is empty, matching the original — and necessary, since `reset -- ` with no pathspec
/// would reset *everything*, which is the opposite of what an empty selection means.
///
/// # Paths go over stdin, by a different route than the original's
///
/// Upstream passed paths as arguments except on Windows, where it used `git reset --stdin` — and its comment
/// noted that flag "hasn't made it to Git core". It still hasn't: `--stdin` is a Git for Windows extension,
/// and asking for it elsewhere fails with `unknown option`. (Found by trying it: the first version of this
/// function used `--stdin` on every platform, on my mistaken reading of that comment, and git said no.)
///
/// git core's portable equivalent is `--pathspec-from-file=- --pathspec-file-nul`, which reads
/// NUL-separated paths from stdin. Using it everywhere avoids both problems an argument list has: the
/// platform's limit — `ARG_MAX` is larger than Windows' ~32KB but a repository with tens of thousands of
/// changed paths can still reach it — and the impossibility of passing a path containing a newline.
pub async fn reset_paths(
    repository: impl AsRef<Path>,
    mode: ResetMode,
    ref_name: &str,
    paths: &[String],
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut args: Vec<&OsStr> = vec![OsStr::new("reset")];
    if let Some(flag) = mode.flag() {
        args.push(OsStr::new(flag));
    }
    args.push(OsStr::new(ref_name));
    // The tree-ish comes before these, as git's usage has it.
    args.extend([
        OsStr::new("--pathspec-from-file=-"),
        OsStr::new("--pathspec-file-nul"),
    ]);

    let mut stdin = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if index > 0 {
            stdin.push(0);
        }
        stdin.extend_from_slice(path.as_bytes());
    }

    git(
        &args,
        repository,
        "resetPaths",
        GitOptions::default().with_stdin(stdin),
    )
    .await?;

    Ok(())
}

/// Clears the staging area.
///
/// `create_commit` runs this first so the commit reflects exactly what the user selected, rather
/// than whatever happened to be staged beforehand.
///
/// Note this is `reset -- .`, not a bare `reset`: the pathspec keeps it scoped to the working tree
/// and, more importantly, makes it work in a repository with no commits yet, where `HEAD` doesn't
/// resolve. The original relied on the same trick.
pub async fn unstage_all(repository: impl AsRef<Path>) -> Result<(), GitError> {
    git(
        &["reset", "--", "."],
        repository,
        "unstageAll",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    /// Paths git currently reports as staged.
    async fn staged_paths(repo: &Path) -> Vec<String> {
        git(
            &["diff", "--cached", "--name-only"],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("diff --cached should succeed")
        .stdout_lossy()
        .lines()
        .map(str::to_owned)
        .collect()
    }

    #[tokio::test]
    async fn clears_the_staging_area() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");

        std::fs::write(repo.path().join("tracked"), "changed\n").expect("failed to write");
        git(
            &["add", "--", "tracked"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        assert_eq!(staged_paths(&repo.path()).await, vec!["tracked".to_owned()]);

        unstage_all(repo.path())
            .await
            .expect("reset should succeed");

        assert!(
            staged_paths(&repo.path()).await.is_empty(),
            "nothing should be staged after a reset"
        );
    }

    #[tokio::test]
    async fn leaves_the_working_tree_alone() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "tracked", "contents\n", "first");
        std::fs::write(repo.path().join("tracked"), "changed\n").expect("failed to write");

        unstage_all(repo.path())
            .await
            .expect("reset should succeed");

        let contents =
            std::fs::read_to_string(repo.path().join("tracked")).expect("failed to read back");
        assert_eq!(
            contents, "changed\n",
            "unstaging must not discard the user's edits"
        );
    }

    #[tokio::test]
    async fn succeeds_in_a_repository_with_no_commits() {
        // This is why the pathspec is there: a bare `git reset` needs HEAD to resolve, and in an
        // unborn repository it doesn't. `create_commit` calls this unconditionally, so it has to
        // work before the first commit exists.
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("foo"), "foo\n").expect("failed to write");
        git(
            &["add", "--", "foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");

        unstage_all(repo.path())
            .await
            .expect("resetting an unborn repository should succeed");

        assert!(staged_paths(&repo.path()).await.is_empty());
    }
    // --- reset ---

    #[tokio::test]
    async fn a_soft_reset_moves_head_and_keeps_everything_staged() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        reset(repo.path(), ResetMode::Soft, "HEAD~1")
            .await
            .expect("resetting should succeed");

        assert_eq!(head_message(&repo.path()).await, "first");
        assert_eq!(
            staged_paths(&repo.path()).await,
            vec!["a.txt".to_owned()],
            "the second commit's change is still staged"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "two\n",
            "and the working tree is untouched"
        );
    }

    #[tokio::test]
    async fn a_mixed_reset_unstages_but_keeps_the_working_tree() {
        // git's own default, which is why the mode adds no flag.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        reset(repo.path(), ResetMode::Mixed, "HEAD~1")
            .await
            .expect("resetting should succeed");

        assert_eq!(head_message(&repo.path()).await, "first");
        assert!(
            staged_paths(&repo.path()).await.is_empty(),
            "nothing is staged"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "two\n",
            "but the change is still on disk"
        );
    }

    #[tokio::test]
    async fn a_hard_reset_discards_the_working_tree() {
        // The destructive one. Worth its own test precisely because `Hard` is discriminant 0, so a zeroed or
        // defaulted mode would land here.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        commit_file(&repo.path(), "a.txt", "two\n", "second");

        reset(repo.path(), ResetMode::Hard, "HEAD~1")
            .await
            .expect("resetting should succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).expect("failed to read"),
            "one\n",
            "the later content is gone"
        );
    }

    #[tokio::test]
    async fn resetting_no_paths_changes_nothing() {
        // An empty selection means "reset nothing". Without the guard the same arguments would reset
        // *everything*, which is the opposite.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        std::fs::write(repo.path().join("b.txt"), "two\n").expect("failed to write");
        git(
            &["add", "b.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");

        reset_paths(repo.path(), ResetMode::Mixed, "HEAD", &[])
            .await
            .expect("it should succeed");

        assert_eq!(
            staged_paths(&repo.path()).await,
            vec!["b.txt".to_owned()],
            "the staged file is still staged"
        );
    }

    #[tokio::test]
    async fn resets_only_the_paths_it_is_given() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        for name in ["staged.txt", "kept.txt"] {
            std::fs::write(repo.path().join(name), "new\n").expect("failed to write");
        }
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");

        reset_paths(
            repo.path(),
            ResetMode::Mixed,
            "HEAD",
            &["staged.txt".to_owned()],
        )
        .await
        .expect("it should succeed");

        assert_eq!(
            staged_paths(&repo.path()).await,
            vec!["kept.txt".to_owned()],
            "only the named path was unstaged"
        );
    }

    #[tokio::test]
    async fn resets_a_path_containing_a_newline() {
        // Why the paths go over stdin rather than as arguments on every platform: an argument list cannot
        // express this, and the original only used stdin on Windows.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        let awkward = "we\nird";
        std::fs::write(repo.path().join(awkward), "new\n").expect("failed to write");
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");

        reset_paths(repo.path(), ResetMode::Mixed, "HEAD", &[awkward.to_owned()])
            .await
            .expect("it should succeed");

        assert!(
            staged_paths(&repo.path()).await.is_empty(),
            "the awkward path was unstaged"
        );
        assert!(awkward.contains('\n'), "the path really does contain one");
    }

    #[test]
    fn reset_modes_serialize_as_their_discriminants() {
        // A numeric enum in TypeScript, so a name would leave every comparison false.
        for (mode, discriminant) in [
            (ResetMode::Hard, 0),
            (ResetMode::Soft, 1),
            (ResetMode::Mixed, 2),
        ] {
            assert_eq!(
                serde_json::to_value(mode).expect("serializes"),
                serde_json::json!(discriminant)
            );
        }
        assert!(serde_json::from_value::<ResetMode>(serde_json::json!(3)).is_err());
    }

    /// The subject of `HEAD`'s commit.
    async fn head_message(repo: &Path) -> String {
        git(
            &["log", "-1", "--format=%s"],
            repo,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("log should succeed")
        .stdout_trimmed()
    }
}
