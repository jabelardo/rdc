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

use std::borrow::Cow;
use std::io::{self, Write};

fn main() -> io::Result<()> {
    // Locked once: a partial write interleaved with anything else would corrupt the framing.
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    out.write_all(b"--printenvz--begin\n")?;

    for (name, value) in std::env::vars_os() {
        out.write_all(&as_bytes(&name))?;
        out.write_all(b"=")?;
        out.write_all(&as_bytes(&value))?;
        out.write_all(&[0])?;
    }

    out.write_all(b"\n--printenvz--end\n")?;
    out.flush()
}

/// The raw bytes of an environment string.
///
/// Both arms return `Cow` so the two platforms share one signature. They previously did not — the
/// Unix arm returned `&[u8]` and the Windows arm `Cow<[u8]>` — and because the Windows arm was
/// never compiled, the resulting `write_all` type mismatch sat undetected. Keep the signatures
/// identical: a per-OS seam is only useful if every arm type-checks.
#[cfg(unix)]
fn as_bytes(value: &std::ffi::OsString) -> Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;

    Cow::Borrowed(value.as_os_str().as_bytes())
}

/// On Windows an environment string is UTF-16, so it round-trips through UTF-8 instead.
///
/// `to_string_lossy` cannot fail, and an unpaired surrogate — which is all it would alter — cannot
/// appear in a variable the shell itself set.
#[cfg(not(unix))]
fn as_bytes(value: &std::ffi::OsString) -> Cow<'_, [u8]> {
    match value.to_string_lossy() {
        Cow::Borrowed(text) => Cow::Borrowed(text.as_bytes()),
        Cow::Owned(text) => Cow::Owned(text.into_bytes()),
    }
}
