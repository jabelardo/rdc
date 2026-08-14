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

use git_ops::checkout::{CheckoutProgress, CheckoutProgressKind};
use git_ops::cherry_pick::CherryPickResult;
use git_ops::clone::{CloneProgress, CloneProgressKind};
use git_ops::commit::CommitOptions;
use git_ops::diff::{
    Diff, ImageData, ImageDiffData, LineEnding, LineEndingsChange, SubmoduleDiffData, TextDiffData,
};
use git_ops::diff_index::IndexStatus;
use git_ops::diff_parser::parse_diff;
use git_ops::fetch::{FetchProgress, FetchProgressKind};
use git_ops::for_each_ref::{Branch, BranchAuthor, BranchTip, BranchType, TrackingBranch};
use git_ops::hooks::runner::{HookProgressUpdate, HookStatus};
use git_ops::interpret_trailers::Trailer;
use git_ops::log::{ChangesetData, Commit, CommitIdentity, CommittedFileChange};
use git_ops::merge::{MergeOptions, MergeResult};
use git_ops::merge_tree::MergeTreeResult;
use git_ops::pull::{PullProgress, PullProgressKind};
use git_ops::push::{PushProgress, PushProgressKind};
use git_ops::rebase::{
    ManualResolution, MultiCommitOperationProgress, MultiCommitOperationProgressKind, RebaseResult,
    RebaseSnapshot,
};
use git_ops::remote::Remote;
use git_ops::reset::ResetMode;
use git_ops::rev_list::CommitOneLine;
use git_ops::rev_parse::RepositoryType;
use git_ops::revert::{RevertProgress, RevertProgressKind};
use git_ops::stage::ManualConflictResolution;
use git_ops::stage::ResolvedConflict;
use git_ops::stash::{StashEntry, StashResult};
use git_ops::status::{
    AheadBehind, AppFileStatus, ConflictedFileStatus, StatusFileChange, StatusResult, UnmergedEntry,
};
use git_ops::status_parser::{GitStatusEntry, SubmoduleStatus, UnmergedEntrySummary};
use git_ops::submodule::SubmoduleEntry;
use git_ops::update_index::FileToStage;
use git_ops::worktree::{WorktreeEntry, WorktreeType};
use serde_json::json;

#[path = "../../../src/operation.rs"]
#[allow(dead_code)]
mod operation;
use operation::{
    CancellationCapability, GitOperationKind, OperationOutcome, OperationProgress, OperationRecord,
    OperationRefresh, OperationScope, OperationState,
};

