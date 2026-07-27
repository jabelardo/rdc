//! Classification of git failures from stderr.
//!
//! GENERATED — do not edit by hand. Regenerate with `scripts/generate-git-error-kind.mjs` (see
//! that file for usage) when upgrading the dugite version this is derived from.
//!
//! The [`GitErrorKind`] variants and the pattern table below are reproduced verbatim from
//! dugite v3.2.2 (`build/lib/errors.js`), which is what `desktop-plus` used via
//! `lib/git/core.ts`. Generating rather than transcribing keeps all 62 patterns —
//! and their order — exact.
//!
//! **Order is significant.** dugite's `parseError` returns the *first* matching pattern
//! (`Object.entries(GitErrorRegexes).find(...)`), and several patterns overlap: e.g.
//! `fatal: Authentication failed for 'https?://` must be tested before the more general
//! `fatal: Authentication failed`, or every HTTPS auth failure would be misreported as SSH.
//!
//! Note that user-facing message text is deliberately *not* ported here — see the note on
//! `getDescriptionForError` in MIGRATION_MAP.md. Rust returns the typed kind; mapping a kind to
//! display copy belongs in the frontend, where it can be localized.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// A git failure recognized from stderr.
///
/// Mirrors dugite's `GitError` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GitErrorKind {
    BadConfigValue,
    SSHKeyAuditUnverified,
    SSHAuthenticationFailed,
    SSHPermissionDenied,
    HTTPSAuthenticationFailed,
    RemoteDisconnection,
    HostDown,
    RebaseConflicts,
    MergeConflicts,
    HTTPSRepositoryNotFound,
    SSHRepositoryNotFound,
    PushNotFastForward,
    BranchDeletionFailed,
    DefaultBranchDeletionFailed,
    RevertConflicts,
    EmptyRebasePatch,
    NoMatchingRemoteBranch,
    NoExistingRemoteBranch,
    NothingToCommit,
    NoSubmoduleMapping,
    SubmoduleRepositoryDoesNotExist,
    InvalidSubmoduleSHA,
    LocalPermissionDenied,
    InvalidMerge,
    InvalidRebase,
    NonFastForwardMergeIntoEmptyHead,
    PatchDoesNotApply,
    BranchAlreadyExists,
    BadRevision,
    NotAGitRepository,
    CannotMergeUnrelatedHistories,
    LFSAttributeDoesNotMatch,
    BranchRenameFailed,
    PathDoesNotExist,
    InvalidObjectName,
    OutsideRepository,
    LockFileAlreadyExists,
    NoMergeToAbort,
    LocalChangesOverwritten,
    UnresolvedConflicts,
    GPGFailedToSignData,
    ConflictModifyDeletedInBranch,
    PushWithFileSizeExceedingLimit,
    HexBranchNameRejected,
    ForcePushRejected,
    InvalidRefLength,
    ProtectedBranchRequiresReview,
    ProtectedBranchForcePush,
    ProtectedBranchDeleteRejected,
    ProtectedBranchRequiredStatus,
    PushWithPrivateEmail,
    ConfigLockFileAlreadyExists,
    RemoteAlreadyExists,
    TagAlreadyExists,
    MergeWithLocalChanges,
    RebaseWithLocalChanges,
    MergeCommitNoMainlineOption,
    UnsafeDirectory,
    PathExistsButNotInRef,
    PushWithSecretDetected,
}

impl GitErrorKind {
    /// Whether this failure is an authentication problem.
    ///
    /// Ported from `isAuthFailureError` in `desktop-plus/app/src/lib/git/core.ts`.
    pub fn is_auth_failure(self) -> bool {
        matches!(
            self,
            Self::SSHAuthenticationFailed
                | Self::SSHPermissionDenied
                | Self::HTTPSAuthenticationFailed
        )
    }
}

