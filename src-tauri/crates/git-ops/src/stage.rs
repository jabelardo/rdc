//! Staging conflict resolutions.
//!
//! Ported from `desktop-plus/app/src/lib/git/stage.ts`.

use std::path::Path;

use crate::add::add_conflicted_file;
use crate::checkout::checkout_conflicted_file;
use serde::{Deserialize, Serialize};

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
/// A conflict the user resolved by picking a side in the app.
///
/// Carries the index entries, and that is the whole point: without them a resolution can only be
/// staged as "take the chosen side's content", so a side that *deleted* the file cannot be honoured.
/// `checkout --ours/--theirs` fails outright on such a path — "does not have their version" — so the
/// entry-less form turns a resolvable modify/delete into an error.
///
/// The original passed its `WorkingDirectoryFileChange` and read `status.entry` off it. That is view
/// state, so this carries the two entries directly and the frontend supplies them from the status it
/// already has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualResolution {
    /// Path relative to the repository root.
    pub path: String,

    /// The side the user picked.
    pub resolution: ManualConflictResolution,

    /// The conflict's index entries, `(us, them)`, when the caller knows them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<(GitStatusEntry, GitStatusEntry)>,
}

/// A conflict the user has finished with, as the git facts needed to stage it.
///
/// The original took a `WorkingDirectoryFileChange` and a `Map` of resolutions. That is view state — see
/// [`crate::status`] — so this carries what the index needs instead, and the frontend supplies it from the
/// status it already has. Only conflicted files belong here; upstream skipped anything else, and a type that
/// cannot represent a non-conflict says so more clearly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedConflict {
    /// Path relative to the repository root.
    pub path: String,

    /// The conflict's index entries, `(us, them)`, when the caller knows them.
    ///
    /// Supplying them lets a deletion be staged as a deletion, which content alone cannot express.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub entries: Option<(GitStatusEntry, GitStatusEntry)>,

    /// How many conflict markers git still found in the file.
    ///
    /// `Some(0)` is the interesting value: a text conflict the user resolved in their own editor. Absent for a
    /// conflict git could not count markers in — a binary one, or a modify/delete.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub conflict_marker_count: Option<u32>,

    /// The side the user picked in the app, when they picked one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub resolution: Option<ManualConflictResolution>,
}

/// Stages the conflicts the user has finished with.
///
/// # Why this exists at all
///
/// A checkout refuses to run while the index holds unresolved conflicts — `error: you need to resolve your
/// current index first` — so anything that checks out after a conflict has to stage the resolutions first.
///
/// Two kinds count as resolved, and they are staged differently:
///
/// - **The user picked a side in the app**, so the choice is staged through
///   [`stage_manual_conflict_resolution_with_entries`], which can turn "theirs, which deleted it" into a
///   staged deletion.
/// - **The user edited the file until no markers remained**, which git reports as a marker count of zero. The
///   file on disk is the resolution, so adding it is enough.
///
/// Anything else is left alone: a conflict with markers still in it is not resolved, and staging it would
/// commit the markers.
pub async fn stage_resolved_conflict_files(
    repository: impl AsRef<Path>,
    files: &[ResolvedConflict],
) -> Result<(), GitError> {
    let repository = repository.as_ref();

    for file in files {
        if let Some(resolution) = file.resolution {
            stage_manual_conflict_resolution_with_entries(
                repository,
                &file.path,
                resolution,
                file.entries,
            )
            .await?;
        } else if file.conflict_marker_count == Some(0) {
            add_conflicted_file(repository, &file.path).await?;
        }
    }

    Ok(())
}

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
    // --- staging the conflicts a user has finished with ---

    #[tokio::test]
    async fn stages_a_text_conflict_the_user_resolved_in_an_editor() {
        // Marker count zero is how git reports "they edited until nothing was left to resolve", and the file
        // on disk *is* the resolution — so adding it is enough.
        let repo = conflicted_repository().await;
        let path = unmerged_paths(&repo.path())
            .await
            .first()
            .expect("the fixture conflicts")
            .clone();
        std::fs::write(repo.path().join(&path), "resolved by hand\n").expect("failed to write");

        stage_resolved_conflict_files(
            repo.path(),
            &[ResolvedConflict {
                path: path.clone(),
                entries: None,
                conflict_marker_count: Some(0),
                resolution: None,
            }],
        )
        .await
        .expect("staging should succeed");

        assert!(
            !unmerged_paths(&repo.path()).await.contains(&path),
            "the path is no longer unmerged"
        );
    }

    #[tokio::test]
    async fn leaves_a_conflict_that_still_has_markers_alone() {
        // Staging it would commit the markers. The count being non-zero is the whole signal.
        let repo = conflicted_repository().await;
        let path = unmerged_paths(&repo.path())
            .await
            .first()
            .expect("the fixture conflicts")
            .clone();

        stage_resolved_conflict_files(
            repo.path(),
            &[ResolvedConflict {
                path: path.clone(),
                entries: None,
                conflict_marker_count: Some(3),
                resolution: None,
            }],
        )
        .await
        .expect("it should succeed");

        assert!(
            unmerged_paths(&repo.path()).await.contains(&path),
            "still unmerged, because it is still unresolved"
        );
    }

    #[tokio::test]
    async fn stages_the_side_the_user_picked() {
        let repo = conflicted_repository().await;
        let path = unmerged_paths(&repo.path())
            .await
            .first()
            .expect("the fixture conflicts")
            .clone();

        stage_resolved_conflict_files(
            repo.path(),
            &[ResolvedConflict {
                path: path.clone(),
                entries: None,
                conflict_marker_count: None,
                resolution: Some(ManualConflictResolution::Theirs),
            }],
        )
        .await
        .expect("staging should succeed");

        assert!(!unmerged_paths(&repo.path()).await.contains(&path));
    }

    #[tokio::test]
    async fn a_chosen_side_wins_over_the_marker_count() {
        // Upstream's order: a resolution the user picked in the app is checked first, so a file they *also*
        // edited by hand still gets the side they asked for.
        let repo = conflicted_repository().await;
        let path = unmerged_paths(&repo.path())
            .await
            .first()
            .expect("the fixture conflicts")
            .clone();

        stage_resolved_conflict_files(
            repo.path(),
            &[ResolvedConflict {
                path: path.clone(),
                entries: None,
                conflict_marker_count: Some(3),
                resolution: Some(ManualConflictResolution::Ours),
            }],
        )
        .await
        .expect("staging should succeed");

        assert!(
            !unmerged_paths(&repo.path()).await.contains(&path),
            "the picked side was staged despite the markers"
        );
    }

    #[tokio::test]
    async fn stages_nothing_when_given_nothing() {
        let repo = conflicted_repository().await;
        let before = unmerged_paths(&repo.path()).await;

        stage_resolved_conflict_files(repo.path(), &[])
            .await
            .expect("it should succeed");

        assert_eq!(unmerged_paths(&repo.path()).await, before);
    }
}
