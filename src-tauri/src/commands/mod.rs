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

pub mod branch;
pub mod editor;
pub mod error;
pub mod files;
pub mod git;
pub mod keybindings;
pub mod log;
pub mod menu;
pub mod misc;
pub mod remote;
pub mod shell;
pub mod stash;
pub mod window;
pub mod worktree;

pub use error::CommandError;
