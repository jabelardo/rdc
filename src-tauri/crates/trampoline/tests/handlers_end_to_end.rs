//! End-to-end: the real `rdc-trampoline` binary talking to the **real handlers**.
//!
//! `end_to_end.rs` proves the binary and server agree on the wire format, using stub handlers that
//! echo what they received. This proves the actual decision logic answers correctly through that same
//! path — the github.com fingerprint pinning, the credential-helper reply format, and the rule that a
//! background task never prompts.
//!
//! Together they cover the two ways this can break: a protocol mismatch, and a handler that decides
//! the right thing in a unit test but never gets reached.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use trampoline::{
    askpass_handler, credential_helper_handler, AddSshHostPrompt, AskpassResponder, BoxFuture,
    CommandIdentifier, CredentialAnswer, CredentialProvider, Decline, SessionStore, TokenStore,
    TrampolineServer, IDENTIFIER_ENV, PORT_ENV, TOKEN_ENV,
};

/// github.com's current Ed25519 fingerprint, from GitHub's published list.
const GITHUB_ED25519: &str = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
/// The RSA key GitHub rotated in March 2023 after its private half was exposed.
const GITHUB_RETIRED_RSA: &str = "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8";

/// Answers with a fixed credential, so the reply format can be checked.
struct FixedCredential;

