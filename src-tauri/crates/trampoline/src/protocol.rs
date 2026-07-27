//! The wire protocol between the trampoline binary and the app.
//!
//! Ported from `desktop-plus/app/src/lib/trampoline/trampoline-command-parser.ts` (the decoder) and
//! `vendor/desktop-trampoline`'s C client (the encoder).
//!
//! # Format
//!
//! A single message, values separated by NUL:
//!
//! ```text
//! <parameter count>\0<parameter>…\0<env count>\0<KEY=VALUE>…\0<stdin>\0
//! ```
//!
//! Counts are decimal strings. Environment entries split on the **first** `=`, so values may
//! contain `=`. NUL framing matters: argv and environment values can contain newlines and spaces,
//! but never a NUL.
//!
//! The command's kind and its auth token travel *inside* the environment block, as
//! `DESKTOP_TRAMPOLINE_IDENTIFIER` and `DESKTOP_TRAMPOLINE_TOKEN` — git sets them when it invokes
//! the binary, so the binary itself needs no arguments of its own.

use std::collections::HashMap;

/// Env var naming which handler should service the command.
pub const IDENTIFIER_ENV: &str = "DESKTOP_TRAMPOLINE_IDENTIFIER";
/// Env var carrying the short-lived auth token.
pub const TOKEN_ENV: &str = "DESKTOP_TRAMPOLINE_TOKEN";
/// Env var carrying the port the app is listening on.
pub const PORT_ENV: &str = "DESKTOP_PORT";

/// Which handler a command is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandIdentifier {
    /// git/ssh asking for a password or passphrase (`GIT_ASKPASS`, `SSH_ASKPASS`).
    AskPass,
    /// git's credential helper protocol (`get`/`store`/`erase`).
    CredentialHelper,
}

impl CommandIdentifier {
    /// The wire value, matching the original's `TrampolineCommandIdentifier`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AskPass => "ASKPASS",
            Self::CredentialHelper => "CREDENTIALHELPER",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ASKPASS" => Some(Self::AskPass),
            "CREDENTIALHELPER" => Some(Self::CredentialHelper),
            _ => None,
        }
    }
}

/// A decoded request from the trampoline binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub identifier: CommandIdentifier,
    /// The auth token the client presented. **Not yet validated** — see
    /// [`crate::token::TokenStore`]; the server checks it before dispatching.
    pub token: String,
    /// git's arguments, excluding the program name.
    pub parameters: Vec<String>,
    pub environment: HashMap<String, String>,
    /// What git wrote to the binary's stdin. Empty for askpass, which doesn't read stdin.
    pub stdin: String,
}

