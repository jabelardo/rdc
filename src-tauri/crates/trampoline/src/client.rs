//! The client half: what the trampoline binary does.
//!
//! Replaces `vendor/desktop-trampoline`'s C client (`desktop-trampoline.c` + `socket.c`).

use std::collections::HashMap;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::protocol::{encode, PORT_ENV};

/// A failure talking to the app.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("{PORT_ENV} is not set — the trampoline was invoked outside of a git operation")]
    MissingPort,

    #[error("{PORT_ENV} is not a valid port: {value:?}")]
    InvalidPort { value: String },

    #[error("could not reach the app on port {port}: {source}")]
    Connect {
        port: u16,
        #[source]
        source: std::io::Error,
    },

    #[error("failed while exchanging data with the app: {0}")]
    Io(#[from] std::io::Error),
}

/// Sends a command to the app and returns its reply.
///
/// Connects to loopback only — the server is bound to `127.0.0.1`, and the port plus a live token
/// are the only things authorizing the exchange.
pub async fn send(
    port: u16,
    parameters: &[String],
    environment: &HashMap<String, String>,
    stdin: &str,
) -> Result<String, ClientError> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|source| ClientError::Connect { port, source })?;

    stream
        .write_all(&encode(parameters, environment, stdin))
        .await?;
    // Half-close so the server sees end-of-request; it replies and closes its side.
    stream.shutdown().await?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;

    Ok(String::from_utf8_lossy(&response).into_owned())
}

/// Reads the app's port from the environment.
pub fn port_from_env(environment: &HashMap<String, String>) -> Result<u16, ClientError> {
    let value = environment.get(PORT_ENV).ok_or(ClientError::MissingPort)?;
    value.parse::<u16>().map_err(|_| ClientError::InvalidPort {
        value: value.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn reads_the_port_from_the_environment() {
        assert_eq!(
            port_from_env(&env(&[(PORT_ENV, "4242")])).expect("parses"),
            4242
        );
    }

    #[test]
    fn reports_a_missing_port() {
        let error = port_from_env(&env(&[])).expect_err("should fail");
        assert!(matches!(error, ClientError::MissingPort), "got {error:?}");
    }

    #[test]
    fn reports_an_unparseable_port() {
        // Includes values that are numbers but out of range, which is the likelier real mistake.
        for value in ["", "not-a-number", "0x10", "70000", "-1"] {
            let error = port_from_env(&env(&[(PORT_ENV, value)])).expect_err("should fail");
            assert!(
                matches!(error, ClientError::InvalidPort { .. }),
                "for {value:?} got {error:?}"
            );
        }
    }

    #[tokio::test]
    async fn reports_a_refused_connection() {
        // Port 1 on loopback is not listening; the point is that this surfaces as a typed error
        // rather than hanging or panicking inside git's askpass call.
        let error = send(1, &[], &env(&[]), "").await.expect_err("should fail");
        assert!(
            matches!(error, ClientError::Connect { port: 1, .. }),
            "got {error:?}"
        );
    }
}
