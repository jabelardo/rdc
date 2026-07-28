//! The server half: the app listening for hook stand-ins.
//!
//! Replaces the server side of the `process-proxy` npm package, plus the connection-validation and
//! dispatch that `with-hooks-env.ts` wired around it. Modelled on `trampoline::server`, with the
//! differences the streaming protocol forces — see [`crate::hooks::protocol`].

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

pub use crate::hooks::protocol::HookRequest;
use crate::hooks::protocol::{decode_request, tokens_match, HookResponse, MAX_REQUEST_BYTES};

/// Reports a chunk of a hook's stderr as it arrives.
///
/// A plain sender rather than a callback so the runner can hand it to a spawned reader task without
/// borrowing anything.
pub type StderrSink = mpsc::UnboundedSender<Vec<u8>>;

/// Runs one hook and returns its exit code.
///
/// Whatever it sends on the [`StderrSink`] is framed back to the stand-in, which writes it to its own
/// stderr — so it lands where git and the user expect hook output.
pub type HookRunner =
    Arc<dyn Fn(HookRequest, StderrSink) -> Pin<Box<dyn Future<Output = i32> + Send>> + Send + Sync>;

/// Wraps an async closure as a [`HookRunner`].
pub fn runner<F, Fut>(f: F) -> HookRunner
where
    F: Fn(HookRequest, StderrSink) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = i32> + Send + 'static,
{
    Arc::new(move |request, sink| Box::pin(f(request, sink)))
}

/// Accepts hook-proxy connections on loopback for the duration of one git operation.
///
/// # Scope is the security boundary
///
/// Unlike the trampoline's server, which lives as long as the app, this one is created for a single git
/// invocation and dropped with it: a connection here makes the app **run a program**, so the window in
/// which a token is worth anything should be as short as the operation that needs it.
pub struct HookServer {
    listener: TcpListener,
    token: String,
    runner: HookRunner,
}

impl HookServer {
    /// Binds to an ephemeral loopback port.
    ///
    /// `127.0.0.1` rather than `0.0.0.0`, so it is never reachable off-machine — the same reasoning as
    /// the trampoline, and more pressing here.
    pub async fn bind(token: String, runner: HookRunner) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        Ok(Self {
            listener,
            token,
            runner,
        })
    }

    /// The port to hand to git.
    pub fn port(&self) -> std::io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    /// Serves connections until the returned handle is dropped.
    ///
    /// The accept loop is a task rather than something the caller polls, because the caller is busy
    /// awaiting git — and git is what produces these connections.
    pub fn serve(self) -> ServerHandle {
        let Self {
            listener,
            token,
            runner,
        } = self;

        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    // A failed accept is not fatal: the operation may still have hooks to run, and the
                    // next one gets its own connection.
                    continue;
                };

                let token = token.clone();
                let runner = Arc::clone(&runner);
                // One task per connection: hooks of different names can run concurrently, and a slow
                // one must not hold up the next.
                tokio::spawn(async move {
                    serve_connection(stream, &token, runner).await;
                });
            }
        });

        ServerHandle { task }
    }
}