// Platform commands live in the Tauri app rather than git-ops. Include the shared wire model from
// its source so this remains the one generated snapshot consumed by TypeScript.
#[path = "../../../src/platform/editor_model.rs"]
mod editor_model;
use editor_model::FoundEditor;
#[path = "../../../src/platform/custom_integration_model.rs"]
mod custom_integration_model;
use custom_integration_model::{CustomIntegration, CustomIntegrationPathValidation};
#[path = "../../../src/platform/keybinding_model.rs"]
mod keybinding_model;
use keybinding_model::{Keybinding, KeybindingModifier};
#[path = "../../../src/platform/menu_model.rs"]
mod menu_model;
use menu_model::{MenuAction, MenuItemModel, MenuKind, MenuModel};
#[path = "../../../src/platform/window_model.rs"]
mod window_model;
use window_model::WindowStartupAction;
#[path = "../../../src/platform/shell_model.rs"]
mod shell_model;
use shell_model::FoundShell;

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
    cases.insert(
        "checkoutProgress",
        to_value(CheckoutProgress {
            kind: CheckoutProgressKind::Checkout,
            value: 0.5,
            title: "Checking out branch topic".to_owned(),
            description: "Checking out files:  50% (1/2)".to_owned(),
            target: "topic".to_owned(),
        }),
    );
    let multi_commit_operation_progress = MultiCommitOperationProgress {
        kind: MultiCommitOperationProgressKind::MultiCommitOperation,
        value: 0.5,
        position: 1,
        total_commit_count: 2,
        current_commit_summary: "First".to_owned(),
    };
    cases.insert(
        "multiCommitOperationProgress",
        to_value(multi_commit_operation_progress.clone()),
    );
    cases.insert(
        "rebaseSnapshot",
        to_value(RebaseSnapshot {
            progress: multi_commit_operation_progress,
            commits: vec![
                CommitOneLine {
                    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    summary: "First".to_owned(),
                },
                CommitOneLine {
                    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
                    summary: "Second".to_owned(),
                },
            ],
        }),
    );
    cases.insert("mergeResult", to_value(MergeResult::AlreadyUpToDate));
    cases.insert("rebaseResult", to_value(RebaseResult::ConflictsEncountered));

    // A parsed diff, from the real parser rather than a hand-built value. Two hunks far enough
    // apart to exercise both expansion types, a delete/add pair, and a missing trailing newline —
    // so the snapshot pins the numeric `DiffLineType`, the explicit nulls, and the fact that
    // `expansionType` and `maxLineNumber` are computed identically to the TypeScript copies of
    // those rules in `src/lib/diff-hunks.ts`.
    cases.insert(
        "parsedDiff",
        to_value(
            parse_diff(concat!(
                "diff --git a/test.txt b/test.txt\n",
                "index 1910281..257cc56 100644\n",
                "--- a/test.txt\n",
                "+++ b/test.txt\n",
                "@@ -10,2 +10,2 @@ fn context()\n",
                " unchanged\n",
                "-before\n",
                "+after\n",
                "@@ -100,1 +100,1 @@\n",
                "-last\n",
                "\\ No newline at end of file\n",
                "+last line\n",
            ))
            .expect("the fixture parses"),
        ),
    );

    // History. Built directly rather than by running git, so the snapshot stays deterministic.
    // `parentSHAs` is the one field whose JSON name isn't plain camelCase — the TypeScript class
    // spells it that way, and the frontend passes it straight to the constructor.
    cases.insert(
        "commit",
        to_value(Commit {
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            short_sha: "aaaaaaa".to_owned(),
            summary: "Fix the thing".to_owned(),
            body: "With a longer explanation.\n\nCo-Authored-By: Someone <someone@example.com>"
                .to_owned(),
            author: CommitIdentity {
                name: "Author Name".to_owned(),
                email: "author@example.com".to_owned(),
                date: 1_475_670_580,
                tz_offset: 120,
            },
            committer: CommitIdentity {
                name: "Committer Name".to_owned(),
                email: "committer@example.com".to_owned(),
                date: 1_475_670_600,
                tz_offset: -480,
            },
            parent_shas: vec!["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned()],
            trailers: vec![Trailer {
                token: "Co-Authored-By".to_owned(),
                value: "Someone <someone@example.com>".to_owned(),
            }],
            tags: vec!["v1.0".to_owned()],
        }),
    );
    cases.insert(
        "changesetData",
        to_value(ChangesetData {
            files: vec![
                CommittedFileChange {
                    path: "src/thing.ts".to_owned(),
                    status: AppFileStatus::Modified {
                        submodule_status: None,
                    },
                    commitish: "aaaaaaa".to_owned(),
                    parent_commitish: "aaaaaaa^".to_owned(),
                },
                CommittedFileChange {
                    path: "after".to_owned(),
                    status: AppFileStatus::Renamed {
                        old_path: "before".to_owned(),
                        submodule_status: None,
                        rename_includes_modifications: true,
                    },
                    commitish: "aaaaaaa".to_owned(),
                    parent_commitish: "aaaaaaa^".to_owned(),
                },
            ],
            lines_added: 12,
            lines_deleted: 3,
        }),
    );

    // Index changes: pairs, with the status as a numeric discriminant rather than a name.
    cases.insert(
        "indexChanges",
        to_value(vec![
            ("src/thing.ts".to_owned(), IndexStatus::Modified),
            ("added.ts".to_owned(), IndexStatus::Added),
            ("gone.ts".to_owned(), IndexStatus::Deleted),
        ]),
    );

    // The `IDiff` union. `kind` is numeric, and Text/LargeText are distinguished by it alone, which
    // is why `Diff` serializes by hand rather than with serde's internally-tagged representation.
    let text_data = TextDiffData {
        text: "@@ -1 +1 @@\n-old\n+new".to_owned(),
        hunks: parse_diff(concat!(
            "diff --git a/a.txt b/a.txt\n",
            "index 1910281..257cc56 100644\n",
            "--- a/a.txt\n",
            "+++ b/a.txt\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n",
        ))
        .expect("the fixture parses")
        .hunks,
        line_endings_change: None,
        max_line_number: 1,
        has_hidden_bidi_chars: false,
    };

    cases.insert("textDiff", to_value(Diff::Text(text_data.clone())));
    cases.insert(
        "textDiffWithLineEndingsChange",
        to_value(Diff::Text(TextDiffData {
            line_endings_change: Some(LineEndingsChange {
                from: LineEnding::LF,
                to: LineEnding::CRLF,
            }),
            ..text_data.clone()
        })),
    );
    cases.insert("largeTextDiff", to_value(Diff::LargeText(text_data)));
    cases.insert("binaryDiff", to_value(Diff::Binary));
    cases.insert("unrenderableDiff", to_value(Diff::Unrenderable));
    cases.insert(
        "submoduleDiff",
        to_value(Diff::Submodule(SubmoduleDiffData {
            full_path: "/repo/sub".to_owned(),
            path: "sub".to_owned(),
            url: Some("https://example.invalid/sub.git".to_owned()),
            status: SubmoduleStatus {
                commit_changed: true,
                modified_changes: false,
                untracked_changes: false,
            },
            old_sha: Some("a".repeat(40)),
            new_sha: Some("b".repeat(40)),
        })),
    );

    // The three remote progress shapes. `description` is absent on the initial update and present
    // afterwards, so both are pinned — it is optional in the ported model, so absent must mean absent
    // rather than null.
    cases.insert(
        "pushProgressInitial",
        to_value(PushProgress {
            kind: PushProgressKind::Push,
            value: 0.0,
            title: "Pushing to origin".to_owned(),
            description: None,
            remote: "origin".to_owned(),
            branch: "main".to_owned(),
        }),
    );
    cases.insert(
        "pushProgress",
        to_value(PushProgress {
            kind: PushProgressKind::Push,
            value: 0.62,
            title: "Pushing to origin".to_owned(),
            description: Some("Writing objects:  60% (3/5)".to_owned()),
            remote: "origin".to_owned(),
            branch: "main".to_owned(),
        }),
    );
    cases.insert(
        "fetchProgress",
        to_value(FetchProgress {
            kind: FetchProgressKind::Fetch,
            value: 0.45,
            title: "Fetching origin".to_owned(),
            description: Some("Receiving objects:  50% (1/2)".to_owned()),
            remote: "origin".to_owned(),
        }),
    );
    cases.insert(
        "pullProgress",
        to_value(PullProgress {
            kind: PullProgressKind::Pull,
            value: 0.5,
            title: "Pulling origin".to_owned(),
            description: Some("Receiving objects:  50% (1/2)".to_owned()),
            remote: "origin".to_owned(),
        }),
    );

    // A clone reports no remote — it has none configured yet — which is the one way its progress
    // differs from push/fetch/pull.
    cases.insert(
        "cloneProgress",
        to_value(CloneProgress {
            kind: CloneProgressKind::Clone,
            value: 0.35,
            title: "Cloning into /home/me/r".to_owned(),
            description: Some("Receiving objects:  50% (1/2)".to_owned()),
        }),
    );
    cases.insert(
        "remote",
        to_value(Remote {
            name: "origin".to_owned(),
            url: "https://github.com/o/r.git".to_owned(),
        }),
    );

    cases.insert(
        "stashResult",
        to_value(StashResult {
            desktop_entries: vec![StashEntry {
                name: "refs/stash@{0}".to_owned(),
                branch_name: "main".to_owned(),
                custom_name: Some("my work".to_owned()),
                stash_sha: "a".repeat(40),
                created_at: 1_475_670_580,
                tree: "b".repeat(40),
                parents: vec!["c".repeat(40)],
            }],
            stash_entry_count: 3,
        }),
    );
    cases.insert(
        "stashEntryWithoutCustomName",
        to_value(StashEntry {
            name: "refs/stash@{1}".to_owned(),
            branch_name: "feature".to_owned(),
            custom_name: None,
            stash_sha: "d".repeat(40),
            created_at: 1_475_670_000,
            tree: "e".repeat(40),
            parents: Vec::new(),
        }),
    );
    cases.insert(
        "cherryPickResult",
        to_value(CherryPickResult::ConflictsEncountered),
    );

    // Image diffs. Both sides present for a modified image; the SVG case additionally carries the text diff,
    // which is what lets the viewer offer a "Code" tab. A URL rather than base64 — see `blob_protocol.rs`.
    cases.insert(
        "imageDiff",
        to_value(Diff::Image(ImageDiffData {
            previous: Some(ImageData {
                url: "rdc-blob://localhost/0123456789abcdef0123456789abcdef".to_owned(),
                media_type: "image/png".to_owned(),
                bytes: 2048,
            }),
            current: Some(ImageData {
                url: "rdc-blob://localhost/fedcba9876543210fedcba9876543210".to_owned(),
                media_type: "image/png".to_owned(),
                bytes: 4096,
            }),
            text_diff: None,
        })),
    );
    cases.insert(
        "addedImageDiff",
        to_value(Diff::Image(ImageDiffData {
            previous: None,
            current: Some(ImageData {
                url: "rdc-blob://localhost/00000000000000000000000000000001".to_owned(),
                media_type: "image/webp".to_owned(),
                bytes: 128,
            }),
            text_diff: None,
        })),
    );
    cases.insert(
        "svgImageDiff",
        to_value(Diff::Image(ImageDiffData {
            previous: None,
            current: Some(ImageData {
                url: "rdc-blob://localhost/00000000000000000000000000000002".to_owned(),
                media_type: "image/svg+xml".to_owned(),
                bytes: 64,
            }),
            text_diff: Some(TextDiffData {
                text: "@@ -0,0 +1 @@\n+<svg/>\n".to_owned(),
                hunks: Vec::new(),
                line_endings_change: None,
                max_line_number: 1,
                has_hidden_bidi_chars: false,
            }),
        })),
    );

    // The shapes the Phase 3 expose-only batches put on the wire for the first time.
    cases.insert(
        "repositoryTypeRegular",
        to_value(RepositoryType::Regular {
            top_level_working_directory: std::path::PathBuf::from("/repos/thing"),
            git_dir: std::path::PathBuf::from("/repos/thing/.git"),
        }),
    );
    cases.insert(
        "repositoryTypeUnsafe",
        to_value(RepositoryType::Unsafe {
            path: std::path::PathBuf::from("/repos/borrowed"),
        }),
    );
    cases.insert("repositoryTypeMissing", to_value(RepositoryType::Missing));
    cases.insert(
        "mergeTreeConflicts",
        to_value(MergeTreeResult::Conflicts {
            conflicted_files: 3,
        }),
    );
    cases.insert("mergeTreeClean", to_value(MergeTreeResult::Clean));
    cases.insert(
        "worktreeEntry",
        to_value(WorktreeEntry {
            path: std::path::PathBuf::from("/repos/thing"),
            head: "a".repeat(40),
            branch: Some("refs/heads/main".to_owned()),
            is_detached: false,
            kind: WorktreeType::Main,
            is_locked: false,
            is_prunable: false,
        }),
    );
    cases.insert(
        "trailer",
        to_value(Trailer {
            token: "Co-Authored-By".to_owned(),
            value: "Someone <someone@example.invalid>".to_owned(),
        }),
    );

    // Hook progress. The status strings are the original's (`'started' | 'finished' | 'failed'`), and the
    // `id` exists because a `HookAbort` is a live handle rather than data — see `src/hook_state.rs`.
    cases.insert(
        "hookProgress",
        to_value(HookProgressUpdate {
            id: 3,
            hook: "pre-commit".to_owned(),
            status: HookStatus::Started,
        }),
    );

    // The branch list. `type` is a numeric enum, `upstream` is `string | null` rather than optional,
    // and both `type` and `ref` are Rust keywords renamed on the way out — so all three are worth
    // pinning. The frontend builds the `Branch` class from these, which is what checks the shape.
    cases.insert(
        "branch",
        to_value(Branch {
            name: "main".to_owned(),
            upstream: Some("origin/main".to_owned()),
            tip: BranchTip {
                sha: "a".repeat(40),
                author: BranchAuthor {
                    date: 1_611_312_328,
                },
            },
            branch_type: BranchType::Local,
            canonical_ref: "refs/heads/main".to_owned(),
            is_gone: false,
        }),
    );
    cases.insert(
        "goneBranch",
        to_value(Branch {
            name: "topic".to_owned(),
            upstream: Some("origin/topic".to_owned()),
            tip: BranchTip {
                sha: "b".repeat(40),
                author: BranchAuthor {
                    date: 1_611_312_400,
                },
            },
            branch_type: BranchType::Local,
            canonical_ref: "refs/heads/topic".to_owned(),
            is_gone: true,
        }),
    );
    cases.insert(
        "remoteBranch",
        to_value(Branch {
            name: "origin/main".to_owned(),
            upstream: None,
            tip: BranchTip {
                sha: "c".repeat(40),
                author: BranchAuthor {
                    date: 1_611_312_328,
                },
            },
            branch_type: BranchType::Remote,
            canonical_ref: "refs/remotes/origin/main".to_owned(),
            is_gone: false,
        }),
    );
    cases.insert(
        "trackingBranch",
        to_value(TrackingBranch {
            canonical_ref: "refs/heads/behind".to_owned(),
            sha: "d".repeat(40),
            upstream_ref: "refs/remotes/origin/behind".to_owned(),
            upstream_sha: "e".repeat(40),
        }),
    );
    cases.insert(
        "foundEditor",
        to_value(FoundEditor {
            editor: "Visual Studio Code".to_owned(),
            path: PathBuf::from("/usr/bin/code"),
        }),
    );
    cases.insert(
        "foundShell",
        to_value(FoundShell {
            shell: "GNOME Terminal".to_owned(),
            path: PathBuf::from("/usr/bin/gnome-terminal"),
            bundle_id: None,
            extra_args: None,
        }),
    );
    cases.insert(
        "keybindings",
        to_value(BTreeMap::from([(
            "pull".to_owned(),
            Keybinding {
                modifiers: vec![KeybindingModifier::Control, KeybindingModifier::Shift],
                key: "KeyP".to_owned(),
            },
        )])),
    );
    cases.insert(
        "appMenu",
        to_value(MenuModel {
            kind: MenuKind::Menu,
            id: None,
            items: vec![MenuItemModel::MenuItem {
                id: "pull".to_owned(),
                enabled: true,
                visible: true,
                label: "Pull".to_owned(),
                access_key: None,
                action: Some(MenuAction::MenuEvent {
                    event: "pull".to_owned(),
                }),
                role: None,
            }],
        }),
    );
    cases.insert(
        "windowStartupAction",
        to_value(WindowStartupAction::open_repository("/repo/../repo")),
    );
    cases.insert(
        "customIntegrationPathValidation",
        to_value(CustomIntegrationPathValidation {
            is_valid: true,
            bundle_id: Some("com.example.Editor".to_owned()),
        }),
    );

    // Both submodule shapes: git omits the describe value for an uninitialized or conflicted
    // submodule, and those entries must still be listed.
    cases.insert(
        "submoduleEntry",
        to_value(SubmoduleEntry {
            sha: "a".repeat(40),
            path: "sub".to_owned(),
            describe: Some("v1.0".to_owned()),
        }),
    );
    cases.insert(
        "uninitializedSubmoduleEntry",
        to_value(SubmoduleEntry {
            sha: "b".repeat(40),
            path: "other".to_owned(),
            describe: None,
        }),
    );

    // Revert progress always reports zero — upstream's parser could never compute a percentage. See
    // `git_ops::revert`.
    cases.insert(
        "revertProgress",
        to_value(RevertProgress {
            kind: RevertProgressKind::Revert,
            value: 0.0,
            title: String::new(),
            description: Some("Auto-merging a.txt".to_owned()),
        }),
    );

    cases.insert(
        "operationRecord",
        to_value(OperationRecord {
            id: "operation-1".to_owned(),
            scope: OperationScope::Repository {
                lock_key: "/repo/.git".to_owned(),
                repository_path: "/repo".to_owned(),
            },
            owner_window: Some("repository-1".to_owned()),
            operation: GitOperationKind::Fetch,
            state: OperationState::Running,
            cancellation: CancellationCapability::Available {
                label: "Cancel fetch".to_owned(),
            },
            progress: Some(OperationProgress {
                value: 0.45,
                title: Some("Fetching origin".to_owned()),
                description: None,
            }),
            hook: None,
            last_activity_at: 1_723_379_200_000,
            outcome: Some(OperationOutcome::Unchanged),
            error: None,
            refresh: Some(OperationRefresh {
                remote_names: vec!["origin".to_owned()],
                repository_facts: true,
            }),
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

// --- the other direction: types the frontend sends *in* ---
//
// The snapshot above covers what Rust serializes. Command *arguments* travel the other way, so what
// matters for them is that Rust can deserialize what the frontend sends. These tests are written as
// the literal JSON `invoke` would produce, so a `#[serde]` change that breaks an argument fails here
// rather than at runtime with a Tauri deserialization error.

#[test]
fn a_file_to_stage_accepts_the_minimal_object() {
    // Optional index details have serde defaults, so the frontend can send just a path.
    let parsed: FileToStage =
        serde_json::from_value(json!({ "path": "src/thing.ts" })).expect("deserializes");

    assert_eq!(parsed, FileToStage::new("src/thing.ts"));
    assert_eq!(parsed.old_path, None);
    assert!(!parsed.deleted);
    assert_eq!(parsed.partial, None);
}

#[test]
fn platform_command_arguments_accept_the_typescript_domain_shapes() {
    let editor: FoundEditor = serde_json::from_value(json!({
        "editor": "Visual Studio Code",
        "path": "/usr/bin/code",
    }))
    .expect("found editor deserializes");
    assert_eq!(editor.editor, "Visual Studio Code");
    assert_eq!(editor.path, PathBuf::from("/usr/bin/code"));

    let custom: CustomIntegration = serde_json::from_value(json!({
        "path": "/Applications/Custom.app",
        "arguments": "--wait \"%TARGET_PATH%\"",
        "bundleID": "example.Custom",
    }))
    .expect("custom integration deserializes");
    assert_eq!(custom.path, PathBuf::from("/Applications/Custom.app"));
    assert_eq!(custom.arguments, "--wait \"%TARGET_PATH%\"");
    assert_eq!(custom.bundle_id.as_deref(), Some("example.Custom"));

    let shell: FoundShell = serde_json::from_value(json!({
        "shell": "Command Prompt",
        "path": "C:\\Windows\\System32\\cmd.exe",
        "extraArgs": ["/K", "doskey git=git.exe $*"],
    }))
    .expect("found shell deserializes");
    assert_eq!(shell.shell, "Command Prompt");
    assert_eq!(
        shell.extra_args.as_deref(),
        Some(["/K".to_owned(), "doskey git=git.exe $*".to_owned()].as_slice())
    );

    let menu: MenuModel = serde_json::from_value(json!({
        "type": "menu",
        "items": [{
            "id": "pull",
            "type": "menuItem",
            "label": "Pull",
            "enabled": true,
            "visible": true,
            "accessKey": null,
            "action": { "type": "menu-event", "event": "pull" },
        }],
    }))
    .expect("application menu deserializes");
    assert_eq!(menu.items.len(), 1);
}

#[test]
fn a_file_to_stage_round_trips_a_rename_and_a_deletion() {
    let renamed: FileToStage =
        serde_json::from_value(json!({ "path": "after", "oldPath": "before" }))
            .expect("deserializes");
    assert_eq!(renamed, FileToStage::renamed("after", "before"));

    let deleted: FileToStage =
        serde_json::from_value(json!({ "path": "gone", "deleted": true })).expect("deserializes");
    assert_eq!(deleted, FileToStage::deleted("gone"));
}

#[test]
fn a_file_to_stage_accepts_a_partial_line_selection() {
    let parsed: FileToStage = serde_json::from_value(json!({
        "path": "src/thing.ts",
        "partial": {
            "status": { "kind": "Modified" },
            "selectedLines": [2, 3, 7],
        },
    }))
    .expect("deserializes");

    assert_eq!(
        parsed,
        FileToStage::partial(
            "src/thing.ts",
            AppFileStatus::Modified {
                submodule_status: None,
            },
            [2, 3, 7],
        )
    );
}

#[test]
fn an_image_diff_round_trips() {
    // `kind` is the numeric 1, and the two sides are omitted rather than null when absent — the shape
    // `IImageDiff` declares. A round trip proves the hand-written serializer and deserializer agree.
    let diff = Diff::Image(ImageDiffData {
        previous: None,
        current: Some(ImageData {
            url: "rdc-blob://localhost/abc".to_owned(),
            media_type: "image/png".to_owned(),
            bytes: 7,
        }),
        text_diff: None,
    });

    let json = to_value(diff.clone());
    assert_eq!(json["kind"], 1, "DiffType.Image");
    assert!(
        json.get("previous").is_none(),
        "an added image has no previous side: {json}"
    );

    let back: Diff = serde_json::from_value(json).expect("deserializes");
    assert_eq!(back, diff);
}

#[test]
fn a_text_diff_can_be_sent_back_as_a_command_argument() {
    // `discard_changes_from_selection` takes the diff the user was looking at, so the exact payload
    // Rust serialized has to deserialize again — the frontend hydrates it into classes in between and
    // `dehydrateTextDiff` reverses that. A field this side renames without the other following would
    // fail here rather than at runtime.
    if std::env::var_os("UPDATE_WIRE_SNAPSHOT").is_some() {
        // The snapshot writer is rewriting the file in a sibling test right now, so reading it here
        // would race. What this test checks is the committed bytes, which an update run is replacing
        // anyway.
        return;
    }

    let committed = std::fs::read_to_string(snapshot_path()).expect("the snapshot is committed");
    let snapshot: serde_json::Value =
        serde_json::from_str(&committed).expect("the snapshot is valid JSON");
    let sent = snapshot
        .get("textDiff")
        .expect("the snapshot has a text diff")
        .clone();

    let parsed: TextDiffData =
        serde_json::from_value(sent.clone()).expect("a serialized text diff deserializes");

    assert_eq!(to_value(Diff::Text(parsed)), sent, "round trips unchanged");
}

#[test]
fn reset_modes_are_the_numbers_the_typescript_enum_declares() {
    // `GitResetMode` is a numeric enum, so the discriminant is the wire value — and `Hard` being 0 matters:
    // a missing or zeroed field selects the destructive mode, which is why nothing gives it a default.
    for (mode, discriminant) in [
        (ResetMode::Hard, 0),
        (ResetMode::Soft, 1),
        (ResetMode::Mixed, 2),
    ] {
        assert_eq!(to_value(mode), json!(discriminant));
        assert_eq!(
            serde_json::from_value::<ResetMode>(json!(discriminant)).expect("deserializes"),
            mode
        );
    }
}

#[test]
fn a_resolved_conflict_accepts_the_minimal_object() {
    // Every field but the path has a serde default, so the frontend sends only what it knows.
    let parsed: ResolvedConflict =
        serde_json::from_value(json!({ "path": "a.txt" })).expect("deserializes");

    assert_eq!(parsed.path, "a.txt");
    assert_eq!(parsed.entries, None);
    assert_eq!(parsed.conflict_marker_count, None);
    assert_eq!(parsed.resolution, None);
}

#[test]
fn a_resolved_conflict_carries_a_marker_count_or_a_chosen_side() {
    let edited: ResolvedConflict =
        serde_json::from_value(json!({ "path": "a.txt", "conflictMarkerCount": 0 }))
            .expect("deserializes");
    assert_eq!(edited.conflict_marker_count, Some(0));

    // The entries cross as the **single characters** git's porcelain uses, which is what the ported
    // `GitStatusEntry` in `src/models/status.ts` declares — not the Rust variant names.
    let picked: ResolvedConflict = serde_json::from_value(json!({
        "path": "a.txt",
        "resolution": "theirs",
        "entries": ["U", "D"],
    }))
    .expect("deserializes");
    assert_eq!(picked.resolution, Some(ManualConflictResolution::Theirs));
    assert_eq!(
        picked.entries,
        Some((GitStatusEntry::UpdatedButUnmerged, GitStatusEntry::Deleted))
    );
}

#[test]
fn commit_options_default_every_flag_to_off() {
    // The frontend may omit the whole object or any subset of its fields.
    let empty: CommitOptions = serde_json::from_value(json!({})).expect("deserializes");
    assert_eq!(empty, CommitOptions::default());

    let partial: CommitOptions =
        serde_json::from_value(json!({ "allowEmpty": true })).expect("deserializes");
    assert_eq!(
        partial,
        CommitOptions {
            allow_empty: true,
            ..CommitOptions::default()
        }
    );
}

#[test]
fn commit_options_field_names_are_camel_case() {
    let options: CommitOptions = serde_json::from_value(json!({
        "amend": true,
        "noVerify": true,
        "signOff": true,
        "allowEmpty": true,
    }))
    .expect("deserializes");

    assert_eq!(
        options,
        CommitOptions {
            amend: true,
            no_verify: true,
            sign_off: true,
            allow_empty: true,
        }
    );
}

#[test]
fn a_manual_conflict_resolution_is_the_git_flag_name() {
    // These are passed to git as `--ours`/`--theirs`, and must match the ported TypeScript enum's
    // values in `src/models/manual-conflict-resolution.ts`.
    assert_eq!(
        serde_json::from_value::<ManualConflictResolution>(json!("ours")).expect("deserializes"),
        ManualConflictResolution::Ours
    );
    assert_eq!(
        serde_json::from_value::<ManualConflictResolution>(json!("theirs")).expect("deserializes"),
        ManualConflictResolution::Theirs
    );
    assert!(
        serde_json::from_value::<ManualConflictResolution>(json!("Ours")).is_err(),
        "the values are lowercase; a capitalized variant name is not accepted"
    );
}

#[test]
fn manual_resolutions_arrive_as_pairs() {
    // `create_merge_commit` takes a list of [path, resolution] pairs rather than an object, because a
    // repository path is an arbitrary byte string and so is not a safe JavaScript object key.
    let parsed: Vec<(String, ManualConflictResolution)> =
        serde_json::from_value(json!([["a.txt", "ours"], ["b.txt", "theirs"]]))
            .expect("deserializes");

    assert_eq!(
        parsed,
        vec![
            ("a.txt".to_owned(), ManualConflictResolution::Ours),
            ("b.txt".to_owned(), ManualConflictResolution::Theirs),
        ]
    );
}

#[test]
fn conflict_index_entries_arrive_as_a_pair_of_status_characters() {
    let parsed: (GitStatusEntry, GitStatusEntry) =
        serde_json::from_value(json!(["U", "D"])).expect("deserializes");

    assert_eq!(
        parsed,
        (GitStatusEntry::UpdatedButUnmerged, GitStatusEntry::Deleted)
    );
}

#[test]
fn merge_options_accept_an_omitted_or_partial_object() {
    let empty: MergeOptions = serde_json::from_value(json!({})).expect("deserializes");
    assert_eq!(empty, MergeOptions::default());

    let partial: MergeOptions =
        serde_json::from_value(json!({ "noVerify": true })).expect("deserializes");
    assert_eq!(
        partial,
        MergeOptions {
            squash: false,
            no_verify: true,
        }
    );
}

#[test]
fn a_manual_resolution_matches_the_frontend_shape() {
    let parsed: ManualResolution = serde_json::from_value(json!({
        "path": "conflicted.txt",
        "resolution": "theirs",
        "entries": ["U", "D"],
    }))
    .expect("deserializes");

    assert_eq!(
        parsed,
        ManualResolution {
            path: "conflicted.txt".to_owned(),
            resolution: ManualConflictResolution::Theirs,
            entries: Some((GitStatusEntry::UpdatedButUnmerged, GitStatusEntry::Deleted)),
        }
    );

    // `entries` is optional on the wire, so a caller without the status to hand can omit it. It
    // deserializes to `None` rather than failing — which is why the field carries `serde(default)`.
    let without_entries: ManualResolution = serde_json::from_value(json!({
        "path": "conflicted.txt",
        "resolution": "ours",
    }))
    .expect("deserializes without entries");

    assert_eq!(without_entries.entries, None);
}

#[test]
fn operation_results_are_string_enum_values() {
    assert_eq!(
        serde_json::to_value(MergeResult::Failed).expect("serializes"),
        json!("Failed")
    );
    assert_eq!(
        serde_json::to_value(RebaseResult::OutstandingFilesNotStaged).expect("serializes"),
        json!("OutstandingFilesNotStaged")
    );
}
