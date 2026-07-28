//! Running the user's git hooks with a usable environment.
//!
//! Ported from `desktop-plus/app/src/lib/hooks/**`.
//!
//! # The problem this subsystem exists to solve
//!
//! A hook is a script the user wrote, and it almost always assumes the environment their *terminal*
//! has: a version manager on `PATH` (`nvm`, `rbenv`, `asdf`), tool shims, `~/.local/bin`. A desktop
//! application inherits none of that — on Linux it gets the session's environment, on macOS barely
//! anything at all — so a hook that works in a terminal fails when git is run by the app, usually
//! with `command not found`.
//!
//! Upstream's answer, reproduced here, is to not let git run the hook directly. Instead:
//!
//! 1. Discover which hooks the repository actually has ([`discovery`]).
//! 2. Point `core.hooksPath` at a temporary directory holding a **stand-in binary** named after each
//!    hook, so git runs that instead.
//! 3. The stand-in phones home over loopback, and the app runs the real hook via `git hook run` with
//!    an environment loaded from the user's **login shell** ([`shell_env`]), streaming its output back.
//!
//! That is the same shape as [`trampoline`](../../trampoline), which already does it for credentials:
//! a tiny binary git invokes, a loopback server with a token, and the real decision made in-app.
//!
//! # What is here, and what is not
//!
//! **Here:**
//!
//! - [`discovery`] — which hooks a repository has, honouring `core.hooksPath`.
//! - [`shell`] and [`shell_env`] — the login shell, and the environment it builds. Uses the
//!   `rdc-printenvz` binary.
//! - [`protocol`], [`client`] and [`server`] — the transport between a stand-in and the app, plus the
//!   `rdc-hook-proxy` binary git actually runs. Upstream got this from the `process-proxy` npm package,
//!   which ships a *native binary*, so its wire format is **not in the desktop-plus tree**: this half is
//!   a protocol design rather than a port.
//!
//! - [`runner`] — `git hook run <name>` with that environment plus git's own `GIT_*` variables, stdin
//!   spooled for `--to-stdin`, and a failure offered to the user to ignore.
//! - [`with_env`] — upstream's `withHooksEnv`: a temporary directory of stand-ins, `core.hooksPath`
//!   pointed at it through `GIT_CONFIG_PARAMETERS`, and a server bound for one git invocation.
//!
//! **Not here:** anything that decides *whether* to intercept, or that carries progress to a user.
//! Constructing a [`with_env::HookInterception`] is the decision, and it belongs to the caller —
//! upstream gated it on a feature flag plus a `localStorage` setting, both frontend state. So
//! `commit.rs`, `merge.rs`, `push.rs` and `pull.rs` still don't ask for interception, and their
//! `interceptHooks`/`onHookProgress`/`onHookFailure` deferrals close when the command layer passes one
//! and puts the callbacks on Tauri Channels.
//!
//! # Windows
//!
//! Upstream supports four Windows shells (`git-bash`, `pwsh`, `powershell`, `cmd`), with Git Bash
//! discovery going through the Windows registry, plus MSYS2's own argument quoting. Linux is rdc's
//! primary target, so [`shell`] implements the POSIX path and records the Windows work rather than
//! half-porting it — see the notes there.

pub mod client;
pub mod discovery;
pub mod protocol;
pub mod runner;
pub mod server;
pub mod shell;
pub mod shell_env;
pub mod with_env;

pub use discovery::{get_repo_hooks, KNOWN_HOOKS};
pub use protocol::{HookRequest, HookResponse};
pub use runner::{run_hook, FailureDecision, HookAbort, HookOutcome, HookProgress, HookStatus};
pub use shell::{quote_command, Shell};
pub use shell_env::{get_shell_env, ShellEnv};
pub use with_env::{with_hooks_env, HookInterception};
