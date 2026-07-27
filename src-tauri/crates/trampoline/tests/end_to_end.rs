//! End-to-end: the real `rdc-trampoline` binary talking to a real server.
//!
//! The unit tests exercise each half against the other in-process, which can't catch a mismatch
//! between what the *binary* sends and what the server expects — argv handling, environment
//! forwarding, the stdin decision, or how the reply reaches stdout. This spawns the actual compiled
//! binary the way git would, so those are covered.
//!
//! `CARGO_BIN_EXE_rdc-trampoline` is set by Cargo for integration tests, so the binary under test is
//! always the one built from this source.

use std::collections::HashMap;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use trampoline::{
    handler, CommandIdentifier, TokenStore, TrampolineServer, IDENTIFIER_ENV, PORT_ENV, TOKEN_ENV,
};

/// Starts a server whose askpass handler reports what it received, and returns port + tokens.
async fn start_server() -> (u16, TokenStore) {
    let tokens = TokenStore::new();
    let server = TrampolineServer::new(tokens.clone());

    server
        .register(
            CommandIdentifier::AskPass,
            handler(
                |command| async move { Some(format!("askpass:{}", command.parameters.join("|"))) },
            ),
        )
        .await;
    server
        .register(
            CommandIdentifier::CredentialHelper,
            handler(|command| async move {
                Some(format!(
                    "helper:params={};stdin={}",
                    command.parameters.join("|"),
                    command.stdin.replace('\n', "\\n")
                ))
            }),
        )
        .await;

    let port = server.listen().await.expect("the server should bind");
    // The accept loop owns what it needs; keep the handle alive for the test's duration.
    std::mem::forget(server);
    (port, tokens)
}

/// Runs the trampoline binary the way git would, returning (stdout, stderr, success).
async fn run_trampoline(
    environment: &HashMap<String, String>,
    args: &[&str],
    stdin: Option<&str>,
) -> (String, String, bool) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rdc-trampoline"));
    command
        .args(args)
        // env_clear so the test controls exactly what the binary sees; inheriting the harness's
        // environment could mask a missing variable.
        .env_clear()
        .envs(environment)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().expect("the binary should start");

    if let Some(stdin) = stdin {
        let mut handle = child.stdin.take().expect("stdin should be piped");
        handle
            .write_all(stdin.as_bytes())
            .await
            .expect("should write stdin");
        handle.shutdown().await.expect("should close stdin");
    }

    let output = child.wait_with_output().await.expect("should complete");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.success(),
    )
}

fn env(port: u16, identifier: CommandIdentifier, token: &str) -> HashMap<String, String> {
    HashMap::from([
        (PORT_ENV.to_owned(), port.to_string()),
        (IDENTIFIER_ENV.to_owned(), identifier.as_str().to_owned()),
        (TOKEN_ENV.to_owned(), token.to_owned()),
    ])
}

#[tokio::test]
async fn binary_relays_an_askpass_prompt_and_prints_the_reply() {
    let (port, tokens) = start_server().await;
    let token = tokens.issue();

    let (stdout, stderr, ok) = run_trampoline(
        &env(port, CommandIdentifier::AskPass, &token),
        &["Password for 'https://github.com':"],
        None,
    )
    .await;

    assert!(ok, "the binary should succeed; stderr: {stderr}");
    assert_eq!(stdout, "askpass:Password for 'https://github.com':");
}

#[tokio::test]
async fn binary_prints_the_reply_verbatim_with_no_trailing_newline() {
    // git takes stdout as the credential itself, so an added newline would corrupt a password.
    let (port, tokens) = start_server().await;
    let token = tokens.issue();

    let (stdout, _stderr, ok) =
        run_trampoline(&env(port, CommandIdentifier::AskPass, &token), &[], None).await;

    assert!(ok);
    assert_eq!(stdout, "askpass:");
    assert!(!stdout.ends_with('\n'), "got {stdout:?}");
}

#[tokio::test]
async fn binary_forwards_stdin_for_the_credential_helper() {
    let (port, tokens) = start_server().await;
    let token = tokens.issue();

    let (stdout, stderr, ok) = run_trampoline(
        &env(port, CommandIdentifier::CredentialHelper, &token),
        &["get"],
        Some("protocol=https\nhost=github.com\n\n"),
    )
    .await;

    assert!(ok, "stderr: {stderr}");
    assert_eq!(
        stdout,
        "helper:params=get;stdin=protocol=https\\nhost=github.com\\n\\n"
    );
}

#[tokio::test]
async fn binary_does_not_block_waiting_for_askpass_stdin() {
    // askpass invocations get no stdin. If the binary read stdin unconditionally it would hang here
    // until git closed the pipe, deadlocking the credential prompt — this is the regression guard.
    let (port, tokens) = start_server().await;
    let token = tokens.issue();

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        run_trampoline(
            &env(port, CommandIdentifier::AskPass, &token),
            &["Username:"],
            // Piped but never written to and never closed until the child exits.
            Some(""),
        ),
    )
    .await;

    let (stdout, _stderr, ok) = result.expect("the binary must not hang on stdin");
    assert!(ok);
    assert_eq!(stdout, "askpass:Username:");
}

#[tokio::test]
async fn binary_reports_a_missing_port_on_stderr_and_fails() {
    // Invoked outside a git operation. The diagnostic must not go to stdout, where git would treat
    // it as the credential.
    let environment = HashMap::from([
        (IDENTIFIER_ENV.to_owned(), "ASKPASS".to_owned()),
        (TOKEN_ENV.to_owned(), "irrelevant".to_owned()),
    ]);

    let (stdout, stderr, ok) = run_trampoline(&environment, &[], None).await;

    assert!(!ok, "should exit non-zero");
    assert_eq!(stdout, "", "nothing on stdout, or git would use it");
    assert!(stderr.contains(PORT_ENV), "got {stderr:?}");
}

#[tokio::test]
async fn binary_gets_no_answer_with_a_forged_token() {
    // The security property, end to end: knowing the port isn't enough.
    let (port, _tokens) = start_server().await;

    let (stdout, _stderr, ok) = run_trampoline(
        &env(port, CommandIdentifier::AskPass, "forged"),
        &["Password:"],
        None,
    )
    .await;

    assert!(ok, "the exchange itself succeeds");
    assert_eq!(stdout, "", "but there is no credential and no hint why");
}

#[tokio::test]
async fn binary_fails_cleanly_when_the_app_is_not_listening() {
    // Port 1 on loopback isn't listening. git should see a failure, not a hang.
    let environment = HashMap::from([
        (PORT_ENV.to_owned(), "1".to_owned()),
        (IDENTIFIER_ENV.to_owned(), "ASKPASS".to_owned()),
        (TOKEN_ENV.to_owned(), "irrelevant".to_owned()),
    ]);

    let (stdout, stderr, ok) = run_trampoline(&environment, &[], None).await;

    assert!(!ok);
    assert_eq!(stdout, "");
    assert!(!stderr.is_empty(), "should explain itself on stderr");
}