/// Patterns in dugite's original order. The first match wins.
const PATTERNS: &[(&str, GitErrorKind)] = &[
    (
        r"fatal: bad (?:numeric|boolean) config value '(.+)' for '(.+)'",
        GitErrorKind::BadConfigValue,
    ),
    (
        r"ERROR: ([\s\S]+?)\n+\[EPOLICYKEYAGE\]\n+fatal: Could not read from remote repository.",
        GitErrorKind::SSHKeyAuditUnverified,
    ),
    (
        r"fatal: Authentication failed for 'https?://",
        GitErrorKind::HTTPSAuthenticationFailed,
    ),
    (
        r"fatal: Authentication failed",
        GitErrorKind::SSHAuthenticationFailed,
    ),
    (
        r"fatal: Could not read from remote repository.",
        GitErrorKind::SSHPermissionDenied,
    ),
    (
        r"The requested URL returned error: 403",
        GitErrorKind::HTTPSAuthenticationFailed,
    ),
    (
        r"fatal: [Tt]he remote end hung up unexpectedly",
        GitErrorKind::RemoteDisconnection,
    ),
    (
        r"fatal: unable to access '(.+)': Failed to connect to (.+): Host is down",
        GitErrorKind::HostDown,
    ),
    (
        r"Cloning into '(.+)'...
fatal: unable to access '(.+)': Could not resolve host: (.+)",
        GitErrorKind::HostDown,
    ),
    (
        r"Resolve all conflicts manually, mark them as resolved with",
        GitErrorKind::RebaseConflicts,
    ),
    (
        r"(Merge conflict|Automatic merge failed; fix conflicts and then commit the result)",
        GitErrorKind::MergeConflicts,
    ),
    (
        r"fatal: repository '(.+)' not found",
        GitErrorKind::HTTPSRepositoryNotFound,
    ),
    (
        r"ERROR: Repository not found",
        GitErrorKind::SSHRepositoryNotFound,
    ),
    (
        r"\((non-fast-forward|fetch first)\)
error: failed to push some refs to '.*'",
        GitErrorKind::PushNotFastForward,
    ),
    (
        r"error: unable to delete '(.+)': remote ref does not exist",
        GitErrorKind::BranchDeletionFailed,
    ),
    (
        r"\[remote rejected\] (.+) \(deletion of the current branch prohibited\)",
        GitErrorKind::DefaultBranchDeletionFailed,
    ),
    (
        r"error: could not revert .*
hint: after resolving the conflicts, mark the corrected paths
hint: with 'git add <paths>' or 'git rm <paths>'
hint: and commit the result with 'git commit'",
        GitErrorKind::RevertConflicts,
    ),
    (
        r"Applying: .*
No changes - did you forget to use 'git add'\?
If there is nothing left to stage, chances are that something else
.*",
        GitErrorKind::EmptyRebasePatch,
    ),
    (
        r"There are no candidates for (rebasing|merging) among the refs that you just fetched.
Generally this means that you provided a wildcard refspec which had no
matches on the remote end.",
        GitErrorKind::NoMatchingRemoteBranch,
    ),
    (
        r"Your configuration specifies to merge with the ref '(.+)'
from the remote, but no such ref was fetched.",
        GitErrorKind::NoExistingRemoteBranch,
    ),
    (r"nothing to commit", GitErrorKind::NothingToCommit),
    (
        r"[Nn]o submodule mapping found in .gitmodules for path '(.+)'",
        GitErrorKind::NoSubmoduleMapping,
    ),
    (
        r"fatal: repository '(.+)' does not exist
fatal: clone of '.+' into submodule path '(.+)' failed",
        GitErrorKind::SubmoduleRepositoryDoesNotExist,
    ),
    (
        r"Fetched in submodule path '(.+)', but it did not contain (.+). Direct fetching of that commit failed.",
        GitErrorKind::InvalidSubmoduleSHA,
    ),
    (
        r"fatal: could not create work tree dir '(.+)'.*: Permission denied",
        GitErrorKind::LocalPermissionDenied,
    ),
    (
        r"merge: (.+) - not something we can merge",
        GitErrorKind::InvalidMerge,
    ),
    (r"invalid upstream (.+)", GitErrorKind::InvalidRebase),
    (
        r"fatal: Non-fast-forward commit does not make sense into an empty head",
        GitErrorKind::NonFastForwardMergeIntoEmptyHead,
    ),
    (
        r"error: (.+): (patch does not apply|already exists in working directory)",
        GitErrorKind::PatchDoesNotApply,
    ),
    (
        r"fatal: [Aa] branch named '(.+)' already exists.?",
        GitErrorKind::BranchAlreadyExists,
    ),
    (r"fatal: bad revision '(.*)'", GitErrorKind::BadRevision),
    (
        r"fatal: [Nn]ot a git repository \(or any of the parent directories\): (.*)",
        GitErrorKind::NotAGitRepository,
    ),
    (
        r"fatal: refusing to merge unrelated histories",
        GitErrorKind::CannotMergeUnrelatedHistories,
    ),
    (
        r"The .+ attribute should be .+ but is .+",
        GitErrorKind::LFSAttributeDoesNotMatch,
    ),
    (
        r"fatal: Branch rename failed",
        GitErrorKind::BranchRenameFailed,
    ),
    (
        r"fatal: path '(.+)' does not exist .+",
        GitErrorKind::PathDoesNotExist,
    ),
    (
        r"fatal: invalid object name '(.+)'.",
        GitErrorKind::InvalidObjectName,
    ),
    (
        r"fatal: .+: '(.+)' is outside repository",
        GitErrorKind::OutsideRepository,
    ),
    (
        r"Another git process seems to be running in this repository, e.g.",
        GitErrorKind::LockFileAlreadyExists,
    ),
    (
        r"fatal: There is no merge to abort",
        GitErrorKind::NoMergeToAbort,
    ),
    (
        r"error: (?:Your local changes to the following|The following untracked working tree) files would be overwritten by checkout:",
        GitErrorKind::LocalChangesOverwritten,
    ),
    (
        r"You must edit all merge conflicts and then
mark them as resolved using git add|fatal: Exiting because of an unresolved conflict",
        GitErrorKind::UnresolvedConflicts,
    ),
    (
        r"error: gpg failed to sign the data",
        GitErrorKind::GPGFailedToSignData,
    ),
    (
        r"CONFLICT \(modify/delete\): (.+) deleted in (.+) and modified in (.+)",
        GitErrorKind::ConflictModifyDeletedInBranch,
    ),
    (
        r"error: GH001: ",
        GitErrorKind::PushWithFileSizeExceedingLimit,
    ),
    (r"error: GH002: ", GitErrorKind::HexBranchNameRejected),
    (
        r"error: GH003: Sorry, force-pushing to (.+) is not allowed.",
        GitErrorKind::ForcePushRejected,
    ),
    (
        r"error: GH005: Sorry, refs longer than (.+) bytes are not allowed",
        GitErrorKind::InvalidRefLength,
    ),
    (
        r"error: GH006: Protected branch update failed for (.+)
remote: error: At least one approved review is required",
        GitErrorKind::ProtectedBranchRequiresReview,
    ),
    (
        r"error: GH006: Protected branch update failed for (.+)
remote: error: Cannot force-push to a protected branch",
        GitErrorKind::ProtectedBranchForcePush,
    ),
    (
        r"error: GH006: Protected branch update failed for (.+)
remote: error: Cannot delete a protected branch",
        GitErrorKind::ProtectedBranchDeleteRejected,
    ),
    (
        r#"error: GH006: Protected branch update failed for (.+).
remote: error: Required status check "(.+)" is expected"#,
        GitErrorKind::ProtectedBranchRequiredStatus,
    ),
    (
        r"error: GH007: Your push would publish a private email address.",
        GitErrorKind::PushWithPrivateEmail,
    ),
    (
        r"error: could not lock config file (.+): File exists",
        GitErrorKind::ConfigLockFileAlreadyExists,
    ),
    (
        r"error: remote (.+) already exists.",
        GitErrorKind::RemoteAlreadyExists,
    ),
    (
        r"fatal: tag '(.+)' already exists",
        GitErrorKind::TagAlreadyExists,
    ),
    (
        r"error: Your local changes to the following files would be overwritten by merge:
",
        GitErrorKind::MergeWithLocalChanges,
    ),
    (
        r"error: cannot (pull with rebase|rebase): You have unstaged changes\.
\s*error: [Pp]lease commit or stash them\.",
        GitErrorKind::RebaseWithLocalChanges,
    ),
    (
        r"error: commit (.+) is a merge but no -m option was given",
        GitErrorKind::MergeCommitNoMainlineOption,
    ),
    (
        r"fatal: detected dubious ownership in repository at (.+)",
        GitErrorKind::UnsafeDirectory,
    ),
    (
        r"fatal: path '(.+)' exists on disk, but not in '(.+)'",
        GitErrorKind::PathExistsButNotInRef,
    ),
    (
        r"GITHUB PUSH PROTECTION[.\s\S]+Push cannot contain secrets",
        GitErrorKind::PushWithSecretDetected,
    ),
];

