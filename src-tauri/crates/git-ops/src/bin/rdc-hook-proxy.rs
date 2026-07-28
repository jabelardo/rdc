//! The binary git runs in place of a hook.
//!
//! Replaces the native binary the `process-proxy` npm package shipped. One copy of this is placed in a
//! temporary directory under each hook's name, and `core.hooksPath` points git at that directory — so
//! the name it is invoked as says which hook it stands in for.
//!
//! Deliberately minimal, like `rdc-trampoline`: forward the invocation, relay stderr, exit with the
//! hook's code. Every decision — which shell environment to use, whether a failure may be ignored —
//! lives in the app.
//!
//! # It fails closed
//!
//! If the app can't be reached, or goes away without reporting an exit code, this exits **non-zero**. A
//! hook that didn't run is not a hook that passed: reporting success would let a commit through that the
//! user's `pre-commit` hook would have blocked. The cost of the opposite choice is a confusing failure;
//! the cost of this one is unreviewed code in a commit.

use std::collections::HashMap;
use std::io::Write;
use std::process::ExitCode;

use git_ops::hooks::client::{hook_name_from_argv0, port_from_env, run, token_from_env};
use git_ops::hooks::protocol::HookRequest;

/// Hooks that read stdin. Anything else is not read at all.
///
/// git only pipes stdin to a few hooks, and reading it for the others would block until git closed the
/// pipe — the same trap `rdc-trampoline` documents for askpass. `git hook run` is on the other side of
/// this: it needs the data as a file, so it has to be read in full before the hook starts.
const HOOKS_WITH_STDIN: [&str; 5] = [
    "pre-push",
    "pre-receive",
    "post-receive",
    "post-rewrite",
    "reference-transaction",
];

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    // Single-threaded: this process relays one invocation and git waits for it, so a thread pool would
    // be pure startup cost on something spawned once per hook.
    let environment: HashMap<String, String> = std::env::vars().collect();
    let mut argv = std::env::args();

    let argv0 = argv.next().unwrap_or_default();
    let hook = hook_name_from_argv0(&argv0);
    let arguments: Vec<String> = argv.collect();

    let port = match port_from_env(&environment) {
        Ok(port) => port,
        Err(error) => return fail(&hook, &format!("{error}")),
    };
    let token = match token_from_env(&environment) {
        Ok(token) => token,
        Err(error) => return fail(&hook, &format!("{error}")),
    };

    let stdin = if HOOKS_WITH_STDIN.contains(&hook.as_str()) {
        use std::io::Read;

        let mut buffer = Vec::new();
        if let Err(error) = std::io::stdin().read_to_end(&mut buffer) {
            return fail(&hook, &format!("could not read stdin: {error}"));
        }
        buffer
    } else {
        Vec::new()
    };

    let cwd = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

    let request = HookRequest {
        token,
        hook: hook.clone(),
        arguments,
        environment,
        cwd,
        stdin,
    };

    // Written straight through to stderr as it arrives, unbuffered by us: git captures hook output from
    // stderr, and holding it back would defeat the point of streaming it.
    let result = run(port, &request, |chunk| {
        let _ = std::io::stderr().write_all(chunk);
    })
    .await;

    match result {
        Ok(code) => {
            // Faithfully whatever the hook exited with, so git behaves as if it had run it.
            ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
        Err(error) => fail(&hook, &format!("{error}")),
    }
}

/// Reports a failure on stderr and exits non-zero.
///
/// The hook's name is included because git says only that "the hook failed" — without it the user has no
/// way to tell which one, or that the failure came from rdc rather than their script.
fn fail(hook: &str, message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "rdc-hook-proxy ({hook}): {message}");
    ExitCode::FAILURE
}