impl CredentialProvider for FixedCredential {
    fn lookup(
        &self,
        _endpoint: String,
        _username: Option<String>,
    ) -> BoxFuture<Option<CredentialAnswer>> {
        Box::pin(async {
            Some(CredentialAnswer {
                username: "octocat".to_owned(),
                password: "ghp_token".to_owned(),
            })
        })
    }
    fn store(&self, _: String, _: CredentialAnswer) -> BoxFuture<()> {
        Box::pin(async {})
    }
    fn erase(&self, _: String, _: String) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

/// Would trust any host, so a test can tell "was asked" from "was pinned" or "was suppressed".
struct TrustEverything;

impl AskpassResponder for TrustEverything {
    fn ssh_key_passphrase(&self, _: String) -> BoxFuture<Option<String>> {
        Box::pin(async { Some("from-the-responder".to_owned()) })
    }
    fn ssh_user_password(&self, _: String) -> BoxFuture<Option<String>> {
        Box::pin(async { None })
    }
    fn confirm_ssh_host(&self, _: AddSshHostPrompt) -> BoxFuture<Option<bool>> {
        Box::pin(async { Some(true) })
    }
}

struct Harness {
    port: u16,
    sessions: SessionStore,
    tokens: TokenStore,
}

/// Starts a server wired with the real handlers.
async fn start(
    responder: Arc<dyn AskpassResponder>,
    provider: Arc<dyn CredentialProvider>,
) -> Harness {
    let tokens = TokenStore::new();
    let sessions = SessionStore::new();
    let server = TrampolineServer::new(tokens.clone());

    server
        .register(
            CommandIdentifier::AskPass,
            askpass_handler(responder, sessions.clone()),
        )
        .await;
    server
        .register(
            CommandIdentifier::CredentialHelper,
            credential_helper_handler(provider, sessions.clone()),
        )
        .await;

    let port = server.listen().await.expect("the server should bind");
    // The accept loop owns what it needs; keep the handle alive for the test's duration.
    std::mem::forget(server);

    Harness {
        port,
        sessions,
        tokens,
    }
}

/// Runs the trampoline binary the way git would.
async fn run(
    harness: &Harness,
    identifier: CommandIdentifier,
    token: &str,
    args: &[&str],
    stdin: Option<&str>,
) -> String {
    let environment = HashMap::from([
        (PORT_ENV.to_owned(), harness.port.to_string()),
        (TOKEN_ENV.to_owned(), token.to_owned()),
        (IDENTIFIER_ENV.to_owned(), identifier.as_str().to_owned()),
    ]);

    let mut command = Command::new(env!("CARGO_BIN_EXE_rdc-trampoline"));
    command
        .args(args)
        .env_clear()
        .envs(&environment)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().expect("the binary should start");

    if let Some(stdin) = stdin {
        let mut handle = child.stdin.take().expect("stdin should be piped");
        handle
            .write_all(stdin.as_bytes())
            .await
            .expect("writing stdin should succeed");
        handle
            .shutdown()
            .await
            .expect("closing stdin should succeed");
    }

    let output = child
        .wait_with_output()
        .await
        .expect("the binary should exit");

    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn host_prompt(fingerprint: &str, key_type: &str) -> String {
    format!(
        "The authenticity of host 'github.com (140.82.121.4)' can't be established.\n{key_type} key fingerprint is {fingerprint}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
    )
}

#[tokio::test]
async fn auto_accepts_githubs_current_host_key_through_the_real_binary() {
    let harness = start(Arc::new(Decline), Arc::new(Decline)).await;
    // Deliberately a background session: a pinned key is accepted even where prompting is forbidden.
    let session = harness.sessions.begin(&harness.tokens, "/repo", true);

    let stdout = run(
        &harness,
        CommandIdentifier::AskPass,
        session.token(),
        &[&host_prompt(GITHUB_ED25519, "ED25519")],
        None,
    )
    .await;

    assert_eq!(stdout.trim(), "yes");
}

#[tokio::test]
async fn never_auto_accepts_githubs_retired_rsa_key() {
    // The security fix, end to end. `Decline` cannot answer, so a "yes" here could only come from the
    // fingerprint pinning — and it must not.
    let harness = start(Arc::new(Decline), Arc::new(Decline)).await;
    let session = harness.sessions.begin(&harness.tokens, "/repo", false);

    let stdout = run(
        &harness,
        CommandIdentifier::AskPass,
        session.token(),
        &[&host_prompt(GITHUB_RETIRED_RSA, "RSA")],
        None,
    )
    .await;

    assert!(
        stdout.trim().is_empty(),
        "the retired key must not be trusted, got {stdout:?}"
    );
}

#[tokio::test]
async fn asks_the_responder_about_an_unpinned_host() {
    let harness = start(Arc::new(TrustEverything), Arc::new(Decline)).await;
    let session = harness.sessions.begin(&harness.tokens, "/repo", false);

    let prompt = "The authenticity of host 'example.com (1.2.3.4)' can't be established.\nRSA key fingerprint is SHA256:whatever.\n";
    let stdout = run(
        &harness,
        CommandIdentifier::AskPass,
        session.token(),
        &[prompt],
        None,
    )
    .await;

    assert_eq!(stdout.trim(), "yes");
}

#[tokio::test]
async fn a_background_task_gets_no_answer_for_an_unpinned_host() {
    // Same responder as above, which would say yes. The suppression is what is being tested.
    let harness = start(Arc::new(TrustEverything), Arc::new(Decline)).await;
    let session = harness.sessions.begin(&harness.tokens, "/repo", true);

    let prompt = "The authenticity of host 'example.com (1.2.3.4)' can't be established.\nRSA key fingerprint is SHA256:whatever.\n";
    let stdout = run(
        &harness,
        CommandIdentifier::AskPass,
        session.token(),
        &[prompt],
        None,
    )
    .await;

    assert!(
        stdout.trim().is_empty(),
        "a background task must never prompt, got {stdout:?}"
    );
}

#[tokio::test]
async fn answers_a_credential_get_in_the_format_git_parses() {
    let harness = start(Arc::new(Decline), Arc::new(FixedCredential)).await;
    let session = harness.sessions.begin(&harness.tokens, "/repo", false);

    let stdout = run(
        &harness,
        CommandIdentifier::CredentialHelper,
        session.token(),
        &["get"],
        Some("protocol=https\nhost=github.com\n\n"),
    )
    .await;

    // git reads `key=value` lines; the fields it sent must survive alongside the answer.
    let lines: Vec<&str> = stdout.lines().collect();
    assert!(lines.contains(&"protocol=https"), "got {lines:?}");
    assert!(lines.contains(&"host=github.com"), "got {lines:?}");
    assert!(lines.contains(&"username=octocat"), "got {lines:?}");
    assert!(lines.contains(&"password=ghp_token"), "got {lines:?}");
}

#[tokio::test]
async fn a_declined_credential_get_records_the_endpoint_and_answers_nothing() {
    let harness = start(Arc::new(Decline), Arc::new(Decline)).await;
    let session = harness.sessions.begin(&harness.tokens, "/repo", false);

    let stdout = run(
        &harness,
        CommandIdentifier::CredentialHelper,
        session.token(),
        &["get"],
        Some("protocol=https\nhost=github.com\n\n"),
    )
    .await;

    assert!(stdout.trim().is_empty(), "got {stdout:?}");
    assert!(
        session.has_rejected_endpoints(),
        "the rejection must be recorded, so a later 'prompts disabled' failure can be recognised"
    );
}

#[tokio::test]
async fn an_invalid_token_gets_no_answer_even_from_a_willing_handler() {
    // The security boundary is the token, not the port. `FixedCredential` would always answer.
    let harness = start(Arc::new(Decline), Arc::new(FixedCredential)).await;
    let _session = harness.sessions.begin(&harness.tokens, "/repo", false);

    let stdout = run(
        &harness,
        CommandIdentifier::CredentialHelper,
        "not-a-real-token",
        &["get"],
        Some("protocol=https\nhost=github.com\n\n"),
    )
    .await;

    assert!(stdout.trim().is_empty(), "got {stdout:?}");
}
