//! Environment and error classification shared by every remote operation.
//!
//! Ported from `desktop-plus/app/src/lib/git/authentication.ts` and the `envForRemoteOperation`
//! half of `lib/git/environment.ts`.
//!
//! # Where the rest of the environment comes from
//!
//! [`env_for_authentication`] covers only what git itself needs. The variables that point git at
//! rdc's credential helper come from `trampoline::Session::env`, and `git-ops` deliberately does not
//! depend on the `trampoline` crate — the caller merges the two. That keeps this crate runnable
//! against a repository with no app around it, which is what makes its tests possible.

use std::collections::HashMap;

use crate::git_error_kind::GitErrorKind;

/// The environment every remote operation needs.
///
/// `GIT_TERMINAL_PROMPT=0` is the important one: it guarantees git never tries to prompt on a
/// terminal, even as a fallback when the credential helper declines. Without it a git invoked from a
/// GUI can block forever waiting for input nobody can give it.
///
/// `GIT_TRACE=0` is set explicitly rather than left unset so an exported `GIT_TRACE` in the user's
/// shell doesn't flood stderr and confuse the progress parser. The original read a `git-trace`
/// setting out of `localStorage` to allow turning it on; that is app configuration, so it belongs
/// above this crate — a caller can override the value.
pub fn env_for_authentication() -> HashMap<String, String> {
    HashMap::from([
        ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
        ("GIT_TRACE".to_owned(), "0".to_owned()),
    ])
}

/// The failures that mean "we could not authenticate".
///
/// Declared as *expected* errors on remote operations so they come back as a classified result the
/// caller can act on — prompting for credentials, say — rather than as an opaque failure.
///
/// "Repository not found" is in here, which looks wrong and isn't: a private repository the caller
/// isn't authenticated for is indistinguishable from one that doesn't exist, because that is exactly
/// what servers report in order not to leak which private repositories exist.
pub const AUTHENTICATION_ERRORS: [GitErrorKind; 4] = [
    GitErrorKind::HTTPSAuthenticationFailed,
    GitErrorKind::SSHAuthenticationFailed,
    GitErrorKind::HTTPSRepositoryNotFound,
    GitErrorKind::SSHRepositoryNotFound,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_lets_git_prompt_on_a_terminal() {
        // The variable that stops a GUI-invoked git from blocking on input nobody can supply.
        assert_eq!(
            env_for_authentication()
                .get("GIT_TERMINAL_PROMPT")
                .map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn pins_git_trace_off() {
        // Set explicitly so an exported GIT_TRACE can't flood stderr and confuse progress parsing.
        assert_eq!(
            env_for_authentication()
                .get("GIT_TRACE")
                .map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn treats_repository_not_found_as_an_authentication_failure() {
        // Servers report a private repository as missing rather than revealing it exists, so these
        // are the same condition from the client's side.
        assert!(AUTHENTICATION_ERRORS.contains(&GitErrorKind::HTTPSRepositoryNotFound));
        assert!(AUTHENTICATION_ERRORS.contains(&GitErrorKind::SSHRepositoryNotFound));
    }
}
