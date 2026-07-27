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
//! # What is not here yet
//!
//! The **handlers** — deciding which account to use, prompting the user, storing credentials — need
//! account state and UI, so they arrive with Phase 3 (IPC) and Phase 7 (stores/UI). [`server`] takes
//! handlers as injected closures precisely so that boundary stays clean; ported from
//! `trampoline-askpass-handler.ts` and `trampoline-credential-helper.ts`.

#![warn(clippy::all)]

pub mod client;
pub mod protocol;
pub mod server;
pub mod token;

pub use client::{port_from_env, send, ClientError};
pub use protocol::{
    decode, encode, Command, CommandIdentifier, ProtocolError, IDENTIFIER_ENV, PORT_ENV, TOKEN_ENV,
};
pub use server::{handler, Handler, TrampolineServer};
pub use token::TokenStore;
