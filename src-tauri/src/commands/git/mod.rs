//! The git half of the IPC surface.
//!
//! One module per frontend feature, named from `src/features/` rather than from the git subcommand
//! it runs — the git subcommand is `git-ops`' axis, and a command's job is to serve one part of the
//! UI. "Which file is this command in" should have the same answer as "which part of the UI calls
//! it". See BACKEND_STRUCTURE.md.
//!
//! Three modules are not feature folders, and each earns it:
//!
//! - [`diffs`] because both changes and history ask for diffs, mirroring the frontend's `lib/diff/`.
//! - [`gitignore`], [`lfs`], [`trailers`], [`tags`], [`submodules`] because each is a small subject
//!   with no feature folder of its own, and filing them under `repositories` would rebuild the
//!   drawer this layout replaced.
//! - [`operation_lifecycle`], which holds no commands at all — it is the per-operation-kind
//!   machinery the domain modules share.
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
