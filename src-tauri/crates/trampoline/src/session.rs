//! Per-operation state, and the environment that points git at the trampoline.
//!
//! Ported from `desktop-plus/app/src/lib/trampoline/trampoline-environment.ts`.
//!
//! # This is what unblocks remote operations
//!
//! `push`, `pull`, `fetch`, `clone` and `remote` can't authenticate without the variables
//! [`Session::env`] produces. Everything else in this crate exists to serve them.
//!
//! # One store instead of four global maps
//!
//! The original kept four module-level `Map`s keyed by token — `isBackgroundTaskEnvironment`,
//! `trampolineEnvironmentPath`, `hasRejectedCredentialsForEndpoint`, plus the SSH credential
//! bookkeeping — and each entry had to be deleted in a `finally` block. Missing one leaks state keyed
//! by a token that no longer exists.
//!
//! Here a [`Session`] owns its own state and [`SessionStore`] holds one entry per live token, removed
//! when the session is dropped. That is the same lifetime the original hand-rolled, made structural.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::protocol::{PORT_ENV, TOKEN_ENV};
use crate::token::TokenStore;

/// State for one git operation that may need credentials.
#[derive(Debug, Clone)]
pub struct SessionState {
    /// The repository the operation is running in.
    ///
    /// Handlers need it to look up which account applies, and to run an external credential helper in
    /// the right place.
    pub path: PathBuf,

    /// Whether this operation is a background task, e.g. a periodic fetch.
    ///
    /// Load-bearing: a background task must **never** prompt. The original checked this in every
    /// handler before showing UI, because a fetch on a timer popping a password dialog is worse than
    /// the fetch failing.
    pub is_background_task: bool,

    /// Endpoints this operation failed to obtain credentials for.
    ///
    /// Recorded so the "terminal prompts disabled" error git produces afterwards can be recognised as
    /// a cancelled prompt — see [`is_cancelled_authentication`].
    pub rejected_endpoints: HashSet<String>,
}

/// The live sessions, keyed by trampoline token.
///
/// Cheap to clone; clones share the same state, so the server's handlers and the code running git can
/// hold their own handles.
#[derive(Debug, Clone, Default)]
pub struct SessionStore {
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a session, returning a guard that removes it when dropped.
    ///
    /// The token comes from `tokens` and is revoked by the same guard, so a session's state and its
    /// token always have identical lifetimes — the thing the original had to remember to do by hand.
    pub fn begin(
        &self,
        tokens: &TokenStore,
        path: impl Into<PathBuf>,
        is_background_task: bool,
    ) -> Session {
        let token = tokens.issue();

        self.lock().insert(
            token.clone(),
            SessionState {
                path: path.into(),
                is_background_task,
                rejected_endpoints: HashSet::new(),
            },
        );

        Session {
            token,
            tokens: tokens.clone(),
            store: self.clone(),
        }
    }

    /// The state for `token`, if the session is still live.
    pub fn get(&self, token: &str) -> Option<SessionState> {
        self.lock().get(token).cloned()
    }

    /// The repository path for `token`.
    ///
    /// `None` for an unknown token. The original fell back to `process.cwd()`, which is wrong for an
    /// app whose working directory has nothing to do with any repository — a credential helper run
    /// there would consult the wrong configuration. A caller that needs a path should fail instead.
    pub fn path(&self, token: &str) -> Option<PathBuf> {
        self.lock().get(token).map(|state| state.path.clone())
    }

    /// Whether `token` belongs to a background task.
    ///
    /// Defaults to **true** for an unknown token, which is the safe direction: an unrecognised token
    /// must not cause a prompt. The original defaulted to false.
    pub fn is_background_task(&self, token: &str) -> bool {
        self.lock()
            .get(token)
            .is_none_or(|state| state.is_background_task)
    }

    /// Records that credentials could not be obtained for `endpoint`.
    pub fn set_rejected_endpoint(&self, token: &str, endpoint: &str) {
        if let Some(state) = self.lock().get_mut(token) {
            state.rejected_endpoints.insert(endpoint.to_owned());
        }
    }

