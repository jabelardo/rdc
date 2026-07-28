//! Terminal output shared by several sequential Git operations.
//!
//! Ported from `desktop-plus/app/src/lib/git/multi-operation-terminal-output.ts`.
//!
//! The TypeScript API nested three callback layers to model "output is available", subscription,
//! and individual chunks. Rust instead exposes a cloneable aggregator directly: each Git operation
//! gets [`MultiOperationTerminalOutput::callback`], and the eventual transport subscribes once.
//! Late subscribers receive the bounded history before live output; live chunks are never trimmed.
//! [`TerminalOutputSubscription`] removes its listener on drop, replacing the original explicit
//! `unsubscribe` function.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use crate::exec::TERMINAL_OUTPUT_CAPACITY;
use crate::terminal_output::push_terminal_chunk;

type StartCallback = Box<dyn FnOnce() + Send>;
type SubscriberCallback = Box<dyn Fn(&str) + Send + Sync>;

struct Inner {
    capacity: usize,
    state: Mutex<State>,
}

struct State {
    chunks: Vec<String>,
    subscribers: HashMap<usize, Arc<Subscriber>>,
    next_subscriber_id: usize,
    started: bool,
    on_output_started: Option<StartCallback>,
}

struct Subscriber {
    callback: SubscriberCallback,
    /// Serializes the initial replay with live delivery for this subscriber.
    delivery: Mutex<()>,
}

/// Aggregates terminal output from several Git operations into one bounded history and live stream.
///
/// Clones share the same state, so each sequential operation can own a callback without losing the
/// history accumulated by the operations before it.
#[derive(Clone)]
pub struct MultiOperationTerminalOutput {
    inner: Arc<Inner>,
}

impl MultiOperationTerminalOutput {
    /// Creates an aggregator retaining at most `capacity` bytes for late subscribers.
    pub fn new(capacity: usize) -> Self {
        Self::with_optional_start_callback(capacity, None)
    }

    /// Creates an aggregator that calls `on_output_started` once, on the first output.
    pub fn with_start_callback(
        capacity: usize,
        on_output_started: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self::with_optional_start_callback(capacity, Some(Box::new(on_output_started)))
    }

    fn with_optional_start_callback(
        capacity: usize,
        on_output_started: Option<StartCallback>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                capacity,
                state: Mutex::new(State {
                    chunks: Vec::new(),
                    subscribers: HashMap::new(),
                    next_subscriber_id: 0,
                    started: false,
                    on_output_started,
                }),
            }),
        }
    }

    /// Appends raw process output and forwards it to current subscribers.
    pub fn push(&self, chunk: &[u8]) {
        let chunk = String::from_utf8_lossy(chunk).into_owned();
        let (on_output_started, subscribers) = {
            let mut state = lock(&self.inner.state);
            let on_output_started = if state.started {
                None
            } else {
                state.started = true;
                state.on_output_started.take()
            };

            push_terminal_chunk(&mut state.chunks, self.inner.capacity, &chunk);
            let subscribers = state.subscribers.values().cloned().collect::<Vec<_>>();
            (on_output_started, subscribers)
        };

        if let Some(on_output_started) = on_output_started {
            on_output_started();
        }

        // Live output is deliberately untrimmed. Only the replay buffer is capacity-bound.
        for subscriber in subscribers {
            let _delivery = lock(&subscriber.delivery);
            (subscriber.callback)(&chunk);
        }
    }

    /// Replays buffered output, then streams future chunks until the returned handle is dropped.
    pub fn subscribe(
        &self,
        subscriber: impl Fn(&str) + Send + Sync + 'static,
    ) -> TerminalOutputSubscription {
        let subscriber = Arc::new(Subscriber {
            callback: Box::new(subscriber),
            delivery: Mutex::new(()),
        });

        // Holding this subscriber's delivery lock across registration and replay makes a concurrent
        // push wait, so buffered chunks are always observed before live chunks.
        let delivery = lock(&subscriber.delivery);
        let (id, chunks) = {
            let mut state = lock(&self.inner.state);
            let id = state.next_subscriber_id;
            state.next_subscriber_id += 1;
            state.subscribers.insert(id, Arc::clone(&subscriber));
            (id, state.chunks.clone())
        };
        for chunk in &chunks {
            (subscriber.callback)(chunk);
        }
        drop(delivery);

        TerminalOutputSubscription {
            id,
            inner: Arc::downgrade(&self.inner),
        }
    }

    /// Returns a process-stream callback sharing this aggregator.
    pub fn callback(&self) -> impl FnMut(&[u8]) + Send + 'static {
        let output = self.clone();
        move |chunk| output.push(chunk)
    }
}

