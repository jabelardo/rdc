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

pub mod error;
pub mod exec;
pub mod git_error_kind;
pub mod terminal_output;

#[cfg(test)]
mod test_support;

pub use error::GitError;
pub use exec::{git, GitOptions, GitOutput, TERMINAL_OUTPUT_CAPACITY};
pub use git_error_kind::{parse_bad_config_value, parse_error, BadConfigValue, GitErrorKind};
pub use terminal_output::{push_terminal_bytes, push_terminal_chunk};
