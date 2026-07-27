//! Pins the JSON shape of everything that crosses the IPC boundary.
//!
//! # Why this file exists
//!
//! rdc uses Tauri's native IPC (`#[tauri::command]` + `invoke`) rather than a binding generator, so
//! the TypeScript types in `src/models/**` are written by hand. That is the same hand-synced
//! contract that `MIGRATION_MAP.md` criticises `ipc-shared.ts` for — **this test is the mitigation**.
//!
//! Rename a field or change a `#[serde]` attribute and these assertions fail, in Rust, immediately —
//! instead of the frontend silently receiving `undefined` at runtime. The expected JSON below is the
//! specification the hand-written TypeScript must match.
//!
//! The representations were chosen so the **already-ported** `src/models/status.ts` enums are reused
//! rather than duplicated: `GitStatusEntry` serializes to its single characters, `AppFileStatusKind`
//! to its PascalCase names, `UnmergedEntrySummary` to kebab-case.
//!
//! # This file alone is not enough
//!
//! Asserting Rust against JSON *written in the same file* proves only that the code does what this
//! test says — not that it matches the domain model the UI consumes. A conflict shape once satisfied
//! every assertion here while being unusable by `src/lib/status.ts`, because the expectations and the
//! code were wrong together.
//!
//! So [`emits_the_wire_snapshot_the_frontend_checks_itself_against`] writes the real serialized
//! output to `src/lib/__generated__/wire-snapshot.json`, and `src/lib/git-ipc.test.ts` compares that
//! snapshot to fixtures which `tsc` checks against the ported models. That closes the loop:
//!
//! - snapshot ≠ typed fixture → the TypeScript test fails at runtime
//! - typed fixture ≠ ported model → `tsc` fails
//!
//! so Rust output drifting from the ported model cannot pass both.

use std::collections::BTreeMap;
use std::path::PathBuf;

use git_ops::status::{
    AheadBehind, AppFileStatus, ConflictedFileStatus, StatusFileChange, StatusResult, UnmergedEntry,
};
use git_ops::status_parser::{GitStatusEntry, SubmoduleStatus, UnmergedEntrySummary};
use serde_json::json;

#[test]
fn git_status_entry_serializes_to_its_single_character() {
    for (value, expected) in [
        (GitStatusEntry::Modified, "M"),
        (GitStatusEntry::Added, "A"),
        (GitStatusEntry::Deleted, "D"),
        (GitStatusEntry::Renamed, "R"),
        (GitStatusEntry::Copied, "C"),
        (GitStatusEntry::Unchanged, "."),
        (GitStatusEntry::Untracked, "?"),
        (GitStatusEntry::Ignored, "!"),
        (GitStatusEntry::UpdatedButUnmerged, "U"),
    ] {
        assert_eq!(
            serde_json::to_value(value).expect("serializes"),
            json!(expected)
        );
    }
}

#[test]
fn unmerged_entry_summary_serializes_to_kebab_case() {
    for (value, expected) in [
        (UnmergedEntrySummary::AddedByUs, "added-by-us"),
        (UnmergedEntrySummary::DeletedByUs, "deleted-by-us"),
        (UnmergedEntrySummary::AddedByThem, "added-by-them"),
        (UnmergedEntrySummary::DeletedByThem, "deleted-by-them"),
        (UnmergedEntrySummary::BothDeleted, "both-deleted"),
        (UnmergedEntrySummary::BothAdded, "both-added"),
        (UnmergedEntrySummary::BothModified, "both-modified"),
    ] {
        assert_eq!(
            serde_json::to_value(value).expect("serializes"),
            json!(expected)
        );
    }
}

#[test]
fn submodule_status_uses_camel_case_fields() {
    let value = serde_json::to_value(SubmoduleStatus {
        commit_changed: true,
        modified_changes: false,
        untracked_changes: true,
    })
    .expect("serializes");

    assert_eq!(
        value,
        json!({
            "commitChanged": true,
            "modifiedChanges": false,
            "untrackedChanges": true,
        })
    );
}

#[test]
fn app_file_status_is_a_discriminated_union_on_kind() {
    // Reproduces the original TypeScript `{ kind: AppFileStatusKind.Modified, … }` exactly.
    let value = serde_json::to_value(AppFileStatus::Modified {
        submodule_status: None,
    })
    .expect("serializes");

    assert_eq!(value, json!({ "kind": "Modified" }));
}