/// Stops the server when dropped.
///
/// Dropping it aborts the accept loop, which is what bounds the token's usefulness to the operation.
pub struct ServerHandle {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Reads one request, runs the hook, and frames the result back.
async fn serve_connection(mut stream: TcpStream, token: &str, runner: HookRunner) {
    let mut buffer = Vec::new();
    // The client half-closes after writing, so reading to end is the frame boundary. Capped, because
    // the peer is unauthenticated until the token inside this message is checked.
    let mut limited = (&mut stream).take(MAX_REQUEST_BYTES as u64 + 1);
    if limited.read_to_end(&mut buffer).await.is_err() {
        return;
    }

    let Ok(request) = decode_request(&buffer) else {
        // Silence rather than a diagnostic: an unparseable message came from something that is not our
        // stand-in, and replying tells it more than it should learn.
        return;
    };

    if !tokens_match(&request.token, token) {
        return;
    }

    let (sender, mut receiver) = mpsc::unbounded_channel();

    // Stderr is forwarded while the hook runs, not collected and sent at the end: the UI shows it live,
    // and a long hook that printed nothing until it finished would look hung.
    let mut hook = Box::pin((runner)(request, sender));

    let exit_code = loop {
        tokio::select! {
            chunk = receiver.recv() => match chunk {
                Some(chunk) => {
                    if stream
                        .write_all(&HookResponse::Stderr(chunk).encode())
                        .await
                        .is_err()
                    {
                        // The stand-in is gone — git was killed, or the operation was abandoned. Stop
                        // writing; the runner sees its sink close.
                        return;
                    }
                }
                // The runner dropped the sink, so nothing more will be written.
                None => break hook.await,
            },
            code = &mut hook => break code,
        }
    };

    // Anything the runner sent just before finishing.
    while let Ok(chunk) = receiver.try_recv() {
        if stream
            .write_all(&HookResponse::Stderr(chunk).encode())
            .await
            .is_err()
        {
            return;
        }
    }

    let _ = stream
        .write_all(&HookResponse::Exit(exit_code).encode())
        .await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::hooks::client;
    use crate::hooks::protocol::generate_token;

    fn request(token: &str, hook: &str) -> HookRequest {
        HookRequest {
            token: token.to_owned(),
            hook: hook.to_owned(),
            arguments: Vec::new(),
            environment: HashMap::new(),
            cwd: "/repo".to_owned(),
            stdin: Vec::new(),
        }
    }

    /// A server whose runner reports what it was asked to run, then exits with `code`.
    async fn serving(token: &str, code: i32) -> (u16, ServerHandle) {
        let server = HookServer::bind(
            token.to_owned(),
            runner(move |request: HookRequest, sink: StderrSink| async move {
                let _ = sink.send(format!("ran {}\n", request.hook).into_bytes());
                code
            }),
        )
        .await
        .expect("binding should succeed");

        let port = server.port().expect("a port");
        (port, server.serve())
    }

    #[tokio::test]
    async fn runs_a_hook_and_returns_its_exit_code() {
        let token = generate_token();
        let (port, _handle) = serving(&token, 0).await;

        let mut output = Vec::new();
        let code = client::run(port, &request(&token, "pre-commit"), |chunk| {
            output.extend_from_slice(chunk)
        })
        .await
        .expect("the exchange should succeed");

        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&output), "ran pre-commit\n");
    }

    #[tokio::test]
    async fn reports_a_failing_hook_faithfully() {
        // The exit code is the whole point: git decides whether to proceed from it, so it must arrive
        // unchanged rather than being flattened to success or failure.
        let token = generate_token();
        let (port, _handle) = serving(&token, 42).await;

        let code = client::run(port, &request(&token, "commit-msg"), |_| {})
            .await
            .expect("the exchange should succeed");

        assert_eq!(code, 42);
    }

    #[tokio::test]
    async fn ignores_a_connection_with_the_wrong_token() {
        // The security boundary. A local process that found the port must not be able to make the app
        // run anything — and the client sees a closed connection, not a diagnostic that would confirm
        // the port belongs to us.
        let token = generate_token();
        let (port, _handle) = serving(&token, 0).await;

        let error = client::run(port, &request("not-the-token", "pre-commit"), |_| {})
            .await
            .expect_err("a wrong token must not run a hook");

        assert!(
            matches!(error, client::ClientError::NoExitCode),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn ignores_a_connection_with_no_token_at_all() {
        let token = generate_token();
        let (port, _handle) = serving(&token, 0).await;

        assert!(client::run(port, &request("", "pre-commit"), |_| {})
            .await
            .is_err());
    }

    #[tokio::test]
    async fn ignores_a_malformed_message() {
        let token = generate_token();
        let (port, _handle) = serving(&token, 0).await;

        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connecting should succeed");
        stream
            .write_all(b"this is not a request")
            .await
            .expect("writing should succeed");
        stream.shutdown().await.expect("shutdown should succeed");

        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .await
            .expect("reading should succeed");

        assert!(response.is_empty(), "garbage earns no reply");
    }

    #[tokio::test]
    async fn streams_output_while_the_hook_is_still_running() {
        // Why the protocol is framed rather than "collect, then reply": a long hook has to be visible
        // while it runs.
        let token = generate_token();
        let (started, mut observed) = mpsc::unbounded_channel::<()>();

        let server = HookServer::bind(
            token.clone(),
            runner(move |_request, sink: StderrSink| {
                let started = started.clone();
                async move {
                    let _ = sink.send(b"working...\n".to_vec());
                    // Only finishes once the test has seen the first chunk, so passing proves the chunk
                    // arrived *before* the hook completed.
                    let _ = started.send(());
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let _ = sink.send(b"done\n".to_vec());
                    0
                }
            }),
        )
        .await
        .expect("binding should succeed");
        let port = server.port().expect("a port");
        let _handle = server.serve();

        let (chunks, _) = tokio::join!(
            async {
                let mut chunks: Vec<String> = Vec::new();
                let code = client::run(port, &request(&token, "pre-commit"), |chunk| {
                    chunks.push(String::from_utf8_lossy(chunk).into_owned())
                })
                .await
                .expect("the exchange should succeed");
                (chunks, code)
            },
            async {
                observed.recv().await;
            }
        );

        assert_eq!(
            chunks.0,
            vec!["working...\n".to_owned(), "done\n".to_owned()]
        );
        assert_eq!(chunks.1, 0);
    }

    #[tokio::test]
    async fn forwards_the_whole_invocation_to_the_runner() {
        let token = generate_token();
        let (seen, mut received) = mpsc::unbounded_channel::<HookRequest>();

        let server = HookServer::bind(
            token.clone(),
            runner(move |request: HookRequest, _sink| {
                let seen = seen.clone();
                async move {
                    let _ = seen.send(request);
                    0
                }
            }),
        )
        .await
        .expect("binding should succeed");
        let port = server.port().expect("a port");
        let _handle = server.serve();

        let sent = HookRequest {
            token: token.clone(),
            hook: "pre-push".to_owned(),
            arguments: vec!["origin".to_owned(), "git@example.invalid:repo".to_owned()],
            environment: HashMap::from([("GIT_DIR".to_owned(), "/repo/.git".to_owned())]),
            cwd: "/repo".to_owned(),
            stdin: b"refs/heads/main abc\0def\n".to_vec(),
        };

        client::run(port, &sent, |_| {})
            .await
            .expect("the exchange should succeed");

        let arrived = received.recv().await.expect("the runner saw the request");
        assert_eq!(arrived, sent, "argv, env, cwd and stdin all cross intact");
    }

    #[tokio::test]
    async fn serves_several_hooks_over_the_operation() {
        // git runs hooks one after another within a single operation, each as a fresh process, so the
        // server has to outlive one connection.
        let token = generate_token();
        let (port, _handle) = serving(&token, 0).await;

        for hook in ["pre-commit", "prepare-commit-msg", "commit-msg"] {
            let mut output = Vec::new();
            client::run(port, &request(&token, hook), |chunk| {
                output.extend_from_slice(chunk)
            })
            .await
            .expect("each hook should be served");

            assert_eq!(String::from_utf8_lossy(&output), format!("ran {hook}\n"));
        }
    }

    #[tokio::test]
    async fn stops_serving_once_the_handle_is_dropped() {
        // What bounds the token's usefulness to one git operation.
        let token = generate_token();
        let (port, handle) = serving(&token, 0).await;
        client::run(port, &request(&token, "pre-commit"), |_| {})
            .await
            .expect("served while the handle is alive");

        drop(handle);
        // Give the aborted accept loop a moment to actually stop.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = client::run(port, &request(&token, "pre-commit"), |_| {}).await;

        assert!(
            result.is_err(),
            "a connection after the operation must not run a hook"
        );
    }
}
