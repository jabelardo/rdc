use std::any::Any;
use std::sync::Once;
use tauri_plugin_log::{FileOpenStrategy, RotationStrategy};

const LOG_SESSIONS_TO_KEEP: usize = 14;
const MAX_LOG_FILE_SIZE: u128 = 10 * 1024 * 1024;

pub fn application_log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        // Upstream retained at most fourteen session files. Starting a fresh
        // file per launch makes the log useful even when the previous process
        // ended in a panic and never flushed a graceful-shutdown marker.
        .file_open_strategy(FileOpenStrategy::Rotate)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_SESSIONS_TO_KEEP))
        .max_file_size(MAX_LOG_FILE_SIZE)
        .build()
}

fn panic_payload(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

fn format_panic(payload: &str, location: Option<(&str, u32, u32)>) -> String {
    match location {
        Some((file, line, column)) => {
            format!("native panic at {file}:{line}:{column}: {payload}")
        }
        None => format!("native panic at an unknown location: {payload}"),
    }
}

/**
 * Preserve Rust's ordinary panic output while also sending the failure through
 * the application logger. The hook is process-global, so multiple Tauri test
 * contexts or future window setup paths must not install it twice.
 */
pub fn install_panic_logging() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|location| (location.file(), location.line(), location.column()));
            log::error!(
                target: "rdc::panic",
                "{}",
                format_panic(panic_payload(info.payload()), location)
            );
            previous(info);
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_record_contains_payload_and_source_location() {
        assert_eq!(
            format_panic("broken state", Some(("src/example.rs", 12, 7))),
            "native panic at src/example.rs:12:7: broken state"
        );
    }

    #[test]
    fn panic_payload_handles_string_and_opaque_values_without_panicking() {
        let owned = String::from("owned message");
        let opaque = 42_u8;

        assert_eq!(panic_payload(&"borrowed message"), "borrowed message");
        assert_eq!(panic_payload(&owned), "owned message");
        assert_eq!(panic_payload(&opaque), "non-string panic payload");
    }

    #[test]
    fn log_retention_matches_upstreams_fourteen_session_ceiling() {
        assert_eq!(LOG_SESSIONS_TO_KEEP, 14);
    }
}
