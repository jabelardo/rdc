//! Tauri commands — the IPC surface the frontend calls.
//!
//! rdc uses **Tauri's native IPC** (`#[tauri::command]` + `invoke`, and events/channels for the
//! Rust→frontend direction) rather than a binding generator. That means the TypeScript types in
//! `src/models/**` are hand-written; `crates/git-ops/tests/wire_contract.rs` pins the JSON shapes so
//! a Rust change that would break them fails a Rust test rather than surfacing as `undefined` in the
//! webview.
//!
//! Conventions here, from <https://v2.tauri.app/develop/calling-rust/>:
//! - Arguments arrive **camelCase** from JavaScript by default, so a Rust `repository_path`
//!   parameter is passed as `repositoryPath`.
//! - Every command returns `Result<T, CommandError>`; the error type must implement `Serialize`, and
//!   a panic must never cross the boundary.
//! - Commands doing IO are `async`, so they run off the main thread and can't freeze the UI.
//!
//! # Layout
//!
//! The surface is split by what a command reaches for — see BACKEND_STRUCTURE.md. [`platform`]
//! adapts `crate::platform` and may not name `git_ops`; the git modules use `git_ops` and may not
//! name `crate::platform`. [`error`] and [`operation`] are neither, and stay here as single
//! modules.

pub mod platform;

pub mod branches;
pub mod changes;
pub mod conflicts;
pub mod diffs;
pub mod history;
pub mod hooks;
pub mod repositories;

pub mod misc;
pub mod remote;
pub mod stash;
pub mod worktree;

pub mod error;
pub mod operation;
pub mod operation_lifecycle;

pub use error::CommandError;