    /// Whether any endpoint was rejected during this session.
    pub fn has_rejected_endpoints(&self, token: &str) -> bool {
        self.lock()
            .get(token)
            .is_some_and(|state| !state.rejected_endpoints.is_empty())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionState>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A live session. Removes its state and revokes its token on drop, including on unwind.
#[derive(Debug)]
pub struct Session {
    token: String,
    tokens: TokenStore,
    store: SessionStore,
}

impl Session {
    /// The token git will present back to the server.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Whether any endpoint was rejected while this session ran.
    pub fn has_rejected_endpoints(&self) -> bool {
        self.store.has_rejected_endpoints(&self.token)
    }

    /// The environment to add to a git invocation.
    ///
    /// - `DESKTOP_PORT` / `DESKTOP_TRAMPOLINE_TOKEN` tell the trampoline binary where to connect and
    ///   how to authenticate.
    /// - `GIT_ASKPASS` is set **empty** on purpose. The original pointed it at the trampoline binary;
    ///   leaving it empty makes git fall through to the credential helper instead, which is the path
    ///   that can answer properly. SSH askpass is configured separately, once SSH support lands.
    /// - `GIT_CONFIG_PARAMETERS` installs the credential helper. It has to be an **environment
    ///   variable rather than `-c` arguments**, because arguments aren't passed down to filters and
    ///   Git LFS runs as one — so with `-c` alone, LFS could not authenticate. The original also chose
    ///   the undocumented `GIT_CONFIG_PARAMETERS` over the documented `GIT_CONFIG_{COUNT,KEY,VALUE}`
    ///   to work around a Python hook manager that mishandles the blank values those require. See
    ///   <https://github.com/desktop/desktop/issues/18945>.
    ///
    ///   The empty `'credential.helper='` before `'credential.helper=desktop'` clears any helper the
    ///   user has configured, so rdc's is the only one consulted. Any pre-existing value in
    ///   `existing_config_parameters` is preserved ahead of ours.
    /// - `GIT_USER_AGENT` identifies rdc to servers.
    pub fn env(
        &self,
        port: u16,
        user_agent: &str,
        existing_config_parameters: Option<&str>,
    ) -> HashMap<String, String> {
        let prefix = match existing_config_parameters {
            Some(existing) if !existing.is_empty() => format!("{existing} "),
            _ => String::new(),
        };

        HashMap::from([
            (PORT_ENV.to_owned(), port.to_string()),
            (TOKEN_ENV.to_owned(), self.token.clone()),
            ("GIT_ASKPASS".to_owned(), String::new()),
            (
                "GIT_CONFIG_PARAMETERS".to_owned(),
                format!("{prefix}'credential.helper=' 'credential.helper=desktop'"),
            ),
            ("GIT_USER_AGENT".to_owned(), user_agent.to_owned()),
        ])
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.store.lock().remove(&self.token);
        self.tokens.revoke(&self.token);
    }
}

/// Whether a git failure is really "the user cancelled the credential prompt".
///
/// Needs the whole comment to make sense. Before the credential helper existed, the askpass handler
/// returned an empty username and password when it couldn't get credentials; git took those literally,
/// tried to authenticate with them, and failed with an authentication error the user understood.
///
/// With a credential helper, git knows the helper *declined* rather than supplying empty strings, so
/// it doesn't attempt authentication at all — it exits complaining that it couldn't read a username
/// because terminal prompts are disabled. That message is accurate and useless to a user.
///
/// So a failure that matches it, in a session where some endpoint was rejected, is reported as an
/// authentication failure instead. Both conditions are required: the message alone could come from a
/// genuinely non-interactive environment where nothing was ever declined.
pub fn is_cancelled_authentication(session: &Session, stderr: &str) -> bool {
    session.has_rejected_endpoints() && PROMPTS_DISABLED_MARKERS.iter().all(|m| stderr.contains(m))
}

/// Substrings identifying git's "terminal prompts disabled" failure.
///
/// Matched as substrings rather than with the original's anchored regex
/// (`^fatal: could not read .*?: terminal prompts disabled\n$`), because that pattern required the
/// message to be the *entire* stderr. Our stderr can also carry progress output, so anchoring would
/// silently stop matching.
const PROMPTS_DISABLED_MARKERS: [&str; 2] = ["could not read", "terminal prompts disabled"];

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn store() -> (SessionStore, TokenStore) {
        (SessionStore::new(), TokenStore::new())
    }

    #[test]
    fn a_session_issues_a_live_token() {
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);

        assert!(tokens.is_valid(session.token()));
        assert_eq!(
            sessions.path(session.token()).as_deref(),
            Some(Path::new("/repo"))
        );
    }

    #[test]
    fn dropping_a_session_revokes_its_token_and_forgets_its_state() {
        let (sessions, tokens) = store();
        let token = {
            let session = sessions.begin(&tokens, "/repo", false);
            session.token().to_owned()
        };

        assert!(
            !tokens.is_valid(&token),
            "the token must not outlive the session"
        );
        assert_eq!(sessions.path(&token), None);
    }

    #[test]
    fn two_sessions_do_not_share_state() {
        let (sessions, tokens) = store();
        let first = sessions.begin(&tokens, "/one", false);
        let second = sessions.begin(&tokens, "/two", true);

        assert_eq!(
            sessions.path(first.token()).as_deref(),
            Some(Path::new("/one"))
        );
        assert_eq!(
            sessions.path(second.token()).as_deref(),
            Some(Path::new("/two"))
        );
        assert!(!sessions.is_background_task(first.token()));
        assert!(sessions.is_background_task(second.token()));
    }

