//! The trampoline server, as Tauri-managed state.
//!
//! This is where the two halves finally meet: `git-ops` runs git and knows nothing about
//! credentials; `trampoline` answers credential requests and knows nothing about git. A remote
//! operation needs both, and this owns the piece that joins them.
//!
//! # Why the server starts lazily
//!
//! Binding a socket and holding an accept loop for an app that may never talk to a remote is waste,
//! and a bind failure at startup would be fatal for no reason. The original started on the first
//! remote operation for the same reason. [`TrampolineState::session_for`] binds on first use and
//! reuses the port thereafter.
//!
//! # What is still declined
//!
//! The handlers registered here use `trampoline::Decline` for both seams, so rdc supplies no
//! credentials of its own yet — the accounts store and prompt UI are Phase 7. That is not a dead end:
//! declining makes git fall through to *its* helpers, so a repository reachable over SSH with a
//! loaded agent, or over HTTPS with a system credential manager, works today.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use trampoline::{
    askpass_handler, credential_helper_handler, CommandIdentifier, Decline, Session, SessionStore,
    TokenStore, TrampolineServer,
};

/// A remote operation's credential environment, and the session that owns it.
///
/// Holding the [`Session`] alive is what keeps the token valid; dropping this revokes it. So a caller
/// must keep it for as long as git is running, which is why [`TrampolineState::session_for`] returns
/// both together rather than just the environment.
pub struct RemoteSession {
    pub session: Session,
    pub env: HashMap<String, String>,
}

/// Owns the trampoline server and the live sessions.
pub struct TrampolineState {
    tokens: TokenStore,
    sessions: SessionStore,
    server: Arc<TrampolineServer>,
    /// The bound port, once the server has started. `Mutex` rather than `OnceCell` because starting
    /// is async and fallible, and a failed attempt should be retried by the next operation.
    port: Mutex<Option<u16>>,
    /// git's version string, resolved once — see [`TrampolineState::user_agent`].
    user_agent: Mutex<Option<String>>,
}

impl TrampolineState {
    pub fn new() -> Self {
        let tokens = TokenStore::new();
        let sessions = SessionStore::new();

        Self {
            tokens,
            sessions,
            server: Arc::new(TrampolineServer::new(TokenStore::new())),
            port: Mutex::new(None),
            user_agent: Mutex::new(None),
        }
        .with_shared_tokens()
    }

    /// Rebuilds the server so it validates against the same token store sessions issue from.
    ///
    /// Separated only because `new` can't reference `tokens` while constructing the struct that owns
    /// it; the server must share the store or every request would fail authentication.
    fn with_shared_tokens(mut self) -> Self {
        self.server = Arc::new(TrampolineServer::new(self.tokens.clone()));
        self
    }

    /// Starts a session for an operation in `path`, returning its credential environment.
    ///
    /// `is_background_task` must be true for anything the user didn't initiate — a scheduled fetch,
    /// say. It is what stops a prompt appearing unbidden, and it cannot be inferred here.
    pub async fn session_for(
        &self,
        path: &str,
        is_background_task: bool,
    ) -> Result<RemoteSession, std::io::Error> {
        let port = self.ensure_listening().await?;
        let session = self.sessions.begin(&self.tokens, path, is_background_task);

        // `GIT_CONFIG_PARAMETERS` from the environment is preserved rather than replaced, so a value
        // the user exported still applies.
        let existing = std::env::var("GIT_CONFIG_PARAMETERS").ok();
        let env = session.env(port, &self.user_agent().await, existing.as_deref());

        Ok(RemoteSession { session, env })
    }

    /// Binds and registers handlers on first use, returning the port.
    async fn ensure_listening(&self) -> Result<u16, std::io::Error> {
        let mut port = self.port.lock().await;

        if let Some(port) = *port {
            return Ok(port);
        }

        self.server
            .register(
                CommandIdentifier::AskPass,
                askpass_handler(Arc::new(Decline), self.sessions.clone()),
            )
            .await;
        self.server
            .register(
                CommandIdentifier::CredentialHelper,
                credential_helper_handler(Arc::new(Decline), self.sessions.clone()),
            )
            .await;

        let bound = self.server.listen().await?;
        *port = Some(bound);
        Ok(bound)
    }

    /// The `GIT_USER_AGENT` value, resolved once.
    ///
    /// Asks git for its version rather than guessing. Deliberately **not** routed through
    /// `git_ops::git`: that would install this very environment and recurse. Falls back to `unknown`
    /// on failure, as the original did — a user agent is not worth failing an operation over.
    async fn user_agent(&self) -> String {
        let mut cached = self.user_agent.lock().await;

        if let Some(agent) = cached.as_deref() {
            return agent.to_owned();
        }

        let version = tokio::process::Command::new("git")
            .arg("--version")
            .output()
            .await
            .ok()
            .and_then(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                stdout.split_whitespace().nth(2).map(str::to_owned)
            })
            .unwrap_or_else(|| "unknown".to_owned());

        let agent = format!(
            "git/{version} (rdc/{}; {} {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        );

        *cached = Some(agent.clone());
        agent
    }
}

impl Default for TrampolineState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_session_carries_the_variables_git_needs() {
        let state = TrampolineState::new();
        let remote = state
            .session_for("/repo", false)
            .await
            .expect("the server should bind");

        assert!(remote.env.contains_key("DESKTOP_PORT"));
        assert_eq!(
            remote
                .env
                .get("DESKTOP_TRAMPOLINE_TOKEN")
                .map(String::as_str),
            Some(remote.session.token())
        );
        assert!(remote
            .env
            .get("GIT_CONFIG_PARAMETERS")
            .is_some_and(|value| value.contains("credential.helper=desktop")));
    }

    #[tokio::test]
    async fn the_token_is_valid_while_the_session_lives_and_not_after() {
        // The reason `session_for` hands back the Session rather than just the environment.
        let state = TrampolineState::new();
        let remote = state
            .session_for("/repo", false)
            .await
            .expect("the server should bind");

        let token = remote.session.token().to_owned();
        assert!(state.tokens.is_valid(&token));

        drop(remote);
        assert!(
            !state.tokens.is_valid(&token),
            "dropping the session must revoke its token"
        );
    }

    #[tokio::test]
    async fn the_server_binds_once_and_reuses_its_port() {
        let state = TrampolineState::new();

        let first = state.session_for("/one", false).await.expect("binds");
        let second = state.session_for("/two", false).await.expect("binds");

        assert_eq!(
            first.env.get("DESKTOP_PORT"),
            second.env.get("DESKTOP_PORT"),
            "a second operation should not start another server"
        );
    }

    #[tokio::test]
    async fn concurrent_sessions_get_distinct_tokens() {
        let state = TrampolineState::new();
        let first = state.session_for("/one", false).await.expect("binds");
        let second = state.session_for("/two", true).await.expect("binds");

        assert_ne!(first.session.token(), second.session.token());
        assert!(state.tokens.is_valid(first.session.token()));
        assert!(state.tokens.is_valid(second.session.token()));
    }

    #[tokio::test]
    async fn the_user_agent_names_git_and_rdc() {
        let state = TrampolineState::new();
        let agent = state.user_agent().await;

        assert!(agent.starts_with("git/"), "got {agent:?}");
        assert!(agent.contains("rdc/"), "got {agent:?}");
    }

    #[tokio::test]
    async fn the_user_agent_is_resolved_once() {
        let state = TrampolineState::new();
        assert_eq!(state.user_agent().await, state.user_agent().await);
    }
}