fn compiled() -> &'static [(Regex, GitErrorKind)] {
    static COMPILED: OnceLock<Vec<(Regex, GitErrorKind)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        PATTERNS
            .iter()
            .map(|(pattern, kind)| {
                // The pattern table is a compile-time constant validated by
                // `all_patterns_compile` below, so a failure here is a bug in this file rather
                // than a runtime condition callers could handle.
                let re = Regex::new(pattern).unwrap_or_else(|e| {
                    panic!("invalid built-in git error pattern {pattern:?}: {e}")
                });
                (re, *kind)
            })
            .collect()
    })
}

/// Classifies a git failure from its stderr, or `None` if nothing matches.
///
/// Equivalent to dugite's `parseError`: the first pattern to match, in table order.
pub fn parse_error(stderr: &str) -> Option<GitErrorKind> {
    compiled()
        .iter()
        .find(|(re, _)| re.is_match(stderr))
        .map(|(_, kind)| *kind)
}

/// The offending key and value from a `BadConfigValue` failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadConfigValue {
    pub key: String,
    pub value: String,
}

/// Extracts the key/value from a bad-config-value failure.
///
/// Ported from dugite's `parseBadConfigValueErrorInfo`. Note the capture order: the value is
/// captured before the key in git's message.
pub fn parse_bad_config_value(stderr: &str) -> Option<BadConfigValue> {
    let (re, _) = compiled()
        .iter()
        .find(|(_, kind)| *kind == GitErrorKind::BadConfigValue)?;
    let captures = re.captures(stderr)?;
    Some(BadConfigValue {
        value: captures.get(1)?.as_str().to_owned(),
        key: captures.get(2)?.as_str().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_patterns_compile() {
        // Forces the OnceLock, so a malformed pattern fails here rather than at first use in
        // production. Also asserts the table didn't lose entries in generation.
        assert_eq!(compiled().len(), 62);
    }

    #[test]
    fn returns_none_when_nothing_matches() {
        assert_eq!(parse_error("something entirely unremarkable"), None);
        assert_eq!(parse_error(""), None);
    }

    #[test]
    fn classifies_https_auth_failure_before_the_generic_ssh_pattern() {
        // The ordering case that matters most: both patterns match this input, and the HTTPS one
        // comes first in dugite's table.
        let stderr = "fatal: Authentication failed for 'https://github.com/foo/bar.git/'";
        assert_eq!(
            parse_error(stderr),
            Some(GitErrorKind::HTTPSAuthenticationFailed)
        );
    }

    #[test]
    fn classifies_generic_auth_failure_as_ssh() {
        assert_eq!(
            parse_error("fatal: Authentication failed"),
            Some(GitErrorKind::SSHAuthenticationFailed)
        );
    }

    #[test]
    fn classifies_common_failures() {
        for (stderr, expected) in [
            (
                "fatal: repository 'https://github.com/foo/bar.git/' not found",
                GitErrorKind::HTTPSRepositoryNotFound,
            ),
            ("ERROR: Repository not found", GitErrorKind::SSHRepositoryNotFound),
            (
                "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
                GitErrorKind::SSHPermissionDenied,
            ),
            (
                "Automatic merge failed; fix conflicts and then commit the result.",
                GitErrorKind::MergeConflicts,
            ),
            (
                "Resolve all conflicts manually, mark them as resolved with",
                GitErrorKind::RebaseConflicts,
            ),
            (
                "fatal: The remote end hung up unexpectedly",
                GitErrorKind::RemoteDisconnection,
            ),
        ] {
            assert_eq!(parse_error(stderr), Some(expected), "for stderr {stderr:?}");
        }
    }

    #[test]
    fn identifies_auth_failures() {
        assert!(GitErrorKind::HTTPSAuthenticationFailed.is_auth_failure());
        assert!(GitErrorKind::SSHAuthenticationFailed.is_auth_failure());
        assert!(GitErrorKind::SSHPermissionDenied.is_auth_failure());
        assert!(!GitErrorKind::MergeConflicts.is_auth_failure());
        assert!(!GitErrorKind::NothingToCommit.is_auth_failure());
    }

    #[test]
    fn extracts_bad_config_key_and_value() {
        let stderr = "fatal: bad numeric config value 'aaaa' for 'core.repositoryformatversion'";
        assert_eq!(parse_error(stderr), Some(GitErrorKind::BadConfigValue));
        assert_eq!(
            parse_bad_config_value(stderr),
            Some(BadConfigValue {
                key: "core.repositoryformatversion".to_owned(),
                value: "aaaa".to_owned(),
            })
        );
    }

    #[test]
    fn returns_no_bad_config_info_for_an_unrelated_error() {
        assert_eq!(parse_bad_config_value("ERROR: Repository not found"), None);
    }
}
