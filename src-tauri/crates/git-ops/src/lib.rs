//! Git operations for rdc.
//!
//! Replaces `desktop-plus/app/src/lib/git/**` (45 modules built on `dugite`). Per
//! MIGRATION_PLAN.md Phase 2 this shells out to the user's `git` binary rather than linking
//! libgit2 — the same deliberate choice dugite made, because libgit2 has known gaps around LFS,
//! credential helpers, partial clone and hook execution.
//!
//! The acceptance spec is `desktop-plus/app/test/unit/git/**` (45 files); modules are ported
//! test-by-test, and `MIGRATION_MAP.md` tracks which are done.

#![warn(clippy::all)]

pub mod add;
pub mod apply;
pub mod authentication;
pub mod branch;
pub mod checkout;
pub mod checkout_index;
pub mod cherry_pick;
pub mod clean;
pub mod clone;
pub mod commit;
pub mod config;
pub mod description;
pub mod diff;
pub mod diff_check;
pub mod diff_index;
pub mod diff_parser;
pub mod error;
pub mod exec;
pub mod fetch;
pub mod for_each_ref;
pub mod format_patch;
pub mod git_delimiter_parser;
pub mod git_error_kind;
pub mod gitignore;
pub mod hooks;
pub mod init;
pub mod interpret_trailers;
pub mod lfs;
pub mod log;
pub mod merge;
pub mod merge_tree;
pub mod multi_operation_terminal_output;
pub mod operation_identity;
pub mod operation_state;
pub mod patch_formatter;
pub mod progress;
pub mod pull;
pub mod push;
pub mod rebase;
pub mod reflog;
pub mod refs;
pub mod remote;
pub(crate) mod remote_progress;
pub mod reorder;
pub mod reset;
pub mod rev_list;
pub mod rev_parse;
pub mod revert;
pub mod rm;
pub mod show;
pub mod squash;
pub mod stage;
pub mod stash;
pub mod status;
pub mod status_parser;
pub mod submodule;
pub mod tag;
pub mod terminal_output;
pub mod update_index;
pub mod update_ref;
pub mod var;
pub mod worktree;
pub mod worktree_include;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use add::add_conflicted_file;
pub use apply::{apply_patch_to_index, discard_changes_from_selection};
pub use authentication::{env_for_authentication, AUTHENTICATION_ERRORS};
pub use branch::{
    create_branch, delete_local_branch, delete_remote_branch, get_branch_names,
    get_branches_pointed_at, get_merged_branches, rename_branch,
};
pub use checkout::{
    checkout_branch, checkout_branch_with_progress, checkout_commit, checkout_commit_with_progress,
    checkout_conflicted_file, checkout_paths, get_checkout_snapshot, CheckoutProgress,
    CheckoutProgressKind, CheckoutSnapshot, CheckoutTarget, ManualConflictResolution,
};
pub use checkout_index::checkout_index;
pub use cherry_pick::{
    abort_cherry_pick, cherry_pick, continue_cherry_pick, get_cherry_pick_snapshot,
    CherryPickResult, CherryPickSnapshot,
};
pub use clean::clean_untracked_files;
pub use clone::{clone, CloneOptions, CloneProgress, CloneProgressKind};
pub use commit::{create_commit, create_merge_commit, CommitOptions};
pub use config::{
    get_boolean_config_value, get_config_value, remove_config_value, set_config_value, GlobalConfig,
};
pub use description::{get_description, write_description, DEFAULT_DESCRIPTION};
pub use diff::{
    get_binary_paths, get_branch_merge_base_changed_files, get_branch_merge_base_diff,
    get_commit_diff, get_commit_range_changed_files, get_commit_range_diff, get_resolution_diff,
    get_working_directory_diff, Diff, DiffType, LineEnding, LineEndingsChange, ResolutionDiff,
    ResolutionDiffTarget, SubmoduleDiffData, TextDiffData,
};
pub use diff_check::get_files_with_conflict_markers;
pub use diff_index::{get_index_changes, IndexStatus, NULL_TREE_SHA};
pub use diff_parser::{
    get_hunk_header_expansion_type, get_largest_line_number, parse_diff, DiffHunk,
    DiffHunkExpansionType, DiffHunkHeader, DiffLine, DiffLineType, RawDiff,
    DEFAULT_DIFF_EXPANSION_STEP,
};
pub use error::{GitError, TerminationReason};
pub use exec::{
    git, git_capped, git_with_stderr, CappedOutput, GitOptions, GitOutput, TERMINAL_OUTPUT_CAPACITY,
};
pub use fetch::{
    fast_forward_branches, fetch, fetch_controlled, fetch_refspec, FetchProgress, FetchProgressKind,
};
pub use format_patch::format_commit_range_patch;
pub use git_delimiter_parser::ForEachRefParser;
pub use git_error_kind::{parse_bad_config_value, parse_error, BadConfigValue, GitErrorKind};
pub use gitignore::{
    append_ignore_files, append_ignore_rules, escape_git_special_characters,
    read_gitignore_at_root, save_gitignore,
};
pub use init::init_repository;
pub use interpret_trailers::{
    get_trailer_separator_characters, merge_trailers, parse_raw_unfolded_trailers,
    parse_single_unfolded_trailer, parse_trailers, Trailer,
};
pub use lfs::{
    files_not_tracked_by_lfs, install_global_lfs_filters, install_lfs_hooks, is_tracked_by_lfs,
    is_using_lfs,
};
pub use log::{
    get_authors, get_changed_files, get_commit, get_commits, parse_raw_log_with_numstat,
    ChangesetData, Commit, CommitIdentity, CommittedFileChange,
};
pub use merge::{abort_merge, get_merge_base, merge, MergeOptions, MergeResult};
pub use merge_tree::{determine_mergeability, MergeTreeResult};
pub use multi_operation_terminal_output::{
    MultiOperationTerminalOutput, TerminalOutputSubscription,
};
pub use operation_identity::{
    clone_destination_lock_key, resolve_repository_identity, RepositoryIdentity,
};
pub use operation_state::{
    get_rebase_internal_state, is_cherry_pick_head_found, is_merge_head_set, is_rebase_head_set,
    is_squash_msg_set, RebaseInternalState,
};
pub use patch_formatter::{format_patch, format_patch_to_discard_changes, LineSelection};
pub use progress::{
    parse_progress_line, GitLfsProgressParser, GitProgress, GitProgressInfo, GitProgressParser,
    ProgressLineSplitter, ProgressStep,
};
pub use pull::{pull, PullProgress, PullProgressKind};
pub use push::{push, PushOptions, PushProgress, PushProgressKind, PushTarget};
pub use rebase::{
    abort_rebase, continue_rebase, continue_rebase_with_progress, get_rebase_snapshot, rebase,
    rebase_with_progress, ManualResolution, MultiCommitOperationProgress,
    MultiCommitOperationProgressKind, RebaseResult, RebaseSnapshot,
};
pub use rebase::{rebase_interactive, render_todo, TodoAction, TodoStep};
pub use reflog::{get_branch_checkouts, get_recent_branches};
pub use refs::{format_as_local_ref, get_symbolic_ref};
pub use remote::{
    add_remote, get_remote_branch_sha, get_remote_head, get_remote_ref_sha, get_remote_url,
    get_remotes, remove_remote, set_remote_url, update_remote_head, Remote,
};
pub use reorder::{build_reorder_todo, reorder, ReorderError};
pub use reset::{reset, reset_paths, unstage_all, ResetMode};
pub use rev_list::{
    get_ahead_behind, get_commits_between_commits, get_commits_in_range, CommitOneLine,
};
pub use rev_parse::{
    get_current_upstream_ref, get_current_upstream_remote_name, get_head_sha, get_ref_sha,
    get_repository_type, get_upstream_ref_for_ref, get_upstream_remote_name_for_ref,
    resolve_git_dir, RepositoryType,
};
pub use revert::{revert_commit, RevertProgress, RevertProgressKind};
pub use rm::{remove_conflicted_file, unstage_all_files};
pub use show::get_blob_contents;
pub use squash::{build_squash_todo, squash, SquashError};
pub use stage::{
    stage_manual_conflict_resolution, stage_manual_conflict_resolution_with_entries,
    stage_resolved_conflict_files, ResolvedConflict,
};
pub use stash::{
    create_stash_entry, create_stash_message, drop_stash_entry, get_last_stash_entry_for_branch,
    get_stashed_files, get_stashes, move_stash_entry, pop_stash_entry, rename_stash_entry,
    StashEntry, StashResult, STASH_ENTRY_MARKER,
};
pub use status::{
    get_status, AheadBehind, AppFileStatus, ConflictedFileStatus, StatusFileChange, StatusResult,
};
pub use status_parser::{
    map_status, parse_porcelain_status, FileEntry, GitStatusEntry, OrdinaryChange, StatusEntry,
    StatusItem, SubmoduleStatus, UnmergedEntrySummary,
};
pub use submodule::{list_submodules, reset_submodule_paths, update_submodules, SubmoduleEntry};
pub use tag::{create_tag, delete_tag, fetch_tags_to_push, get_all_tags};
pub use terminal_output::{push_terminal_bytes, push_terminal_chunk};
pub use update_index::{stage_files, FileToStage, PartialSelection};
pub use update_ref::delete_ref;
pub use var::get_author_identity;
pub use worktree::{
    add_worktree, list_worktrees, list_worktrees_from_git_dir,
    list_worktrees_from_git_dir_fallback, move_worktree, parse_worktree_porcelain_output,
    remove_worktree, AddWorktreeOptions, WorktreeEntry, WorktreeType,
};
pub use worktree_include::{
    add_worktree_with_includes, copy_worktree_include_files, get_ignored_files_matching_patterns,
    read_worktree_include_patterns,
};
