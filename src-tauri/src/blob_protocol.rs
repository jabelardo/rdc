//! Serving blob bytes to the webview over `rdc-blob://`.
//!
//! An image diff needs the *bytes* of two blobs in front of the user. The original base64-encoded them into
//! a `data:` URI and shipped that through IPC, which means a 4 MB PNG becomes ~5.5 MB of JSON string, copied
//! twice, resident for as long as the diff is open. A URL the webview can fetch avoids all of it: the bytes
//! never enter JavaScript unless something asks for them, and `<img src>` asks natively.
//!
//! # Capability URLs, not validated ones
//!
//! The obvious design — `rdc-blob://…?repo=…&rev=…&path=…`, validated against the repositories the app has
//! open — **cannot be written correctly today**, because there is no such list: repository state lives in
//! the frontend store until Phase 7. Validating against nothing would mean serving any path on disk to
//! anything that could construct a URL.
//!
//! So a URL is a **capability**. Rust registers a blob it has decided to expose and hands back an opaque
//! token; the webview can fetch what it was given and cannot name anything else. Scoping is then structural
//! rather than a rule I could get wrong — the same reasoning as the trampoline's token, where the boundary
//! is possession rather than a check.
//!
//! # The URL's shape is Tauri's, and platform-dependent
//!
//! Custom schemes are served at `<scheme>://localhost/<path>` on Linux and macOS, and at
//! `http://<scheme>.localhost/<path>` on Windows and Android. That is why the **URL is built in Rust** and
//! travels in the payload: one place decides it, and the frontend never assembles one.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git_ops::diff::{media_type_for, BlobSource, BlobUrls};

/// The scheme registered with the webview.
pub const SCHEME: &str = "rdc-blob";

/// How many blobs stay addressable.
///
/// A URL stops working once its entry is evicted, so this has to comfortably exceed what one screen can
/// show — a two-up image diff needs two, and a user scrolling a history of them needs a few more. It is a
/// bound on memory held by *addresses*, not by bytes: entries are a path and a revision, and the bytes are
/// read on demand.
const CAPACITY: usize = 256;

/// A blob the app has decided the webview may read.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Blob {
    repository: PathBuf,
    /// Repository-relative.
    path: String,
    source: BlobSource,
}

/// The blobs currently addressable, and their tokens.
///
/// Cheap to clone; clones share one table.
#[derive(Debug, Clone, Default)]
pub struct BlobRegistry {
    inner: Arc<Mutex<Registry>>,
}

#[derive(Debug, Default)]
struct Registry {
    by_token: HashMap<String, Blob>,
    /// So asking twice for the same blob yields the same URL — which keeps a re-render from filling the
    /// table with duplicates, and lets the webview cache by URL.
    by_blob: HashMap<Blob, String>,
    /// Insertion order, for eviction.
    order: VecDeque<String>,
}

impl BlobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a blob and returns the URL that serves it.
    pub fn url_for(&self, repository: &Path, path: &str, source: BlobSource) -> String {
        let blob = Blob {
            repository: repository.to_path_buf(),
            path: path.to_owned(),
            source,
        };

        let mut registry = self.lock();

        if let Some(token) = registry.by_blob.get(&blob) {
            return url_for_token(token);
        }

        let token = new_token();
        registry.by_token.insert(token.clone(), blob.clone());
        registry.by_blob.insert(blob, token.clone());
        registry.order.push_back(token.clone());

        while registry.order.len() > CAPACITY {
            if let Some(evicted) = registry.order.pop_front() {
                if let Some(blob) = registry.by_token.remove(&evicted) {
                    registry.by_blob.remove(&blob);
                }
            }
        }

        url_for_token(&token)
    }

    fn resolve(&self, token: &str) -> Option<Blob> {
        self.lock().by_token.get(token).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        // A poisoned mutex would mean a panic inside these few lines, which they cannot do. Recovering
        // keeps one panic elsewhere from making every image in the app unreadable.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl BlobUrls for BlobRegistry {
    /// Registers the blob and hands back its URL.
    ///
    /// This is the injection point `git-ops` asks for: it needs to *name* bytes in an image diff and has no
    /// business knowing a URL's shape or holding the table that resolves one.
    fn url_for(&self, repository: &Path, path: &str, source: BlobSource) -> String {
        BlobRegistry::url_for(self, repository, path, source)
    }
}

