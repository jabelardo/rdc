//! The OS-facing half of the IPC surface.
//!
//! Most modules here adapt the `src/platform/` module of the same name — `platform::window` for
//! `crate::platform::window`. Three do not, and the exceptions are the reason this says "most":
//! `editor` adapts `platform::editors` and `shell` adapts `platform::shells` (both plural), and
//! `config` adapts the crate-root `crate::config`, there being no `platform::config` at all.
//!
//! The split from the git command modules is by what the command reaches for, and it is checked —
//! a module here may not name `git_ops`. See BACKEND_STRUCTURE.md.

pub mod application_folder;
// Unconditional, unlike `crate::platform::cli_installer` — the command exists on every target and
// refuses on the ones that cannot install it, so the frontend gets an error rather than a missing
// command.
pub mod cli_installer;
pub mod config;
pub mod context_menu;
pub mod credential_store;
pub mod editor;
pub mod files;
pub mod install_id;
pub mod keybindings;
pub mod menu;
pub mod notification;
pub mod shell;
pub mod window;
