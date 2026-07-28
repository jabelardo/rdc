//! Staging conflict resolutions.
//!
//! Ported from `desktop-plus/app/src/lib/git/stage.ts`.

use std::path::Path;

use crate::add::add_conflicted_file;
use crate::checkout::checkout_conflicted_file;
use crate::error::GitError;
use crate::rm::remove_conflicted_file;
use crate::status_parser::GitStatusEntry;

pub use crate::checkout::ManualConflictResolution;

/// Stages a conflicted file according to the side the user chose.
///
/// Two steps, because picking a side is not the same as resolving the conflict: the working-tree file
/// has to be rewritten *and* the index entry replaced. Which steps are needed depends on what each
/// side did to the file, which is what `us` and `them` record.
///
/// - When the chosen side has content to take — it modified the file (`U`), or both sides added it —
///   the file is checked out from that stage first. Both-added is called out separately because
///   neither side is `U`, yet there is still content to choose between.
/// - Then the index is updated: a side that *deleted* the file resolves to a removal, and a side that
///   added or modified it resolves to an add.
///
/// The original took the app's `WorkingDirectoryFileChange` and inspected `status.entry`; this takes
/// the two status entries directly, since the surrounding model is a frontend concern.
pub async fn stage_manual_conflict_resolution(
    repository: impl AsRef<Path>,
    path: impl AsRef<Path>,
    resolution: ManualConflictResolution,
) -> Result<(), GitError> {
    // Without the index entries the caller can't tell us what each side did, so fall back to the
    // common case: take the chosen side's content and stage it. `checkout --ours/--theirs` fails on
    // a path git doesn't consider conflicted, which is the right outcome anyway.
    stage_manual_conflict_resolution_with_entries(repository, path, resolution, None).await
}

/// [`stage_manual_conflict_resolution`], with the conflict's index entries when the caller knows
/// them.
///
/// `entries` is `(us, them)` from the file's `UnmergedEntry`. Supplying it lets a deletion be staged
/// as a deletion, which is the one case the content-based path cannot infer.
pub async fn stage_manual_conflict_resolution_with_entries(
    repository: impl AsRef<Path>,
    path: impl AsRef<Path>,
    resolution: ManualConflictResolution,
    entries: Option<(GitStatusEntry, GitStatusEntry)>,
) -> Result<(), GitError> {
    let repository = repository.as_ref();
    let path = path.as_ref();

    let Some((us, them)) = entries else {
        checkout_conflicted_file(repository, path, resolution).await?;
        return add_conflicted_file(repository, path).await;
    };

    let chosen = match resolution {
        ManualConflictResolution::Theirs => them,
        ManualConflictResolution::Ours => us,
    };

    let added_in_both = us == GitStatusEntry::Added && them == GitStatusEntry::Added;

    if chosen == GitStatusEntry::UpdatedButUnmerged || added_in_both {
        checkout_conflicted_file(repository, path, resolution).await?;
    }

    match chosen {
        GitStatusEntry::Deleted => remove_conflicted_file(repository, path).await,
        GitStatusEntry::Added | GitStatusEntry::UpdatedButUnmerged => {
            add_conflicted_file(repository, path).await
        }
        // The original called `assertNever` here. A status combination we don't recognize shouldn't
        // panic in the git layer, and staging the file as-is is the least surprising fallback.
        _ => add_conflicted_file(repository, path).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{conflicted_repository, unmerged_paths};

    #[tokio::test]
    async fn staging_theirs_resolves_the_conflict() {
        let repo = conflicted_repository().await;

        stage_manual_conflict_resolution(repo.path(), "foo", ManualConflictResolution::Theirs)
            .await
            .expect("staging should succeed");

        let after = unmerged_paths(&repo.path()).await;
        assert!(
            !after.contains(&"foo".to_owned()),
            "the file should no longer be conflicted, got {after:?}"
        );

        let staged = git(
            &["show", ":foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("show should succeed")
        .stdout_lossy()
        .into_owned();
        assert!(
            !staged.contains("<<<<<<<"),
            "the staged blob should not contain markers, got {staged:?}"
        );
    }

    #[tokio::test]
    async fn staging_ours_resolves_the_conflict() {
        let repo = conflicted_repository().await;

        stage_manual_conflict_resolution(repo.path(), "foo", ManualConflictResolution::Ours)
            .await
            .expect("staging should succeed");

        let after = unmerged_paths(&repo.path()).await;
        assert!(!after.contains(&"foo".to_owned()), "got {after:?}");
    }

    #[tokio::test]
    async fn the_two_sides_stage_different_content() {
        let ours_repo = conflicted_repository().await;
        stage_manual_conflict_resolution(ours_repo.path(), "foo", ManualConflictResolution::Ours)
            .await
            .expect("staging should succeed");
        let ours = git(
            &["show", ":foo"],
            ours_repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("show should succeed")
        .stdout_lossy()
        .into_owned();

        let theirs_repo = conflicted_repository().await;
        stage_manual_conflict_resolution(
            theirs_repo.path(),
            "foo",
            ManualConflictResolution::Theirs,
        )
        .await
        .expect("staging should succeed");
        let theirs = git(
            &["show", ":foo"],
            theirs_repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("show should succeed")
        .stdout_lossy()
        .into_owned();

        assert_ne!(
            ours, theirs,
            "picking a side has to actually change what gets staged"
        );
    }

    #[tokio::test]
    async fn a_side_that_deleted_the_file_stages_a_deletion() {
        // The case that needs the index entries: `them` deleted the file, so resolving in their
        // favour means recording a removal rather than adding working-tree content.
        let repo = conflicted_repository().await;

        stage_manual_conflict_resolution_with_entries(
            repo.path(),
            "foo",
            ManualConflictResolution::Theirs,
            Some((GitStatusEntry::UpdatedButUnmerged, GitStatusEntry::Deleted)),
        )
        .await
        .expect("staging a deletion should succeed");

        let after = unmerged_paths(&repo.path()).await;
        assert!(!after.contains(&"foo".to_owned()), "got {after:?}");
        assert!(
            !repo.path().join("foo").exists(),
            "resolving in favour of a delete should remove the file"
        );
    }
}