/// A token no page can guess.
///
/// Everything in the registry is something the app chose to show *this* page, so the entropy is not what
/// scopes access — the registry is. It closes the smaller gap: with a guessable id, a script could read
/// blobs registered for a different repository in the same session.
fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The URL that serves `token`.
#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn url_for_token(token: &str) -> String {
    format!("{SCHEME}://localhost/{token}")
}

/// Windows and Android serve custom schemes over `http` instead.
#[cfg(any(target_os = "windows", target_os = "android"))]
fn url_for_token(token: &str) -> String {
    format!("http://{SCHEME}.localhost/{token}")
}

/// Answers a request for a blob.
///
/// Errors carry **no detail**: a page that guessed a token learns only that it guessed wrong, and one that
/// asked for a deleted file learns only that it is gone. Diagnostics belong in the app's log, not in a
/// response to the webview.
pub async fn respond(
    registry: &BlobRegistry,
    request: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');

    let Some(blob) = registry.resolve(token) else {
        return empty(http::StatusCode::NOT_FOUND);
    };

    let bytes = match &blob.source {
        BlobSource::Commit(commitish) => {
            git_ops::show::get_blob_contents(&blob.repository, commitish, &blob.path)
                .await
                .ok()
        }
        // Straight off disk, which is what "the working copy" means — and what the user is looking at.
        BlobSource::WorkingTree => tokio::fs::read(blob.repository.join(&blob.path)).await.ok(),
    };

    let Some(bytes) = bytes else {
        return empty(http::StatusCode::NOT_FOUND);
    };

    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, media_type_for(&blob.path))
        .header(http::header::CONTENT_LENGTH, bytes.len())
        // A blob at a revision is immutable, and one in the working tree is addressed by a token that was
        // minted for the state the user is looking at — so neither wants revalidating mid-diff.
        .header(http::header::CACHE_CONTROL, "no-cache")
        .body(bytes)
        .unwrap_or_else(|_| empty(http::StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(status: http::StatusCode) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("an empty response with a valid status always builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str) -> http::Request<Vec<u8>> {
        http::Request::builder()
            .uri(url)
            .body(Vec::new())
            .expect("a request builds")
    }

    /// The token out of a URL this module produced.
    fn token_of(url: &str) -> String {
        url.rsplit('/').next().expect("a token").to_owned()
    }

    #[test]
    fn a_url_carries_an_unguessable_token() {
        let registry = BlobRegistry::new();

        let url = registry.url_for(Path::new("/repo"), "a.png", BlobSource::WorkingTree);

        assert!(url.contains(SCHEME), "{url}");
        assert_eq!(token_of(&url).len(), 32, "a v4 uuid without dashes");
    }

    #[test]
    fn asking_twice_for_the_same_blob_gives_the_same_url() {
        // A re-render must not fill the table with duplicates, and the webview should be able to cache by
        // URL rather than re-fetching the same bytes.
        let registry = BlobRegistry::new();

        let first = registry.url_for(Path::new("/repo"), "a.png", BlobSource::WorkingTree);
        let second = registry.url_for(Path::new("/repo"), "a.png", BlobSource::WorkingTree);

        assert_eq!(first, second);
    }

    #[test]
    fn the_same_path_at_a_different_revision_is_a_different_blob() {
        let registry = BlobRegistry::new();

        let working = registry.url_for(Path::new("/repo"), "a.png", BlobSource::WorkingTree);
        let committed = registry.url_for(
            Path::new("/repo"),
            "a.png",
            BlobSource::Commit("HEAD".to_owned()),
        );
        let other = registry.url_for(
            Path::new("/repo"),
            "a.png",
            BlobSource::Commit("HEAD~1".to_owned()),
        );

        assert_ne!(working, committed);
        assert_ne!(committed, other);
    }

    #[test]
    fn the_same_path_in_a_different_repository_is_a_different_blob() {
        let registry = BlobRegistry::new();

        assert_ne!(
            registry.url_for(Path::new("/one"), "a.png", BlobSource::WorkingTree),
            registry.url_for(Path::new("/two"), "a.png", BlobSource::WorkingTree)
        );
    }

    #[tokio::test]
    async fn an_unknown_token_is_not_found() {
        // The whole scoping argument: a page can only fetch what it was handed. A token it invented names
        // nothing, whatever path it might have hoped to reach.
        let registry = BlobRegistry::new();

        let response = respond(&registry, &request("rdc-blob://localhost/deadbeef")).await;

        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
        assert!(response.body().is_empty(), "and it learns nothing else");
    }

    #[tokio::test]
    async fn a_token_cannot_be_bent_towards_another_path() {
        // There is nothing in the URL to tamper with — no path, no revision, no repository — so the usual
        // traversal attempt has nowhere to go.
        let registry = BlobRegistry::new();
        let url = registry.url_for(Path::new("/repo"), "a.png", BlobSource::WorkingTree);
        let token = token_of(&url);

        for attempt in [
            format!("rdc-blob://localhost/{token}/../../etc/passwd"),
            format!("rdc-blob://localhost/{token}?path=/etc/passwd"),
            format!("rdc-blob://localhost/{token}x"),
        ] {
            let response = respond(&registry, &request(&attempt)).await;
            assert_eq!(
                response.status(),
                http::StatusCode::NOT_FOUND,
                "{attempt} must not resolve"
            );
        }
    }

    #[tokio::test]
    async fn serves_a_file_from_the_working_tree_with_its_media_type() {
        let directory = tempfile::tempdir().expect("failed to create a temporary directory");
        // The PNG signature; the bytes only have to survive, not be a real image.
        let contents = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        std::fs::write(directory.path().join("a.png"), contents).expect("failed to write");

        let registry = BlobRegistry::new();
        let url = registry.url_for(directory.path(), "a.png", BlobSource::WorkingTree);

        let response = respond(&registry, &request(&url)).await;

        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.body(), &contents.to_vec());
        assert_eq!(
            response.headers().get(http::header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(
            response
                .headers()
                .get(http::header::CONTENT_LENGTH)
                .unwrap(),
            "8"
        );
    }

    #[tokio::test]
    async fn a_deleted_working_tree_file_is_not_found() {
        let directory = tempfile::tempdir().expect("failed to create a temporary directory");
        let registry = BlobRegistry::new();
        let url = registry.url_for(directory.path(), "gone.png", BlobSource::WorkingTree);

        let response = respond(&registry, &request(&url)).await;

        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn old_entries_are_evicted_once_the_table_is_full() {
        let registry = BlobRegistry::new();
        let first = registry.url_for(Path::new("/repo"), "0.png", BlobSource::WorkingTree);

        for index in 1..=CAPACITY {
            registry.url_for(
                Path::new("/repo"),
                &format!("{index}.png"),
                BlobSource::WorkingTree,
            );
        }

        assert!(
            registry.resolve(&token_of(&first)).is_none(),
            "the oldest entry is gone"
        );
        assert_eq!(
            registry.lock().by_token.len(),
            CAPACITY,
            "and the table stays bounded"
        );
        assert_eq!(
            registry.lock().by_blob.len(),
            CAPACITY,
            "including the reverse index, or a re-registration would hand out a dead token"
        );
    }
}