impl Default for MultiOperationTerminalOutput {
    fn default() -> Self {
        Self::new(TERMINAL_OUTPUT_CAPACITY)
    }
}

/// Keeps a terminal-output subscription active until dropped.
pub struct TerminalOutputSubscription {
    id: usize,
    inner: Weak<Inner>,
}

impl Drop for TerminalOutputSubscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            lock(&inner.state).subscribers.remove(&self.id);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::exec::{git_streaming, GitOptions};

    async fn run_git_version(output: &MultiOperationTerminalOutput) {
        let stdout = output.clone();
        let stderr = output.clone();
        git_streaming(
            &["version"],
            env!("CARGO_MANIFEST_DIR"),
            "test",
            GitOptions::default(),
            move |chunk| stdout.push(chunk),
            move |chunk| stderr.push(chunk),
        )
        .await
        .expect("git version should succeed");
    }

    #[tokio::test]
    async fn streams_output_from_two_git_operations() {
        let output = MultiOperationTerminalOutput::new(256 * 1024);
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&chunks);
        let _subscription = output.subscribe(move |chunk| {
            received.lock().unwrap().push(chunk.to_owned());
        });

        run_git_version(&output).await;
        assert_eq!(chunks.lock().unwrap().len(), 1);
        run_git_version(&output).await;
        assert_eq!(chunks.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn buffers_output_from_two_git_operations() {
        let output = MultiOperationTerminalOutput::new(256 * 1024);
        run_git_version(&output).await;
        run_git_version(&output).await;

        let chunks = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&chunks);
        let _subscription = output.subscribe(move |chunk| {
            received.lock().unwrap().push(chunk.to_owned());
        });

        assert_eq!(chunks.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn calls_the_start_callback_only_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let called = Arc::clone(&calls);
        let output = MultiOperationTerminalOutput::with_start_callback(256 * 1024, move || {
            called.fetch_add(1, Ordering::SeqCst);
        });

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        run_git_version(&output).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        run_git_version(&output).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn streams_output_untrimmed() {
        let output = MultiOperationTerminalOutput::new(10);
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&chunks);
        let _subscription = output.subscribe(move |chunk| {
            received.lock().unwrap().push(chunk.to_owned());
        });

        run_git_version(&output).await;

        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].len() > 10);
    }

    #[tokio::test]
    async fn trims_buffered_output() {
        let output = MultiOperationTerminalOutput::new(10);
        run_git_version(&output).await;
        run_git_version(&output).await;

        let chunks = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&chunks);
        let _subscription = output.subscribe(move |chunk| {
            received.lock().unwrap().push(chunk.to_owned());
        });

        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 10);
    }

    #[tokio::test]
    async fn handles_multiple_subscribers() {
        let output = MultiOperationTerminalOutput::new(10);
        run_git_version(&output).await;
        run_git_version(&output).await;

        let first = Arc::new(Mutex::new(Vec::new()));
        let first_received = Arc::clone(&first);
        let _first_subscription = output.subscribe(move |chunk| {
            first_received.lock().unwrap().push(chunk.to_owned());
        });

        let second = Arc::new(Mutex::new(Vec::new()));
        let second_received = Arc::clone(&second);
        let _second_subscription = output.subscribe(move |chunk| {
            second_received.lock().unwrap().push(chunk.to_owned());
        });

        assert_eq!(first.lock().unwrap().last(), second.lock().unwrap().last());
    }

    #[test]
    fn dropping_a_subscription_stops_live_delivery() {
        let output = MultiOperationTerminalOutput::new(256 * 1024);
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&chunks);

        {
            let _subscription = output.subscribe(move |chunk| {
                received.lock().unwrap().push(chunk.to_owned());
            });
            output.push(b"first");
        }
        output.push(b"second");

        assert_eq!(*chunks.lock().unwrap(), ["first"]);
    }
}
