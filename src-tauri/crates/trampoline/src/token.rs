//! Short-lived tokens authenticating the trampoline binary to the app.
//!
//! Ported from `desktop-plus/app/src/lib/trampoline/trampoline-tokens.ts`.
//!
//! # Why this exists
//!
//! The server listens on a TCP port on `127.0.0.1`, so **any local process can connect to it** —
//! including something running as a different user on a shared machine. The token is what
//! distinguishes "git, invoked by us, for an operation we are currently performing" from anything
//! else that found the port.
//!
//! Two properties do the work, both preserved from the original:
//! - Tokens are **scoped to a single operation**. [`TokenStore::scoped`] issues one, runs the git
//!   operation, and revokes it — so a leaked token is useless once the push finishes.
//! - Tokens are **random**, not derived from anything guessable.
//!
//! Comparison is constant-time, which the original's `Set.has` was not. That matters less here than
//! for a long-lived secret, but a timing oracle on a live token is worth closing for free.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// Issues, validates and revokes trampoline tokens.
///
/// Cheap to clone; clones share the same set.
#[derive(Debug, Clone, Default)]
pub struct TokenStore {
    live: Arc<Mutex<HashSet<String>>>,
}

impl TokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues a token and records it as live.
    ///
    /// Prefer [`TokenStore::scoped`], which cannot forget to revoke.
    pub fn issue(&self) -> String {
        let token = generate_token();
        self.lock().insert(token.clone());
        token
    }

    /// Revokes a token. Revoking an unknown token is a no-op.
    pub fn revoke(&self, token: &str) {
        self.lock().remove(token);
    }

    /// Whether `token` is currently live.
    ///
    /// Compared in constant time against each live token, so a caller probing the server can't
    /// learn a valid token byte-by-byte from response timing.
    pub fn is_valid(&self, token: &str) -> bool {
        let live = self.lock();
        // `fold` rather than `any`, so the loop doesn't short-circuit on a match and leak position.
        live.iter().fold(false, |found, candidate| {
            constant_time_eq(candidate.as_bytes(), token.as_bytes()) | found
        })
    }

    /// Runs `operation` with a token that is revoked as soon as it returns.
    ///
    /// Mirrors `withTrampolineToken`. Revocation happens even if `operation` fails, because the
    /// guard drops on unwind.
    pub async fn scoped<T, F, Fut>(&self, operation: F) -> T
    where
        F: FnOnce(String) -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let token = self.issue();
        let _guard = RevokeOnDrop {
            store: self.clone(),
            token: token.clone(),
        };
        operation(token).await
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        // A panic while holding this lock would poison it. There is no recovery that makes sense —
        // a poisoned token store means we can no longer authenticate git — so take the inner value
        // and carry on rather than propagating a panic into every later git operation.
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Revokes its token when dropped, including on unwind.
struct RevokeOnDrop {
    store: TokenStore,
    token: String,
}

impl Drop for RevokeOnDrop {
    fn drop(&mut self) {
        self.store.revoke(&self.token);
    }
}

/// A random token.
///
/// Built from the OS random source rather than a PRNG. Implemented without a crate dependency
/// because this is the only randomness the crate needs; swap in `rand`/`uuid` if that changes.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn fill_random(buffer: &mut [u8]) {
    use std::io::Read;
    // /dev/urandom is the right source on Linux and macOS, and needs no crate.
    let mut file = std::fs::File::open("/dev/urandom")
        .expect("the platform must provide /dev/urandom to authenticate git operations");
    file.read_exact(buffer)
        .expect("reading from /dev/urandom must succeed");
}

#[cfg(not(unix))]
fn fill_random(_buffer: &mut [u8]) {
    // rdc targets Linux and macOS. A Windows port must supply a real CSPRNG here — a weak token
    // would let any local process impersonate git, so failing loudly beats a guessable fallback.
    unimplemented!("token generation needs a Windows CSPRNG (BCryptGenRandom)")
}

/// Compares two byte strings without short-circuiting on the first difference.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    // Accumulate differences instead of returning early.
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issues_a_valid_token() {
        let store = TokenStore::new();
        let token = store.issue();
        assert!(store.is_valid(&token));
    }

    #[test]
    fn rejects_an_unknown_token() {
        let store = TokenStore::new();
        store.issue();
        assert!(!store.is_valid("not-a-real-token"));
    }

    #[test]
    fn rejects_an_empty_token() {
        let store = TokenStore::new();
        store.issue();
        assert!(!store.is_valid(""));
    }

    #[test]
    fn rejects_a_token_after_revocation() {
        let store = TokenStore::new();
        let token = store.issue();
        store.revoke(&token);
        assert!(!store.is_valid(&token));
    }

    #[test]
    fn revoking_an_unknown_token_is_harmless() {
        let store = TokenStore::new();
        let token = store.issue();
        store.revoke("something-else");
        assert!(store.is_valid(&token), "the live token must be untouched");
    }

    #[test]
    fn issues_distinct_tokens() {
        let store = TokenStore::new();
        let tokens: HashSet<String> = (0..100).map(|_| store.issue()).collect();
        assert_eq!(tokens.len(), 100, "tokens must not repeat");
    }

    #[test]
    fn tokens_are_long_enough_to_be_unguessable() {
        // 32 bytes hex-encoded. A short token would be brute-forceable by a local process.
        assert_eq!(TokenStore::new().issue().len(), 64);
    }

    #[tokio::test]
    async fn scoped_revokes_the_token_afterwards() {
        let store = TokenStore::new();
        // A clone for the async block to own — clones share the same live set, which is what makes
        // this a meaningful check.
        let inside = store.clone();
        let seen = store
            .scoped(|token| async move {
                assert!(
                    inside.is_valid(&token),
                    "valid for the operation's duration"
                );
                token
            })
            .await;

        assert!(
            !store.is_valid(&seen),
            "revoked once the operation finished"
        );
    }

    #[tokio::test]
    async fn scoped_revokes_even_when_the_operation_returns_an_error() {
        let store = TokenStore::new();
        let result: Result<(), String> = store
            .scoped(|token| async move { Err(format!("failed with {token}")) })
            .await;

        let token = result
            .expect_err("the operation failed")
            .replace("failed with ", "");
        assert!(!store.is_valid(&token), "revoked despite the failure");
    }

    #[tokio::test]
    async fn scoped_tokens_are_independent() {
        let store = TokenStore::new();
        let first = store.issue();
        let inside = store.clone();
        let expected = first.clone();
        store
            .scoped(|token| async move {
                assert_ne!(token, expected);
                assert!(inside.is_valid(&expected), "an unrelated token stays live");
            })
            .await;
        assert!(
            store.is_valid(&first),
            "the scoped token's revocation must not touch it"
        );
    }

    #[test]
    fn constant_time_eq_matches_ordinary_equality() {
        for (a, b) in [
            ("", ""),
            ("a", "a"),
            ("a", "b"),
            ("abc", "abc"),
            ("abc", "abd"),
            ("abc", "ab"),
            ("", "a"),
        ] {
            assert_eq!(
                constant_time_eq(a.as_bytes(), b.as_bytes()),
                a == b,
                "for {a:?} vs {b:?}"
            );
        }
    }
}
