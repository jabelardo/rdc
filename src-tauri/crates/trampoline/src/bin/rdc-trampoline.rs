//! The binary git invokes for credentials.
//!
//! Replaces the vendored `desktop-trampoline` C program. Deliberately minimal: forward argv,
//! environment and stdin to the app, print the reply, exit. Every decision lives in the app.
//!
//! git and ssh both use the "print the answer to stdout" convention, so this works as `GIT_ASKPASS`,
//! `SSH_ASKPASS` and a git credential helper without behaving differently.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::ExitCode;

use trampoline::{port_from_env, protocol::IDENTIFIER_ENV, send};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    // Single-threaded runtime: this process exists to relay one message, so a thread pool would be
    // pure startup cost on something git spawns synchronously and waits for.
    let environment: HashMap<String, String> = std::env::vars().collect();

    // argv[0] is the program name, which the app doesn't need — matching the original's
    // "parameters correspond to argv except the name of the program".
    let parameters: Vec<String> = std::env::args().skip(1).collect();

    let port = match port_from_env(&environment) {
        Ok(port) => port,
        Err(error) => return fail(&format!("{error}")),
    };

    // Only the credential helper protocol sends stdin; askpass doesn't, and reading it there would
    // block until git closed the pipe. Deciding by identifier avoids that.
    let stdin = if environment.get(IDENTIFIER_ENV).map(String::as_str) == Some("CREDENTIALHELPER") {
        let mut buffer = String::new();
        if let Err(error) = std::io::stdin().read_to_string(&mut buffer) {
            return fail(&format!("could not read stdin: {error}"));
        }
        buffer
    } else {
        String::new()
    };

    match send(port, &parameters, &environment, &stdin).await {
        Ok(response) => {
            // No trailing newline: git takes the output verbatim, and adding one would corrupt a
            // password.
            if let Err(error) = std::io::stdout().write_all(response.as_bytes()) {
                return fail(&format!("could not write the reply: {error}"));
            }
            ExitCode::SUCCESS
        }
        Err(error) => fail(&format!("{error}")),
    }
}

/// Reports a failure on stderr and exits non-zero.
///
/// stderr rather than stdout, because git treats anything on stdout as the credential itself — a
/// diagnostic printed there would be used as a password.
fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "rdc-trampoline: {message}");
    ExitCode::FAILURE
}
