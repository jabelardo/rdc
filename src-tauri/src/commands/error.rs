//! The error type commands return to the frontend.
//!
//! Tauri rejects a command's promise with whatever the `Err` variant serializes to, and **requires
//! the error type to implement `Serialize`** — `thiserror` alone is not enough. The usual shortcut
//! is `.map_err(|e| e.to_string())`, but that throws away the classification work in
//! `git_error_kind.rs`: the frontend would get prose it has to pattern-match on.
//!
//! So commands return this instead. It carries a human-readable message *and* the machine-readable
//! kind, letting the UI branch on "authentication failed" without parsing English — which is also
//! what makes it safe to keep the user-facing wording in the frontend, per the
//! `getDescriptionForError` decision in `MIGRATION_MAP.md`.

use git_ops::{GitError, GitErrorKind};
use serde::Serialize;

/// A command failure, as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// A developer-facing description. Suitable for logs; the UI should render its own copy based
    /// on `kind` rather than showing this.
    pub message: String,

    /// The classified git failure, when git failed in a way we recognize.
    ///
    /// `None` covers both "not a git failure at all" and "git failed in a way the classifier
    /// doesn't know", which the frontend must handle either way.
    pub kind: Option<GitErrorKind>,

    /// Whether this is an authentication failure.
    ///
    /// Derived from `kind` here rather than in the frontend because the grouping is
    /// git-domain knowledge (`isAuthFailureError` in the original), and auth is the one case the UI
    /// almost always needs to special-case.
    pub is_auth_failure: bool,
}

impl CommandError {
    /// A failure of rdc's own, with no git error behind it to classify.
    ///
    /// `kind` is `None` because there genuinely isn't one — a missing helper binary is not a git failure —
    /// and the frontend already has to handle that case.
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: None,
            is_auth_failure: false,
        }
    }
}

impl From<GitError> for CommandError {
    fn from(error: GitError) -> Self {
        let kind = match &error {
            GitError::UnexpectedExitCode { kind, .. } => *kind,
            _ => None,
        };

        Self {
            message: error.to_string(),
            kind,
            is_auth_failure: kind.is_some_and(GitErrorKind::is_auth_failure),
        }
    }
}
