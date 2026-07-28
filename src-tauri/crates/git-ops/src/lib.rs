//! Git operations for rdc.
//!
//! Replaces `desktop-plus/app/src/lib/git/**` (45 modules built on `dugite`). Per
//! MIGRATION_PLAN.md Phase 2 this shells out to the user's `git` binary rather than linking
//! libgit2 — the same deliberate choice dugite made, because libgit2 has known gaps around LFS,
//! credential helpers, partial clone and hook execution.
//!
//! The acceptance spec is `desktop-plus/app/test/unit/git/**` (47 files); modules are ported
//! test-by-test, and `MIGRATION_MAP.md` tracks which are done.

#![warn(clippy::all)]

pub mod add;
pub mod branch;
pub mod checkout;
pub mod commit;
pub mod config;
pub mod diff;
pub mod diff_check;
pub mod diff_index;
pub mod diff_parser;
pub mod error;
pub mod exec;
pub mod git_delimiter_parser;
pub mod git_error_kind;
pub mod init;
pub mod interpret_trailers;
pub mod log;
pub mod merge;
pub mod operation_state;
pub mod rebase;
pub mod refs;
pub mod reset;
pub mod rev_list;
pub mod rev_parse;
pub mod rm;
pub mod show;
pub mod stage;
pub mod status;
pub mod status_parser;
pub mod terminal_output;
pub mod update_index;
pub mod update_ref;

#[cfg(test)]
mod test_support;

pub use add::add_conflicted_file;
pub use branch::{
    create_branch, delete_local_branch, get_branch_names, get_branches_pointed_at,
    get_merged_branches, rename_branch,
};
pub use checkout::{
    checkout_branch, checkout_branch_with_progress, checkout_commit, checkout_commit_with_progress,
    checkout_conflicted_file, checkout_paths, CheckoutProgress, CheckoutProgressKind,
    CheckoutTarget, ManualConflictResolution,
};
pub use commit::{create_commit, create_merge_commit, CommitOptions};
pub use config::{
    get_boolean_config_value, get_config_value, remove_config_value, set_config_value, GlobalConfig,
};
pub use diff::{
    get_binary_paths, get_commit_diff, get_commit_range_diff, get_working_directory_diff, Diff,
    DiffType, LineEnding, LineEndingsChange, SubmoduleDiffData, TextDiffData,
};
pub use diff_check::get_files_with_conflict_markers;
pub use diff_index::{get_index_changes, IndexStatus, NULL_TREE_SHA};
pub use diff_parser::{
    get_hunk_header_expansion_type, get_largest_line_number, parse_diff, DiffHunk,
    DiffHunkExpansionType, DiffHunkHeader, DiffLine, DiffLineType, RawDiff,
    DEFAULT_DIFF_EXPANSION_STEP,
};
pub use error::GitError;
pub use exec::{git, git_with_stderr, GitOptions, GitOutput, TERMINAL_OUTPUT_CAPACITY};
pub use git_delimiter_parser::ForEachRefParser;
pub use git_error_kind::{parse_bad_config_value, parse_error, BadConfigValue, GitErrorKind};
pub use init::init_repository;
pub use interpret_trailers::{
    get_trailer_separator_characters, merge_trailers, parse_raw_unfolded_trailers,
    parse_single_unfolded_trailer, parse_trailers, Trailer,
};
pub use log::{
    get_authors, get_changed_files, get_commit, get_commits, parse_raw_log_with_numstat,
    ChangesetData, Commit, CommitIdentity, CommittedFileChange,
};
pub use merge::{abort_merge, get_merge_base, merge, MergeOptions, MergeResult};
pub use operation_state::{
    get_rebase_internal_state, is_cherry_pick_head_found, is_merge_head_set, is_rebase_head_set,
    is_squash_msg_set, RebaseInternalState,
};
pub use rebase::{
    abort_rebase, continue_rebase, continue_rebase_with_progress, get_rebase_snapshot, rebase,
    rebase_with_progress, MultiCommitOperationProgress, MultiCommitOperationProgressKind,
    RebaseConflictResolution, RebaseResult, RebaseSnapshot,
};
pub use refs::{format_as_local_ref, get_symbolic_ref};
pub use reset::unstage_all;
pub use rev_list::{get_commits_between_commits, get_commits_in_range, CommitOneLine};
pub use rev_parse::{
    get_current_upstream_ref, get_current_upstream_remote_name, get_repository_type,
    get_upstream_ref_for_ref, get_upstream_remote_name_for_ref, resolve_git_dir, RepositoryType,
};
pub use rm::remove_conflicted_file;
pub use show::get_blob_contents;
pub use stage::{stage_manual_conflict_resolution, stage_manual_conflict_resolution_with_entries};
pub use status::{
    get_status, AheadBehind, AppFileStatus, ConflictedFileStatus, StatusFileChange, StatusResult,
};
pub use status_parser::{
    map_status, parse_porcelain_status, FileEntry, GitStatusEntry, OrdinaryChange, StatusEntry,
    StatusItem, SubmoduleStatus, UnmergedEntrySummary,
};
pub use terminal_output::{push_terminal_bytes, push_terminal_chunk};
pub use update_index::{stage_files, FileToStage};
pub use update_ref::delete_ref;
