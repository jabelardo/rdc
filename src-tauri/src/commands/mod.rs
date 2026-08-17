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
//! The surface is split by what a command reaches for — see BACKEND_STRUCTURE.md. [`git`] uses
//! `git_ops` and may not name `crate::platform`; [`platform`] adapts `crate::platform` and may not
//! name `git_ops`. Both directions are checked by `tests/structure.rs`.
//!
//! [`error`] and [`operations`] are neither, and stay here as single modules: the error contract
//! belongs to the whole surface, and the operation registry is the app's own service rather than
//! git's or the OS's.

pub mod git;
pub mod platform;

pub mod error;
pub mod operations;

pub use error::CommandError;