#[test]
fn renamed_status_carries_its_old_path() {
    let value = serde_json::to_value(AppFileStatus::Renamed {
        old_path: "before".to_owned(),
        submodule_status: None,
        rename_includes_modifications: true,
    })
    .expect("serializes");

    assert_eq!(
        value,
        json!({
            "kind": "Renamed",
            "oldPath": "before",
            "renameIncludesModifications": true,
        })
    );
}

#[test]
fn a_text_conflict_is_distinguished_by_the_presence_of_a_marker_count() {
    // The original had no discriminator between the two conflict shapes — `isConflictWithMarkers`
    // tested for the presence of `conflictMarkerCount`. The untagged representation preserves that.
    //
    // Note the conflict details are nested under `entry`. An earlier version of this file flattened
    // them, and every test here still passed: the JSON matched the Rust, and the Rust matched the
    // hand-written `git-ipc.ts`. What it did *not* match was the ported `models/status.ts`, which is
    // what `src/lib/status.ts` actually consumes. Pinning Rust against JSON is not the same as
    // pinning Rust against the domain model.
    let value = serde_json::to_value(AppFileStatus::Conflicted(
        ConflictedFileStatus::WithMarkers {
            entry: UnmergedEntry {
                action: UnmergedEntrySummary::BothModified,
                us: GitStatusEntry::UpdatedButUnmerged,
                them: GitStatusEntry::UpdatedButUnmerged,
                submodule_status: None,
            },
            conflict_marker_count: 3,
        },
    ))
    .expect("serializes");

    assert_eq!(
        value,
        json!({
            "kind": "Conflicted",
            "entry": {
                "kind": "conflicted",
                "action": "both-modified",
                "us": "U",
                "them": "U",
            },
            "conflictMarkerCount": 3,
        })
    );
}

#[test]
fn a_manual_conflict_omits_the_marker_count() {
    let value = serde_json::to_value(AppFileStatus::Conflicted(ConflictedFileStatus::Manual {
        entry: UnmergedEntry {
            action: UnmergedEntrySummary::DeletedByThem,
            us: GitStatusEntry::UpdatedButUnmerged,
            them: GitStatusEntry::Deleted,
            submodule_status: None,
        },
    }))
    .expect("serializes");

    assert_eq!(
        value,
        json!({
            "kind": "Conflicted",
            "entry": {
                "kind": "conflicted",
                "action": "deleted-by-them",
                "us": "U",
                "them": "D",
            },
        })
    );
    assert!(
        value.get("conflictMarkerCount").is_none(),
        "its absence is what marks this a manual conflict"
    );
}

#[test]
fn a_conflict_carries_its_submodule_status_inside_the_entry() {
    // The original's `ConflictsWithMarkers` has an outer optional `submoduleStatus`, but
    // `parseConflictedState` never populates it — the one that matters is the entry's.
    let value = serde_json::to_value(AppFileStatus::Conflicted(ConflictedFileStatus::Manual {
        entry: UnmergedEntry {
            action: UnmergedEntrySummary::BothAdded,
            us: GitStatusEntry::Added,
            them: GitStatusEntry::Added,
            submodule_status: Some(SubmoduleStatus {
                commit_changed: true,
                modified_changes: false,
                untracked_changes: false,
            }),
        },
    }))
    .expect("serializes");

    assert_eq!(
        value["entry"]["submoduleStatus"],
        json!({
            "commitChanged": true,
            "modifiedChanges": false,
            "untrackedChanges": false,
        })
    );
    assert!(
        value.get("submoduleStatus").is_none(),
        "the outer field is never set"
    );
}

