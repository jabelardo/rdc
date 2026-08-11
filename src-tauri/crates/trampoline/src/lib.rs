//! The credential/askpass bridge between git and rdc.
//!
//! Replaces two things from `desktop-plus`: the vendored `desktop-trampoline` **C binary** (a
//! per-platform native addon built with node-gyp) and the TypeScript half in
//! `app/src/lib/trampoline/**`. One Rust crate covers both ends, which is the improvement recorded
//! in MIGRATION_PLAN.md Phase 2 — no separately-maintained native binary per platform.
//!
//! # How it works
//!
//! git cannot prompt a GUI for credentials, so it invokes a helper program and reads the answer from
//! its stdout. rdc points `GIT_ASKPASS`/`SSH_ASKPASS`/the credential helper at the `rdc-trampoline`
//! binary and passes it a port and a token:
//!
//! ```text
//!  git  ──spawns──>  rdc-trampoline  ──TCP 127.0.0.1──>  rdc (TrampolineServer)
//!   ^                      │                                      │
//!   └────── stdout ────────┘<────────── reply ───────────────────┘
//! ```
//!
//! The binary is deliberately dumb: it forwards its argv, environment and stdin, prints whatever
//! comes back, and exits. All decisions live in the app.
//!
//! # The handlers, and what they still need
//!
//! [`handlers`] implements both: prompt classification, github.com host-key pinning, the
//! credential-helper `get`/`store`/`erase` dispatch, and the rule that a background task never
//! prompts. The two decisions that genuinely need things this crate doesn't own — *which account
//! applies* (accounts store, OS keychain) and *what the user says* (UI) — are the
//! [`handlers::CredentialProvider`] and [`handlers::AskpassResponder`] traits, arriving with Phase 7.
//!
//! [`handlers::Decline`] implements both by refusing, which is the correct behaviour rather than a
//! stub: declining makes git consult its own credential helpers, so SSH agents and system credential
//! managers keep working.
//!
//! [`session`] holds per-operation state and produces the environment that points git here — the piece
//! `push`/`pull`/`fetch` cannot authenticate without.

#![warn(clippy::all)]

pub mod client;
pub mod credential;
pub mod handlers;
pub mod protocol;
pub mod server;
pub mod session;
pub mod token;

pub use client::{port_from_env, send, ClientError};
pub use credential::{Credential, CredentialError, HelperCommand};
pub use handlers::{
    askpass_handler, askpass_handler_with_wait, classify_askpass, credential_helper_handler,
    credential_helper_handler_with_wait, parse_add_ssh_host_prompt, AddSshHostPrompt,
    AskpassRequest, AskpassResponder, BoxFuture, CredentialAnswer, CredentialProvider, Decline,
    PromptWaitHooks,
};
pub use protocol::{
    decode, encode, Command, CommandIdentifier, ProtocolError, IDENTIFIER_ENV, PORT_ENV, TOKEN_ENV,
};
pub use server::{handler, Handler, TrampolineServer};
pub use session::{is_cancelled_authentication, Session, SessionState, SessionStore};
pub use token::TokenStore;
