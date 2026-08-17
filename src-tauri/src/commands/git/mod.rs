//! The git half of the IPC surface.
//!
//! One module per frontend capability rather than per git subcommand — the git subcommand is
//! `git-ops`' axis, and a command's job is to serve one part of the UI. Start with the vocabulary in
//! `src/features/`; smaller IPC-only capabilities keep their established frontend names. "Which
//! file is this command in" should have the same answer as "which part of the UI calls it". See
//! BACKEND_STRUCTURE.md.
//!
//! [`operation_lifecycle`] is the one shared module and holds no commands at all: it is the
//! per-operation-kind machinery the capability modules share.
//!
//! A module here may use `git_ops` and may not name `crate::platform`; [`super::platform`] is the
//! mirror of that rule. Both directions are checked.

pub mod branches;
pub mod changes;
pub mod conflicts;
pub mod diffs;
pub mod gitignore;
pub mod history;
pub mod hooks;
pub mod lfs;
pub mod operation_lifecycle;
pub mod remotes;
pub mod repositories;
pub mod stash;
pub mod submodules;
pub mod tags;
pub mod trailers;
pub mod worktree;
