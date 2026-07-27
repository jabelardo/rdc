//! Error types for git operations.
//!
//! Per MIGRATION_PLAN.md's Rust conventions: `thiserror` for library errors, `anyhow` only at
//! the command boundary, and never a panic across the IPC boundary.

use std::path::PathBuf;

/// A failure running or interpreting a git command.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// git could not be started, or the OS reported an error while it ran.
    ///
    /// The most common causes are git not being installed/on `PATH`, and a working directory
    /// that doesn't exist.
    #[error("failed to run git for '{name}' in {path}: {source}")]
    Spawn {
        name: String,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Writing to git's stdin failed.
    #[error("failed to write stdin for git '{name}' in {path}: {message}")]
    Stdin {
        name: String,
        path: PathBuf,
        message: String,
    },

    /// git exited with a code the caller didn't declare as successful, and the failure either
    /// wasn't recognized or wasn't declared via `expected_errors`.
    #[error("git '{name}' in {path} exited with code {exit_code}: {stderr}")]
    UnexpectedExitCode {
        name: String,
        path: PathBuf,
        exit_code: i32,
        /// The classified failure, when stderr/stdout matched a known pattern.
        ///
        /// `None` means git failed in a way we don't recognize — still an error, just without a
        /// specific kind. Mirrors a null `gitError` on `IGitResult` in `core.ts`.
        kind: Option<crate::git_error_kind::GitErrorKind>,
        stderr: String,
    },

    /// git was killed by a signal, so there is no exit code to interpret.
    #[error("git '{name}' in {path} was terminated by a signal: {stderr}")]
    Terminated {
        name: String,
        path: PathBuf,
        stderr: String,
    },
}
