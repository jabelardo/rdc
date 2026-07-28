//! The wire protocol between the hook stand-in binary and the app.
//!
//! Replaces the `process-proxy` npm package `desktop-plus` depended on. That package ships a **native
//! binary**, so its protocol is not in the desktop-plus tree at all — this is a design rather than a
//! port, and it follows [`crate`]'s existing example, the `trampoline` crate, wherever there was a
//! choice.
//!
//! # Shape
//!
//! ```text
//!  git  ──runs──>  rdc-hook-proxy  ──TCP 127.0.0.1──>  rdc  ──runs──>  git hook run <name>
//! ```
//!
//! git is pointed at a directory of copies of one binary, each named after a hook (`core.hooksPath`).
//! The copy forwards everything about its invocation to the app, which runs the *real* hook with an
//! environment loaded from the user's login shell, and streams the hook's output back.
//!
//! # Request: one NUL-framed message
//!
//! ```text
//! <token>\0<hook>\0<argc>\0<arg>…\0<envc>\0<KEY=VALUE>…\0<cwd>\0<stdin length>\0<stdin bytes>
//! ```
//!
//! Counts and lengths are decimal strings, matching the trampoline's framing. NUL separation is what
//! makes it safe: argv and environment values may contain newlines and spaces, but never a NUL.
//!
//! Two deliberate differences from the trampoline's message:
//!
//! - **The token comes first, positionally**, rather than inside the environment block. The trampoline
//!   inherited that placement from the vendored C client it replaced; here both ends are ours, so the
//!   token can be checked before anything else is parsed.
//! - **Stdin is length-prefixed bytes**, not a trailing string. A hook's stdin is arbitrary data (a
//!   `pre-push` gets one line per ref) and it is written to a file for `git hook run --to-stdin`, so it
//!   must survive byte for byte.
//!
//! # Response: a stream of framed chunks
//!
//! ```text
//! frame = <tag: u8> <length: u32 big-endian> <payload>
//! ```
//!
//! - `E` — a chunk of the hook's stderr, forwarded verbatim.
//! - `X` — the hook's exit code, as 4 big-endian bytes. Exactly one, always last.
//!
//! Framing rather than a bare stream because output has to arrive *while* the hook runs — the UI shows
//! it live, and a long `pre-commit` hook that printed nothing until it finished would look hung. A bare
//! stream could carry the output but not the exit code that has to follow it.
//!
//! Big-endian for no reason beyond it being the conventional choice; both ends are ours.

use std::collections::HashMap;

/// Env var carrying the port the app is listening on.
pub const PORT_ENV: &str = "RDC_HOOK_PROXY_PORT";

/// Env var carrying the short-lived token authorizing the connection.
pub const TOKEN_ENV: &str = "RDC_HOOK_PROXY_TOKEN";

/// Largest request the server will read.
///
/// The server accepts connections from **any local process** — the token authorizes an exchange, but
/// the message has to be read before the token can be checked. Without a cap, a local peer could make
/// the app allocate without limit. 16 MiB is far beyond any real hook invocation: a `pre-push` stdin is
/// one line per ref, so this allows on the order of a hundred thousand refs.
pub const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

/// Largest single response frame.
///
/// Chunks are bounded by the reader's buffer in practice; this only guards a malformed length.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// What the stand-in binary tells the app about its invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookRequest {
    /// The token presented. **Not yet validated** — [`crate::hooks::server`] checks it.
    pub token: String,

    /// Which hook this is, from the name the binary was invoked as.
    pub hook: String,

    /// The arguments git passed the hook, excluding the program name.
    pub arguments: Vec<String>,

    /// git's environment, unfiltered. The runner decides what a hook may see.
    pub environment: HashMap<String, String>,

    /// The directory git ran the hook in — the repository's working tree.
    pub cwd: String,

    /// What git wrote to the hook's stdin. Empty when nothing was piped.
    pub stdin: Vec<u8>,
}

/// A frame the app sends back while the hook runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookResponse {
    /// A chunk of the hook's stderr.
    Stderr(Vec<u8>),

    /// The hook's exit code. Always the last frame.
    Exit(i32),
}

