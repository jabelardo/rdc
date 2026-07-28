//! The client half: what the hook stand-in binary does.
//!
//! Replaces the client side of the `process-proxy` npm package. See [`crate::hooks::protocol`] for the
//! wire format and why this exists at all.

use std::collections::HashMap;
use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::hooks::protocol::{
    encode_request, HookRequest, HookResponse, ProtocolError, PORT_ENV, TOKEN_ENV,
};

/// A failure talking to the app.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("{PORT_ENV} is not set — the hook proxy was invoked outside of a git operation")]
    MissingPort,

    #[error("{PORT_ENV} is not a valid port: {value:?}")]
    InvalidPort { value: String },

    #[error("{TOKEN_ENV} is not set — the hook proxy was invoked outside of a git operation")]
    MissingToken,

    #[error("could not reach the app on port {port}: {source}")]
    Connect {
        port: u16,
        #[source]
        source: std::io::Error,
    },

    #[error("the app closed the connection before reporting an exit code")]
    NoExitCode,

    #[error("the app sent a malformed frame: {0}")]
    Protocol(#[from] ProtocolError),

    #[error("failed while exchanging data with the app: {0}")]
    Io(#[from] std::io::Error),
}

/// The hook name a stand-in was invoked as.
///
/// git runs `<hooksPath>/<hook-name>`, so the file name *is* the hook name — which is why one binary
/// can serve every hook. `.exe` is stripped for Windows, where the copies need the extension to be
/// runnable.
pub fn hook_name_from_argv0(argv0: &str) -> String {
    let name = Path::new(argv0)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| argv0.to_owned());

    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

/// Sends the invocation to the app and streams the hook's output back.
///
/// `on_stderr` receives each chunk as it arrives — the caller writes it to its own stderr, which is
/// where git expects hook output. Returns the hook's exit code, which the caller exits with, so git sees
/// exactly what it would have seen had it run the hook itself.
///
/// Connects to loopback only. The port plus a live token are the only things authorizing the exchange;
/// see [`crate::hooks::protocol::generate_token`] for why that matters more here than for credentials.
pub async fn run<F>(port: u16, request: &HookRequest, mut on_stderr: F) -> Result<i32, ClientError>
where
    F: FnMut(&[u8]),
{
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|source| ClientError::Connect { port, source })?;

    stream.write_all(&encode_request(request)).await?;
    // Half-close so the app sees the end of the request. The response still flows back on this
    // connection — and its closure is also what tells the app the hook was abandoned.
    stream.shutdown().await?;

    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];

    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            // The app went away without an exit frame: the hook's fate is unknown, and the caller must
            // not report success. See the note in the binary about failing closed.
            return Err(ClientError::NoExitCode);
        }
        buffer.extend_from_slice(&chunk[..read]);

        let mut offset = 0;
        while let Some((frame, consumed)) = HookResponse::decode(&buffer[offset..])? {
            offset += consumed;
            match frame {
                HookResponse::Stderr(bytes) => on_stderr(&bytes),
                // Always the last frame, so nothing after it is read.
                HookResponse::Exit(code) => return Ok(code),
            }
        }
        buffer.drain(..offset);
    }
}

/// Reads the app's port from the environment.
pub fn port_from_env(environment: &HashMap<String, String>) -> Result<u16, ClientError> {
    let value = environment.get(PORT_ENV).ok_or(ClientError::MissingPort)?;
    value.parse().map_err(|_| ClientError::InvalidPort {
        value: value.clone(),
    })
}

/// Reads the token from the environment.
pub fn token_from_env(environment: &HashMap<String, String>) -> Result<String, ClientError> {
    environment
        .get(TOKEN_ENV)
        .cloned()
        .ok_or(ClientError::MissingToken)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_hook_name_from_the_path_it_was_run_as() {
        assert_eq!(
            hook_name_from_argv0("/tmp/hooks-abc/pre-commit"),
            "pre-commit"
        );
        assert_eq!(hook_name_from_argv0("pre-push"), "pre-push");
    }

    #[test]
    fn strips_the_windows_extension() {
        // The separator is whatever the platform running the binary uses — `Path` handles that — so this
        // covers the part that isn't platform-native: the copies need `.exe` to be runnable on Windows,
        // and the hook name doesn't include it.
        assert_eq!(
            hook_name_from_argv0("/tmp/hooks-abc/pre-commit.exe"),
            "pre-commit"
        );
    }

    #[test]
    fn reads_the_port_and_token() {
        let env = HashMap::from([
            (PORT_ENV.to_owned(), "51234".to_owned()),
            (TOKEN_ENV.to_owned(), "abc".to_owned()),
        ]);

        assert_eq!(port_from_env(&env).expect("a port"), 51234);
        assert_eq!(token_from_env(&env).expect("a token"), "abc");
    }

    #[test]
    fn reports_a_missing_or_unusable_port() {
        // What it looks like when a stand-in is left behind in a hooks directory and git runs it outside
        // of any operation of ours — the message has to say so rather than crash.
        assert!(matches!(
            port_from_env(&HashMap::new()),
            Err(ClientError::MissingPort)
        ));
        assert!(matches!(
            port_from_env(&HashMap::from([(
                PORT_ENV.to_owned(),
                "not-a-port".to_owned()
            )])),
            Err(ClientError::InvalidPort { .. })
        ));
    }

    #[test]
    fn reports_a_missing_token() {
        assert!(matches!(
            token_from_env(&HashMap::from([(PORT_ENV.to_owned(), "1".to_owned())])),
            Err(ClientError::MissingToken)
        ));
    }

    #[tokio::test]
    async fn reports_a_server_that_is_not_listening() {
        // Port 1 is privileged and nothing of ours listens there.
        let request = HookRequest {
            token: "t".to_owned(),
            hook: "pre-commit".to_owned(),
            arguments: Vec::new(),
            environment: HashMap::new(),
            cwd: "/repo".to_owned(),
            stdin: Vec::new(),
        };

        assert!(matches!(
            run(1, &request, |_| {}).await,
            Err(ClientError::Connect { .. })
        ));
    }
}
