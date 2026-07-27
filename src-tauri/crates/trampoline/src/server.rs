//! The server half: the app listening for the trampoline binary.
//!
//! Ported from `desktop-plus/app/src/lib/trampoline/trampoline-server.ts`.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::protocol::{decode, Command, CommandIdentifier};
use crate::token::TokenStore;

/// Handles one kind of command, returning what the binary should print to stdout.
///
/// `None` means "no answer" — the binary prints nothing, which is how the original signalled e.g. a
/// cancelled credential prompt.
pub type Handler = Arc<
    dyn Fn(Command) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>
        + Send
        + Sync,
>;

/// Wraps an async closure as a [`Handler`].
pub fn handler<F, Fut>(f: F) -> Handler
where
    F: Fn(Command) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    Arc::new(move |command| Box::pin(f(command)))
}

/// Accepts trampoline connections on loopback and dispatches them to handlers.
///
/// Bound to `127.0.0.1` on an ephemeral port, so it is never reachable off-machine. Authentication
/// is by token — see [`TokenStore`] for why that, and not the port, is the security boundary.
pub struct TrampolineServer {
    tokens: TokenStore,
    handlers: Arc<Mutex<HashMap<CommandIdentifier, Handler>>>,
}

impl TrampolineServer {
    pub fn new(tokens: TokenStore) -> Self {
        Self {
            tokens,
            handlers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Registers the handler for a command kind, replacing any previous one.
    pub async fn register(&self, identifier: CommandIdentifier, handler: Handler) {
        self.handlers.lock().await.insert(identifier, handler);
    }

    /// Binds and starts accepting, returning the port to hand to git.
    ///
    /// The accept loop runs as a detached task. The original started lazily on the first remote
    /// operation and stayed closed after an error so the next operation would retry cleanly; the
    /// same laziness belongs in the caller that owns this, not here.
    pub async fn listen(&self) -> std::io::Result<u16> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();

        let tokens = self.tokens.clone();
        let handlers = Arc::clone(&self.handlers);

        tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = listener.accept().await else {
                    // The listener is gone (app shutting down); stop rather than spinning.
                    break;
                };

                let tokens = tokens.clone();
                let handlers = Arc::clone(&handlers);
                // One task per connection: a slow credential prompt must not block other git
                // processes waiting on their own askpass call.
                tokio::spawn(async move {
                    serve_connection(stream, tokens, handlers).await;
                });
            }
        });

        Ok(port)
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    tokens: TokenStore,
    handlers: Arc<Mutex<HashMap<CommandIdentifier, Handler>>>,
) {
    let mut request = Vec::new();
    // The client half-closes after writing, so read-to-end terminates without needing a length
    // prefix.
    if stream.read_to_end(&mut request).await.is_err() {
        return;
    }

    let Ok(command) = decode(&request) else {
        // Malformed request: close without a reply. Saying *why* would help an attacker probe the
        // protocol, and git has no use for the detail.
        let _ = stream.shutdown().await;
        return;
    };

    // The security check. Anything on the machine can connect to the port, so an unauthenticated
    // request gets nothing — not an error message, not a hint that the token was the problem.
    if !tokens.is_valid(&command.token) {
        let _ = stream.shutdown().await;
        return;
    }

    let handler = handlers.lock().await.get(&command.identifier).cloned();
    let Some(handler) = handler else {
        let _ = stream.shutdown().await;
        return;
    };

    if let Some(response) = handler(command).await {
        let _ = stream.write_all(response.as_bytes()).await;
    }
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::send;
    use crate::protocol::{IDENTIFIER_ENV, TOKEN_ENV};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn env(identifier: CommandIdentifier, token: &str) -> HashMap<String, String> {
        HashMap::from([
            (IDENTIFIER_ENV.to_owned(), identifier.as_str().to_owned()),
            (TOKEN_ENV.to_owned(), token.to_owned()),
        ])
    }

    /// A server with an askpass handler echoing a fixed answer, plus its port and token store.
    async fn server_with_askpass(answer: &'static str) -> (u16, TokenStore) {
        let tokens = TokenStore::new();
        let server = TrampolineServer::new(tokens.clone());
        server
            .register(
                CommandIdentifier::AskPass,
                handler(move |_command| async move { Some(answer.to_owned()) }),
            )
            .await;
        let port = server.listen().await.expect("should bind");
        // The accept loop holds what it needs; dropping the handle must not stop it.
        std::mem::forget(server);
        (port, tokens)
    }

    #[tokio::test]
    async fn answers_an_authenticated_command() {
        let (port, tokens) = server_with_askpass("hunter2").await;
        let token = tokens.issue();

        let response = send(
            port,
            &["Password for 'https://github.com':".to_owned()],
            &env(CommandIdentifier::AskPass, &token),
            "",
        )
        .await
        .expect("should reach the server");

        assert_eq!(response, "hunter2");
    }

    #[tokio::test]
    async fn passes_parameters_and_stdin_to_the_handler() {
        let tokens = TokenStore::new();
        let server = TrampolineServer::new(tokens.clone());
        server
            .register(
                CommandIdentifier::CredentialHelper,
                handler(|command| async move {
                    Some(format!(
                        "params={:?} stdin={:?}",
                        command.parameters, command.stdin
                    ))
                }),
            )
            .await;
        let port = server.listen().await.expect("should bind");
        std::mem::forget(server);

        let token = tokens.issue();
        let response = send(
            port,
            &["get".to_owned()],
            &env(CommandIdentifier::CredentialHelper, &token),
            "protocol=https\nhost=github.com\n\n",
        )
        .await
        .expect("should reach the server");

        assert_eq!(
            response,
            r#"params=["get"] stdin="protocol=https\nhost=github.com\n\n""#
        );
    }

    #[tokio::test]
    async fn rejects_an_invalid_token_without_invoking_the_handler() {
        // The core security property: a local process that guessed the port gets nothing.
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);

        let tokens = TokenStore::new();
        let server = TrampolineServer::new(tokens.clone());
        server
            .register(
                CommandIdentifier::AskPass,
                handler(move |_| {
                    let observed = Arc::clone(&observed);
                    async move {
                        observed.fetch_add(1, Ordering::SeqCst);
                        Some("secret".to_owned())
                    }
                }),
            )
            .await;
        let port = server.listen().await.expect("should bind");
        std::mem::forget(server);

        let response = send(
            port,
            &[],
            &env(CommandIdentifier::AskPass, "forged-token"),
            "",
        )
        .await
        .expect("the connection itself succeeds");

        assert_eq!(response, "", "no answer, and no hint about why");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "the handler must not run");
    }

    #[tokio::test]
    async fn rejects_a_revoked_token() {
        // Tokens are scoped to one git operation; reuse after it finishes must fail.
        let (port, tokens) = server_with_askpass("hunter2").await;
        let token = tokens.issue();
        tokens.revoke(&token);

        let response = send(port, &[], &env(CommandIdentifier::AskPass, &token), "")
            .await
            .expect("the connection itself succeeds");
        assert_eq!(response, "");
    }

    #[tokio::test]
    async fn ignores_a_command_with_no_registered_handler() {
        let (port, tokens) = server_with_askpass("hunter2").await;
        let token = tokens.issue();

        // Authenticated, but nothing handles CredentialHelper on this server.
        let response = send(
            port,
            &["get".to_owned()],
            &env(CommandIdentifier::CredentialHelper, &token),
            "",
        )
        .await
        .expect("the connection itself succeeds");
        assert_eq!(response, "");
    }

    #[tokio::test]
    async fn survives_a_malformed_request() {
        // A garbage request must not take the server down: the next valid request still works.
        let (port, tokens) = server_with_askpass("hunter2").await;

        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("should connect");
        stream
            .write_all(b"total nonsense")
            .await
            .expect("should write");
        stream.shutdown().await.expect("should shutdown");
        drop(stream);

        let token = tokens.issue();
        let response = send(port, &[], &env(CommandIdentifier::AskPass, &token), "")
            .await
            .expect("the server should still be listening");
        assert_eq!(response, "hunter2");
    }

    #[tokio::test]
    async fn handles_a_handler_that_declines_to_answer() {
        // `None` models a cancelled prompt: git should see empty output, not an error.
        let tokens = TokenStore::new();
        let server = TrampolineServer::new(tokens.clone());
        server
            .register(CommandIdentifier::AskPass, handler(|_| async { None }))
            .await;
        let port = server.listen().await.expect("should bind");
        std::mem::forget(server);

        let token = tokens.issue();
        let response = send(port, &[], &env(CommandIdentifier::AskPass, &token), "")
            .await
            .expect("should reach the server");
        assert_eq!(response, "");
    }

    #[tokio::test]
    async fn serves_concurrent_connections() {
        // git can have several processes asking at once; a slow prompt must not serialize them.
        let (port, tokens) = server_with_askpass("hunter2").await;
        let token = tokens.issue();

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let token = token.clone();
            tasks.push(tokio::spawn(async move {
                send(port, &[], &env(CommandIdentifier::AskPass, &token), "").await
            }));
        }

        for task in tasks {
            let response = task
                .await
                .expect("task should not panic")
                .expect("should reach");
            assert_eq!(response, "hunter2");
        }
    }
}