impl HookResponse {
    const STDERR_TAG: u8 = b'E';
    const EXIT_TAG: u8 = b'X';

    /// Encodes the frame for the wire.
    pub fn encode(&self) -> Vec<u8> {
        let (tag, payload): (u8, Vec<u8>) = match self {
            Self::Stderr(chunk) => (Self::STDERR_TAG, chunk.clone()),
            Self::Exit(code) => (Self::EXIT_TAG, code.to_be_bytes().to_vec()),
        };

        let mut frame = Vec::with_capacity(5 + payload.len());
        frame.push(tag);
        frame.extend_from_slice(
            &u32::try_from(payload.len())
                .expect("a frame payload cannot exceed u32")
                .to_be_bytes(),
        );
        frame.extend_from_slice(&payload);
        frame
    }

    /// Decodes a frame from `bytes`, returning it and how many bytes it consumed.
    ///
    /// `Ok(None)` means "not enough bytes yet", which is the normal case for a partially-read stream.
    pub fn decode(bytes: &[u8]) -> Result<Option<(Self, usize)>, ProtocolError> {
        if bytes.len() < 5 {
            return Ok(None);
        }

        let length = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        if length > MAX_FRAME_BYTES {
            return Err(ProtocolError::FrameTooLarge { length });
        }

        let end = 5 + length;
        if bytes.len() < end {
            return Ok(None);
        }
        let payload = &bytes[5..end];

        let frame = match bytes[0] {
            Self::STDERR_TAG => Self::Stderr(payload.to_vec()),
            Self::EXIT_TAG => {
                let code: [u8; 4] = payload
                    .try_into()
                    .map_err(|_| ProtocolError::MalformedExit { length })?;
                Self::Exit(i32::from_be_bytes(code))
            }
            tag => return Err(ProtocolError::UnknownTag { tag }),
        };

        Ok(Some((frame, end)))
    }
}

/// A malformed message.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("expected a decimal count for {field}, got {value:?}")]
    InvalidCount { field: &'static str, value: String },

    #[error("the message ended early while reading {field}")]
    Truncated { field: &'static str },

    #[error("a request of {length} bytes exceeds the {MAX_REQUEST_BYTES}-byte limit")]
    RequestTooLarge { length: usize },

    #[error("a frame of {length} bytes exceeds the {MAX_FRAME_BYTES}-byte limit")]
    FrameTooLarge { length: usize },

    #[error("unknown response frame tag {tag:?}")]
    UnknownTag { tag: u8 },

    #[error("an exit frame must carry 4 bytes, got {length}")]
    MalformedExit { length: usize },
}

/// Encodes a request for the wire.
pub fn encode_request(request: &HookRequest) -> Vec<u8> {
    let mut out = Vec::new();

    let mut push = |value: &[u8]| {
        out.extend_from_slice(value);
        out.push(0);
    };

    push(request.token.as_bytes());
    push(request.hook.as_bytes());
    push(request.arguments.len().to_string().as_bytes());
    for argument in &request.arguments {
        push(argument.as_bytes());
    }
    push(request.environment.len().to_string().as_bytes());
    for (name, value) in &request.environment {
        push(format!("{name}={value}").as_bytes());
    }
    push(request.cwd.as_bytes());
    push(request.stdin.len().to_string().as_bytes());
    // Not NUL-terminated: the length says where it ends, and stdin may contain NULs.
    out.extend_from_slice(&request.stdin);

    out
}

/// Decodes a request.
///
/// Fields are decoded lossily, as the trampoline's decoder does: an argument or environment value on
/// Unix is arbitrary bytes, and a replacement character in a diagnostic beats refusing to run a hook.
/// Stdin is *not* decoded — it is copied byte for byte.
pub fn decode_request(bytes: &[u8]) -> Result<HookRequest, ProtocolError> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(ProtocolError::RequestTooLarge {
            length: bytes.len(),
        });
    }

    let mut reader = NulReader::new(bytes);

    let token = reader.next_string("token")?;
    let hook = reader.next_string("hook")?;

    let count = reader.next_count("argument count")?;
    let mut arguments = Vec::with_capacity(count.min(64));
    for _ in 0..count {
        arguments.push(reader.next_string("argument")?);
    }

    let count = reader.next_count("environment count")?;
    let mut environment = HashMap::with_capacity(count.min(256));
    for _ in 0..count {
        let entry = reader.next_string("environment entry")?;
        // Split on the first `=`: a name cannot contain one, a value can.
        if let Some((name, value)) = entry.split_once('=') {
            environment.insert(name.to_owned(), value.to_owned());
        }
    }

    let cwd = reader.next_string("cwd")?;
    let length = reader.next_count("stdin length")?;
    let stdin = reader.take("stdin", length)?.to_vec();

    Ok(HookRequest {
        token,
        hook,
        arguments,
        environment,
        cwd,
        stdin,
    })
}

