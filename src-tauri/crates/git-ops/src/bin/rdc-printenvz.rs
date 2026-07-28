//! Prints this process's environment, NUL-delimited, between two markers.
//!
//! Reimplements `desktop-plus/vendor/printenvz` (a ten-line C program) in Rust, so no native build step
//! is needed. `git-ops`'s hooks layer runs it inside the user's login shell to find out what environment
//! that shell builds — see `crate::hooks::shell_env`.
//!
//! Three details are the whole design:
//!
//! - **NUL-delimited**, because a variable's value may contain newlines.
//! - **Bracketed by markers**, because a user's init files may print to stdout, and that text must not
//!   be parsed as variables.
//! - **Bytes, not strings.** On Unix a value is arbitrary bytes; writing it through a UTF-8 string type
//!   would either fail or silently alter it, so the value goes out exactly as received.

use std::io::{self, Write};

fn main() -> io::Result<()> {
    // Locked once: a partial write interleaved with anything else would corrupt the framing.
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    out.write_all(b"--printenvz--begin\n")?;

    for (name, value) in std::env::vars_os() {
        out.write_all(as_bytes(&name))?;
        out.write_all(b"=")?;
        out.write_all(as_bytes(&value))?;
        out.write_all(&[0])?;
    }

    out.write_all(b"\n--printenvz--end\n")?;
    out.flush()
}

/// The raw bytes of an environment string.
#[cfg(unix)]
fn as_bytes(value: &std::ffi::OsString) -> &[u8] {
    use std::os::unix::ffi::OsStrExt;

    value.as_os_str().as_bytes()
}

/// On Windows an environment string is UTF-16, so it round-trips through UTF-8 instead.
///
/// `to_string_lossy` cannot fail, and an unpaired surrogate — which is all it would alter — cannot
/// appear in a variable the shell itself set.
#[cfg(not(unix))]
fn as_bytes(value: &std::ffi::OsString) -> std::borrow::Cow<'_, [u8]> {
    match value.to_string_lossy() {
        std::borrow::Cow::Borrowed(text) => std::borrow::Cow::Borrowed(text.as_bytes()),
        std::borrow::Cow::Owned(text) => std::borrow::Cow::Owned(text.into_bytes()),
    }
}