#[test]
fn status_result_matches_the_expected_wire_shape() {
    let result = StatusResult {
        current_branch: Some("main".to_owned()),
        current_upstream_branch: Some("origin/main".to_owned()),
        current_tip: Some("abc123".to_owned()),
        branch_ahead_behind: Some(AheadBehind {
            ahead: 1,
            behind: 2,
        }),
        merge_head_found: false,
        squash_msg_found: false,
        rebase_internal_state: None,
        is_cherry_picking_head_found: false,
        files: vec![StatusFileChange {
            path: "foo.txt".to_owned(),
            status: AppFileStatus::Modified {
                submodule_status: None,
            },
            starts_unselected: false,
        }],
        do_conflicted_files_exist: false,
    };

    assert_eq!(
        serde_json::to_value(&result).expect("serializes"),
        json!({
            "currentBranch": "main",
            "currentUpstreamBranch": "origin/main",
            "currentTip": "abc123",
            "branchAheadBehind": { "ahead": 1, "behind": 2 },
            "mergeHeadFound": false,
            "squashMsgFound": false,
            "isCherryPickingHeadFound": false,
            "files": [{
                "path": "foo.txt",
                "status": { "kind": "Modified" },
                "startsUnselected": false,
            }],
            "doConflictedFilesExist": false,
        })
    );
}

#[test]
fn absent_optional_fields_are_omitted_rather_than_null() {
    // The hand-written TypeScript declares these as optional properties (`currentBranch?: string`),
    // so the wire form omits them. Emitting `null` instead would not satisfy those types under
    // `strictNullChecks`.
    let result = StatusResult {
        current_branch: None,
        current_upstream_branch: None,
        current_tip: None,
        branch_ahead_behind: None,
        merge_head_found: false,
        squash_msg_found: false,
        rebase_internal_state: None,
        is_cherry_picking_head_found: false,
        files: Vec::new(),
        do_conflicted_files_exist: false,
    };

    let value = serde_json::to_value(&result).expect("serializes");
    for absent in [
        "currentBranch",
        "currentUpstreamBranch",
        "currentTip",
        "branchAheadBehind",
        "rebaseInternalState",
    ] {
        assert!(value.get(absent).is_none(), "{absent} should be omitted");
    }
}

#[test]
fn status_result_round_trips() {
    // Deserialization matters for tests and for any future Rust-side consumer; a representation
    // that serializes but can't be read back (a real hazard with untagged enums) is a trap.
    let result = StatusResult {
        current_branch: None,
        current_upstream_branch: None,
        current_tip: None,
        branch_ahead_behind: None,
        merge_head_found: true,
        squash_msg_found: false,
        rebase_internal_state: None,
        is_cherry_picking_head_found: false,
        files: vec![StatusFileChange {
            path: "conflicted".to_owned(),
            status: AppFileStatus::Conflicted(ConflictedFileStatus::WithMarkers {
                entry: UnmergedEntry {
                    action: UnmergedEntrySummary::BothAdded,
                    us: GitStatusEntry::Added,
                    them: GitStatusEntry::Added,
                    submodule_status: Some(SubmoduleStatus {
                        commit_changed: true,
                        modified_changes: false,
                        untracked_changes: false,
                    }),
                },
                conflict_marker_count: 2,
            }),
            starts_unselected: true,
        }],
        do_conflicted_files_exist: true,
    };

    let json = serde_json::to_string(&result).expect("serializes");
    let back: StatusResult = serde_json::from_str(&json).expect("deserializes");
    assert_eq!(back, result);
}