/// Walks NUL-separated fields.
struct NulReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> NulReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn next_field(&mut self, field: &'static str) -> Result<&'a [u8], ProtocolError> {
        let rest = &self.bytes[self.position..];
        let end = rest
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(ProtocolError::Truncated { field })?;
        self.position += end + 1;
        Ok(&rest[..end])
    }

    fn next_string(&mut self, field: &'static str) -> Result<String, ProtocolError> {
        Ok(String::from_utf8_lossy(self.next_field(field)?).into_owned())
    }

    fn next_count(&mut self, field: &'static str) -> Result<usize, ProtocolError> {
        let value = self.next_string(field)?;
        value
            .parse()
            .map_err(|_| ProtocolError::InvalidCount { field, value })
    }

    fn take(&mut self, field: &'static str, length: usize) -> Result<&'a [u8], ProtocolError> {
        let rest = &self.bytes[self.position..];
        if rest.len() < length {
            return Err(ProtocolError::Truncated { field });
        }
        self.position += length;
        Ok(&rest[..length])
    }
}

/// Generates a token authorizing one hook-running operation.
///
/// # Why a token at all
///
/// The server listens on loopback, so **any local process can connect** — including one running as
/// another user on a shared machine. Since a connection makes the app run a program, that is a more
/// serious surface than the trampoline's: this is remote code execution if it is left unauthenticated.
/// The token is what distinguishes "git, invoked by us, for an operation happening now".
///
/// Scoped to a single operation by the caller that issues it, so a leaked token dies with the commit.
///
/// Duplicated from `trampoline::token` rather than shared: `git-ops` deliberately does not depend on
/// that crate — it is what keeps this one runnable against a bare repository with no app around it —
/// and this is twenty lines.
pub fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    fill_random(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Fills `buffer` from the OS random source.
///
/// No crate dependency, matching `trampoline::token`: this and the token there are the only randomness
/// either crate needs.
#[cfg(unix)]
fn fill_random(buffer: &mut [u8]) {
    use std::io::Read;

    let mut file = std::fs::File::open("/dev/urandom")
        .expect("the platform must provide /dev/urandom to authenticate hook execution");
    file.read_exact(buffer)
        .expect("reading from /dev/urandom must succeed");
}

#[cfg(not(unix))]
fn fill_random(_buffer: &mut [u8]) {
    unimplemented!("hook execution needs a Windows random source; see MIGRATION_MAP.md")
}

/// Compares two tokens without leaking where they differ.
///
/// Constant time in the length of `expected`. A timing oracle on a live token matters more here than
/// for the trampoline, because what a valid token buys is running a program.
pub fn tokens_match(presented: &str, expected: &str) -> bool {
    if presented.len() != expected.len() {
        return false;
    }

    presented
        .bytes()
        .zip(expected.bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> HookRequest {
        HookRequest {
            token: "deadbeef".to_owned(),
            hook: "pre-commit".to_owned(),
            arguments: vec!["--verbose".to_owned()],
            environment: HashMap::from([
                ("GIT_DIR".to_owned(), "/repo/.git".to_owned()),
                ("GIT_INDEX_FILE".to_owned(), "/repo/.git/index".to_owned()),
            ]),
            cwd: "/repo".to_owned(),
            stdin: b"refs/heads/main abc123\n".to_vec(),
        }
    }

    #[test]
    fn a_request_round_trips() {
        let original = request();

        assert_eq!(
            decode_request(&encode_request(&original)).expect("decodes"),
            original
        );
    }

    #[test]
    fn a_request_with_nothing_in_it_round_trips() {
        // A `post-commit` hook gets no arguments and no stdin.
        let original = HookRequest {
            token: "t".to_owned(),
            hook: "post-commit".to_owned(),
            arguments: Vec::new(),
            environment: HashMap::new(),
            cwd: "/repo".to_owned(),
            stdin: Vec::new(),
        };

        assert_eq!(
            decode_request(&encode_request(&original)).expect("decodes"),
            original
        );
    }

    #[test]
    fn an_argument_containing_a_newline_or_a_space_survives() {
        // Why the framing is NUL-based. A commit message file path, or a ref name, may contain either.
        let mut original = request();
        original.arguments = vec![
            "/tmp/commit message.txt".to_owned(),
            "line one\nline two".to_owned(),
        ];

        let decoded = decode_request(&encode_request(&original)).expect("decodes");

        assert_eq!(decoded.arguments, original.arguments);
    }

    #[test]
    fn an_environment_value_containing_an_equals_sign_survives() {
        let mut original = request();
        original.environment = HashMap::from([(
            "GIT_CONFIG_PARAMETERS".to_owned(),
            "'core.hooksPath=/tmp/hooks'".to_owned(),
        )]);

        let decoded = decode_request(&encode_request(&original)).expect("decodes");

        assert_eq!(
            decoded.environment["GIT_CONFIG_PARAMETERS"],
            "'core.hooksPath=/tmp/hooks'"
        );
    }

    #[test]
    fn stdin_containing_a_nul_survives() {
        // Why stdin is length-prefixed rather than NUL-terminated like every other field.
        let mut original = request();
        original.stdin = vec![b'a', 0, b'b', 0, 0, b'c'];

        let decoded = decode_request(&encode_request(&original)).expect("decodes");

        assert_eq!(decoded.stdin, original.stdin);
    }

    #[test]
    fn stdin_is_not_decoded_as_text() {
        // It goes to a file for `git hook run --to-stdin`, so lossy decoding would corrupt it.
        let mut original = request();
        original.stdin = vec![0xff, 0xfe, 0x00, 0x80];

        let decoded = decode_request(&encode_request(&original)).expect("decodes");

        assert_eq!(decoded.stdin, vec![0xff, 0xfe, 0x00, 0x80]);
    }

    #[test]
    fn reports_a_truncated_request() {
        let encoded = encode_request(&request());

        // Every prefix is either incomplete or missing data; none may decode to something usable.
        for cut in 1..encoded.len() {
            if let Ok(decoded) = decode_request(&encoded[..cut]) {
                assert_ne!(
                    decoded,
                    request(),
                    "a truncated request decoded to the whole thing at {cut} bytes"
                );
            }
        }
    }

    #[test]
    fn reports_a_non_numeric_count() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"token\0pre-commit\0not-a-number\0");

        assert_eq!(
            decode_request(&bytes),
            Err(ProtocolError::InvalidCount {
                field: "argument count",
                value: "not-a-number".to_owned()
            })
        );
    }

    #[test]
    fn refuses_an_oversized_request() {
        // The server reads before it can authenticate, so this cap is what stops a local peer making
        // the app allocate without limit.
        let oversized = vec![0_u8; MAX_REQUEST_BYTES + 1];

        assert_eq!(
            decode_request(&oversized),
            Err(ProtocolError::RequestTooLarge {
                length: MAX_REQUEST_BYTES + 1
            })
        );
    }

    #[test]
    fn a_stderr_frame_round_trips() {
        let frame = HookResponse::Stderr(b"pre-commit: linting\n".to_vec());
        let encoded = frame.encode();

        let (decoded, consumed) = HookResponse::decode(&encoded)
            .expect("decodes")
            .expect("a whole frame");

        assert_eq!(decoded, frame);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn an_exit_frame_round_trips_including_a_negative_code() {
        for code in [0, 1, 128, -1] {
            let encoded = HookResponse::Exit(code).encode();
            let (decoded, _) = HookResponse::decode(&encoded)
                .expect("decodes")
                .expect("a whole frame");

            assert_eq!(decoded, HookResponse::Exit(code));
        }
    }

    #[test]
    fn frames_decode_one_at_a_time_from_a_stream() {
        // What the client does: read whatever arrived, take whole frames, keep the remainder.
        let mut stream = Vec::new();
        stream.extend_from_slice(&HookResponse::Stderr(b"one".to_vec()).encode());
        stream.extend_from_slice(&HookResponse::Stderr(b"two".to_vec()).encode());
        stream.extend_from_slice(&HookResponse::Exit(3).encode());

        let mut frames = Vec::new();
        let mut offset = 0;
        while let Some((frame, consumed)) =
            HookResponse::decode(&stream[offset..]).expect("decodes")
        {
            offset += consumed;
            frames.push(frame);
        }

        assert_eq!(
            frames,
            vec![
                HookResponse::Stderr(b"one".to_vec()),
                HookResponse::Stderr(b"two".to_vec()),
                HookResponse::Exit(3),
            ]
        );
        assert_eq!(offset, stream.len());
    }

    #[test]
    fn a_partial_frame_is_not_an_error() {
        // Output arrives while the hook runs, so a half-read frame is the normal case.
        let encoded = HookResponse::Stderr(b"hello".to_vec()).encode();

        for cut in 0..encoded.len() {
            assert_eq!(
                HookResponse::decode(&encoded[..cut]),
                Ok(None),
                "{cut} bytes should read as incomplete, not as an error"
            );
        }
    }

    #[test]
    fn an_empty_stderr_frame_is_valid() {
        // A zero-length read is possible, and must not be confused with an incomplete frame.
        let encoded = HookResponse::Stderr(Vec::new()).encode();

        let (decoded, consumed) = HookResponse::decode(&encoded)
            .expect("decodes")
            .expect("a whole frame");

        assert_eq!(decoded, HookResponse::Stderr(Vec::new()));
        assert_eq!(consumed, 5);
    }

    #[test]
    fn reports_an_unknown_tag() {
        let mut encoded = HookResponse::Stderr(b"x".to_vec()).encode();
        encoded[0] = b'?';

        assert_eq!(
            HookResponse::decode(&encoded),
            Err(ProtocolError::UnknownTag { tag: b'?' })
        );
    }

    #[test]
    fn reports_an_oversized_frame_length() {
        let mut encoded = vec![b'E'];
        encoded.extend_from_slice(&u32::MAX.to_be_bytes());

        assert!(matches!(
            HookResponse::decode(&encoded),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn reports_a_malformed_exit_frame() {
        let mut encoded = vec![b'X'];
        encoded.extend_from_slice(&2_u32.to_be_bytes());
        encoded.extend_from_slice(b"ab");

        assert_eq!(
            HookResponse::decode(&encoded),
            Err(ProtocolError::MalformedExit { length: 2 })
        );
    }

    #[test]
    fn a_token_is_long_and_never_repeats() {
        let first = generate_token();
        let second = generate_token();

        assert_eq!(first.len(), 64, "32 bytes as hex");
        assert_ne!(first, second);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn tokens_compare_by_value() {
        let token = generate_token();

        assert!(tokens_match(&token, &token));
        assert!(!tokens_match("", &token));
        assert!(!tokens_match(&token, ""));
        assert!(
            !tokens_match(&token[..63], &token),
            "a prefix is not a match"
        );

        let mut wrong = token.clone();
        // Differing in the last character is the case a short-circuiting comparison would leak.
        wrong.pop();
        wrong.push(if token.ends_with('0') { '1' } else { '0' });
        assert!(!tokens_match(&wrong, &token));
    }
}