    #[test]
    fn an_unknown_token_is_treated_as_a_background_task() {
        // The safe default: an unrecognised token must not cause a prompt. The original defaulted the
        // other way.
        let (sessions, _tokens) = store();
        assert!(sessions.is_background_task("no-such-token"));
    }

    #[test]
    fn an_unknown_token_has_no_path() {
        // The original fell back to the process working directory, which has nothing to do with any
        // repository — a credential helper run there would read the wrong configuration.
        let (sessions, _tokens) = store();
        assert_eq!(sessions.path("no-such-token"), None);
    }

    #[test]
    fn records_rejected_endpoints_per_session() {
        let (sessions, tokens) = store();
        let first = sessions.begin(&tokens, "/one", false);
        let second = sessions.begin(&tokens, "/two", false);

        sessions.set_rejected_endpoint(first.token(), "https://github.com/");

        assert!(first.has_rejected_endpoints());
        assert!(
            !second.has_rejected_endpoints(),
            "a rejection in one operation must not affect another"
        );
    }

    #[test]
    fn rejecting_an_endpoint_for_an_unknown_token_is_a_noop() {
        let (sessions, _tokens) = store();
        sessions.set_rejected_endpoint("no-such-token", "https://github.com/");
        assert!(!sessions.has_rejected_endpoints("no-such-token"));
    }

    // --- environment ---

    #[test]
    fn builds_the_environment_git_needs() {
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        let env = session.env(4242, "git/2.4 (rdc)", None);

        assert_eq!(env.get(PORT_ENV).map(String::as_str), Some("4242"));
        assert_eq!(
            env.get(TOKEN_ENV).map(String::as_str),
            Some(session.token())
        );
        assert_eq!(
            env.get("GIT_USER_AGENT").map(String::as_str),
            Some("git/2.4 (rdc)")
        );
    }

    #[test]
    fn sets_git_askpass_to_empty_rather_than_omitting_it() {
        // Present-and-empty is the point: it stops git using an inherited askpass program and makes it
        // fall through to the credential helper.
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        let env = session.env(1, "ua", None);

        assert_eq!(env.get("GIT_ASKPASS").map(String::as_str), Some(""));
    }

    #[test]
    fn installs_the_credential_helper_clearing_any_existing_one() {
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        let env = session.env(1, "ua", None);

        assert_eq!(
            env.get("GIT_CONFIG_PARAMETERS").map(String::as_str),
            Some("'credential.helper=' 'credential.helper=desktop'")
        );
    }

    #[test]
    fn preserves_existing_config_parameters_ahead_of_ours() {
        // Dropping them would silently discard configuration the caller set.
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        let env = session.env(1, "ua", Some("'foo=bar'"));

        assert_eq!(
            env.get("GIT_CONFIG_PARAMETERS").map(String::as_str),
            Some("'foo=bar' 'credential.helper=' 'credential.helper=desktop'")
        );
    }

    #[test]
    fn ignores_an_empty_existing_config_parameters() {
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        let env = session.env(1, "ua", Some(""));

        assert_eq!(
            env.get("GIT_CONFIG_PARAMETERS").map(String::as_str),
            Some("'credential.helper=' 'credential.helper=desktop'")
        );
    }

    // --- cancelled authentication ---

    #[test]
    fn recognizes_a_cancelled_prompt() {
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        sessions.set_rejected_endpoint(session.token(), "https://github.com/");

        let stderr =
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
        assert!(is_cancelled_authentication(&session, stderr));
    }

    #[test]
    fn does_not_claim_cancellation_when_nothing_was_rejected() {
        // The same message in a genuinely non-interactive environment isn't a cancelled prompt, so
        // both conditions are required.
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);

        let stderr =
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
        assert!(!is_cancelled_authentication(&session, stderr));
    }

    #[test]
    fn does_not_claim_cancellation_for_an_unrelated_failure() {
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        sessions.set_rejected_endpoint(session.token(), "https://github.com/");

        assert!(!is_cancelled_authentication(
            &session,
            "fatal: repository not found\n"
        ));
    }

    #[test]
    fn recognizes_the_message_amid_other_stderr_output() {
        // Why substrings rather than the original's anchored regex: our stderr can also carry progress
        // output, and anchoring would silently stop matching.
        let (sessions, tokens) = store();
        let session = sessions.begin(&tokens, "/repo", false);
        sessions.set_rejected_endpoint(session.token(), "https://github.com/");

        let stderr = "Fetching origin\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
        assert!(is_cancelled_authentication(&session, stderr));
    }
}