/// Writes the real serialized output of every boundary type to a snapshot the frontend checks
/// itself against.
///
/// This is the half the assertions above cannot cover. They compare Rust to JSON *authored here*;
/// this exports Rust's actual output so `src/lib/git-ipc.test.ts` can compare it to fixtures that
/// `tsc` has already checked against the ported `src/models/**` types.
///
/// Run with `UPDATE_WIRE_SNAPSHOT=1` to accept a deliberate change:
///
/// ```text
/// UPDATE_WIRE_SNAPSHOT=1 cargo test -p git-ops --test wire_contract
/// ```
///
/// The failure message is intentionally blunt about which side to fix, because "the snapshot
/// changed" is ambiguous on its own: a changed snapshot means either the Rust regressed or the
/// frontend fixtures are now stale, and only one of those is a bug.
#[test]
fn emits_the_wire_snapshot_the_frontend_checks_itself_against() {
    let mut cases: BTreeMap<&str, serde_json::Value> = BTreeMap::new();

    cases.insert(
        "modified",
        to_value(AppFileStatus::Modified {
            submodule_status: None,
        }),
    );
    cases.insert(
        "renamed",
        to_value(AppFileStatus::Renamed {
            old_path: "before".to_owned(),
            submodule_status: None,
            rename_includes_modifications: true,
        }),
    );
    cases.insert(
        "modifiedSubmodule",
        to_value(AppFileStatus::Modified {
            submodule_status: Some(SubmoduleStatus {
                commit_changed: false,
                modified_changes: true,
                untracked_changes: false,
            }),
        }),
    );
    cases.insert(
        "textConflict",
        to_value(AppFileStatus::Conflicted(
            ConflictedFileStatus::WithMarkers {
                entry: UnmergedEntry {
                    action: UnmergedEntrySummary::BothModified,
                    us: GitStatusEntry::UpdatedButUnmerged,
                    them: GitStatusEntry::UpdatedButUnmerged,
                    submodule_status: None,
                },
                conflict_marker_count: 3,
            },
        )),
    );
    cases.insert(
        "resolvedTextConflict",
        to_value(AppFileStatus::Conflicted(
            ConflictedFileStatus::WithMarkers {
                entry: UnmergedEntry {
                    action: UnmergedEntrySummary::BothAdded,
                    us: GitStatusEntry::Added,
                    them: GitStatusEntry::Added,
                    submodule_status: None,
                },
                conflict_marker_count: 0,
            },
        )),
    );
    cases.insert(
        "manualConflict",
        to_value(AppFileStatus::Conflicted(ConflictedFileStatus::Manual {
            entry: UnmergedEntry {
                action: UnmergedEntrySummary::DeletedByThem,
                us: GitStatusEntry::UpdatedButUnmerged,
                them: GitStatusEntry::Deleted,
                submodule_status: None,
            },
        })),
    );
    cases.insert(
        "statusResult",
        to_value(StatusResult {
            current_branch: Some("main".to_owned()),
            current_upstream_branch: Some("origin/main".to_owned()),
            current_tip: Some("abc123".to_owned()),
            branch_ahead_behind: Some(AheadBehind {
                ahead: 2,
                behind: 1,
            }),
            merge_head_found: false,
            squash_msg_found: false,
            rebase_internal_state: None,
            is_cherry_picking_head_found: false,
            files: vec![StatusFileChange {
                path: "src/thing.ts".to_owned(),
                status: AppFileStatus::Modified {
                    submodule_status: None,
                },
                starts_unselected: false,
            }],
            do_conflicted_files_exist: false,
        }),
    );
    cases.insert(
        "emptyStatusResult",
        to_value(StatusResult {
            current_branch: None,
            current_upstream_branch: None,
            current_tip: None,
            branch_ahead_behind: None,
            merge_head_found: false,
            squash_msg_found: false,
            rebase_internal_state: None,
            is_cherry_picking_head_found: false,
            files: Vec::new(),
            do_conflicted_files_exist: false,
        }),
    );

    let mut rendered = serde_json::to_string_pretty(&cases).expect("the snapshot serializes");
    rendered.push('\n');

    let path = snapshot_path();

    if std::env::var_os("UPDATE_WIRE_SNAPSHOT").is_some() {
        std::fs::create_dir_all(path.parent().expect("the snapshot has a parent directory"))
            .expect("failed to create the snapshot directory");
        std::fs::write(&path, &rendered).expect("failed to write the snapshot");
        return;
    }

    let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "could not read {}: {error}\n\nCreate it with:\n    \
             UPDATE_WIRE_SNAPSHOT=1 cargo test -p git-ops --test wire_contract",
            path.display()
        )
    });

    assert_eq!(
        committed,
        rendered,
        "\n\nThe serialized wire shape no longer matches {}.\n\n\
         If this change is deliberate, update the snapshot AND the fixtures in\n\
         src/lib/git-ipc.test.ts that mirror it — the TypeScript fixtures are what prove the new\n\
         shape still satisfies the ported src/models/** types:\n\n    \
         UPDATE_WIRE_SNAPSHOT=1 cargo test -p git-ops --test wire_contract\n\n\
         If it is not deliberate, the Rust types regressed.\n",
        path.display()
    );
}

fn to_value<T: serde::Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).expect("serializes")
}

/// The snapshot lives in the frontend tree because that is what consumes it.
fn snapshot_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        // crates/git-ops -> crates -> src-tauri -> repository root
        .join("../../../src/lib/__generated__/wire-snapshot.json")
}