/// A malformed message.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("expected a decimal count for {field}, got {value:?}")]
    InvalidCount { field: &'static str, value: String },

    #[error("message ended early while reading {field}")]
    Truncated { field: &'static str },

    #[error("environment entry {entry:?} is not in KEY=VALUE form")]
    InvalidEnvironmentEntry { entry: String },

    #[error("the message is missing {0}")]
    MissingEnvVar(&'static str),

    #[error("unsupported command identifier {0:?}")]
    UnknownIdentifier(String),
}

/// Encodes a request for transmission.
///
/// `environment` must already contain [`IDENTIFIER_ENV`] and [`TOKEN_ENV`]; the binary forwards its
/// own environment, which git populated.
pub fn encode(
    parameters: &[String],
    environment: &HashMap<String, String>,
    stdin: &str,
) -> Vec<u8> {
    let mut values: Vec<String> = Vec::new();

    values.push(parameters.len().to_string());
    values.extend(parameters.iter().cloned());

    values.push(environment.len().to_string());
    for (key, value) in environment {
        values.push(format!("{key}={value}"));
    }

    values.push(stdin.to_owned());

    // Trailing NUL after every value, so the reader never has to guess whether the last value is
    // complete.
    let mut out = Vec::new();
    for value in values {
        out.extend_from_slice(value.as_bytes());
        out.push(0);
    }
    out
}

/// Decodes a request.
///
/// Lossy UTF-8 decoding, matching the original's `data.toString('utf8')`: a path or credential that
/// isn't valid UTF-8 degrades rather than dropping the whole request.
pub fn decode(bytes: &[u8]) -> Result<Command, ProtocolError> {
    // The message ends with a trailing NUL, so the final split piece is empty and not a value.
    let mut values = bytes
        .split(|byte| *byte == 0)
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .collect::<Vec<_>>();
    if values.last().is_some_and(|last| last.is_empty()) {
        values.pop();
    }
    let mut values = values.into_iter();

    let parameter_count = take_count(&mut values, "parameter count")?;
    let mut parameters = Vec::with_capacity(parameter_count);
    for _ in 0..parameter_count {
        parameters.push(values.next().ok_or(ProtocolError::Truncated {
            field: "parameters",
        })?);
    }

    let environment_count = take_count(&mut values, "environment count")?;
    let mut environment = HashMap::with_capacity(environment_count);
    for _ in 0..environment_count {
        let entry = values.next().ok_or(ProtocolError::Truncated {
            field: "environment",
        })?;
        // Split on the FIRST '=' so values containing '=' survive intact.
        let (key, value) =
            entry
                .split_once('=')
                .ok_or_else(|| ProtocolError::InvalidEnvironmentEntry {
                    entry: entry.clone(),
                })?;
        environment.insert(key.to_owned(), value.to_owned());
    }

    // Absent stdin is treated as empty: askpass invocations legitimately send nothing.
    let stdin = values.next().unwrap_or_default();

    let identifier_value = environment
        .get(IDENTIFIER_ENV)
        .ok_or(ProtocolError::MissingEnvVar(IDENTIFIER_ENV))?;
    let identifier = CommandIdentifier::parse(identifier_value)
        .ok_or_else(|| ProtocolError::UnknownIdentifier(identifier_value.clone()))?;

    let token = environment
        .get(TOKEN_ENV)
        .ok_or(ProtocolError::MissingEnvVar(TOKEN_ENV))?
        .clone();

    Ok(Command {
        identifier,
        token,
        parameters,
        environment,
        stdin,
    })
}

fn take_count(
    values: &mut impl Iterator<Item = String>,
    field: &'static str,
) -> Result<usize, ProtocolError> {
    let value = values.next().ok_or(ProtocolError::Truncated { field })?;
    value
        .parse::<usize>()
        .map_err(|_| ProtocolError::InvalidCount { field, value })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_env() -> HashMap<String, String> {
        HashMap::from([
            (IDENTIFIER_ENV.to_owned(), "ASKPASS".to_owned()),
            (TOKEN_ENV.to_owned(), "token-123".to_owned()),
        ])
    }

    #[test]
    fn round_trips_a_command() {
        let parameters = vec!["Username for 'https://github.com':".to_owned()];
        let encoded = encode(&parameters, &base_env(), "");
        let decoded = decode(&encoded).expect("should decode");

        assert_eq!(decoded.identifier, CommandIdentifier::AskPass);
        assert_eq!(decoded.token, "token-123");
        assert_eq!(decoded.parameters, parameters);
        assert_eq!(decoded.stdin, "");
    }

    #[test]
    fn round_trips_stdin() {
        // git's credential helper sends its request on stdin.
        let stdin = "protocol=https\nhost=github.com\n\n";
        let mut env = base_env();
        env.insert(IDENTIFIER_ENV.to_owned(), "CREDENTIALHELPER".to_owned());

        let decoded = decode(&encode(&["get".to_owned()], &env, stdin)).expect("should decode");
        assert_eq!(decoded.identifier, CommandIdentifier::CredentialHelper);
        assert_eq!(decoded.stdin, stdin);
        assert_eq!(decoded.parameters, ["get"]);
    }

    #[test]
    fn round_trips_no_parameters() {
        let decoded = decode(&encode(&[], &base_env(), "")).expect("should decode");
        assert!(decoded.parameters.is_empty());
    }

    #[test]
    fn preserves_equals_signs_in_environment_values() {
        // Splitting on the last '=' — or on all of them — would corrupt values like a base64 token.
        let mut env = base_env();
        env.insert("SOMETHING".to_owned(), "a=b=c".to_owned());

        let decoded = decode(&encode(&[], &env, "")).expect("should decode");
        assert_eq!(
            decoded.environment.get("SOMETHING").map(String::as_str),
            Some("a=b=c")
        );
    }

    #[test]
    fn preserves_newlines_in_parameters() {
        // The reason for NUL framing rather than newline framing: a prompt spans multiple lines.
        let prompt = "The authenticity of host 'github.com (1.2.3.4)' can't be established.\nRSA key fingerprint is SHA256:abc.\nContinue? ";
        let decoded =
            decode(&encode(&[prompt.to_owned()], &base_env(), "")).expect("should decode");
        assert_eq!(decoded.parameters, [prompt]);
    }

    #[test]
    fn preserves_an_empty_parameter() {
        let decoded =
            decode(&encode(&["".to_owned(), "x".to_owned()], &base_env(), "")).expect("decodes");
        assert_eq!(decoded.parameters, ["", "x"]);
    }

    #[test]
    fn rejects_a_non_numeric_count() {
        let error = decode(b"not-a-number\0").expect_err("should reject");
        assert!(
            matches!(error, ProtocolError::InvalidCount { .. }),
            "got {error:?}"
        );
    }

    #[test]
    fn rejects_a_truncated_message() {
        // Claims two parameters but supplies one.
        let error = decode(b"2\0only-one\0").expect_err("should reject");
        assert_eq!(
            error,
            ProtocolError::Truncated {
                field: "parameters"
            }
        );
    }

    #[test]
    fn rejects_a_malformed_environment_entry() {
        let error = decode(b"0\x001\x00no-equals-sign\x00").expect_err("should reject");
        assert!(
            matches!(error, ProtocolError::InvalidEnvironmentEntry { .. }),
            "got {error:?}"
        );
    }

    #[test]
    fn rejects_a_message_without_an_identifier() {
        let env = HashMap::from([(TOKEN_ENV.to_owned(), "t".to_owned())]);
        let error = decode(&encode(&[], &env, "")).expect_err("should reject");
        assert_eq!(error, ProtocolError::MissingEnvVar(IDENTIFIER_ENV));
    }

    #[test]
    fn rejects_a_message_without_a_token() {
        // Without this the server would have nothing to authenticate, so it must be a hard error
        // rather than defaulting to an empty token.
        let env = HashMap::from([(IDENTIFIER_ENV.to_owned(), "ASKPASS".to_owned())]);
        let error = decode(&encode(&[], &env, "")).expect_err("should reject");
        assert_eq!(error, ProtocolError::MissingEnvVar(TOKEN_ENV));
    }

    #[test]
    fn rejects_an_unknown_identifier() {
        let mut env = base_env();
        env.insert(IDENTIFIER_ENV.to_owned(), "SOMETHING-ELSE".to_owned());
        let error = decode(&encode(&[], &env, "")).expect_err("should reject");
        assert!(
            matches!(error, ProtocolError::UnknownIdentifier(ref v) if v == "SOMETHING-ELSE"),
            "got {error:?}"
        );
    }

    #[test]
    fn identifier_wire_values_match_the_original() {
        assert_eq!(CommandIdentifier::AskPass.as_str(), "ASKPASS");
        assert_eq!(
            CommandIdentifier::CredentialHelper.as_str(),
            "CREDENTIALHELPER"
        );
        assert_eq!(
            CommandIdentifier::parse("ASKPASS"),
            Some(CommandIdentifier::AskPass)
        );
        assert_eq!(CommandIdentifier::parse("nope"), None);
    }
}
