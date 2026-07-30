use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

use serde::Serialize;
use serde_json::Value;

const MAX_NOTIFICATION_ID: u32 = i32::MAX as u32;
#[cfg(target_os = "macos")]
const RESPONSE_TIMEOUT_MILLISECONDS: u32 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
// macOS can produce all three values. Other desktop platforms preserve
// upstream's always-granted contract while sharing this wire type.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum NotificationPermission {
    Default,
    Granted,
    Denied,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy)]
enum NativeAuthorization {
    NotDetermined,
    Denied,
    Authorized,
    Provisional,
    Ephemeral,
    Unknown,
}

#[cfg(any(target_os = "macos", test))]
fn permission_from_authorization(status: NativeAuthorization) -> NotificationPermission {
    match status {
        NativeAuthorization::NotDetermined | NativeAuthorization::Unknown => {
            NotificationPermission::Default
        }
        NativeAuthorization::Denied => NotificationPermission::Denied,
        NativeAuthorization::Authorized
        | NativeAuthorization::Provisional
        | NativeAuthorization::Ephemeral => NotificationPermission::Granted,
    }
}

#[derive(Debug, Clone)]
struct PendingNotification {
    owner: Option<String>,
    user_info: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEvent {
    pub event: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_info: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NotificationRoute {
    pub window_label: String,
    pub event: NotificationEvent,
}

pub struct NotificationState {
    next_id: AtomicU32,
    pending: Mutex<HashMap<u32, PendingNotification>>,
}

impl NotificationState {
    pub fn new() -> Self {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        let seed =
            u32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & MAX_NOTIFICATION_ID;
        Self::with_next_id(seed.max(1))
    }

    fn with_next_id(next_id: u32) -> Self {
        Self {
            next_id: AtomicU32::new(next_id),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn reserve(&self, owner: &str, user_info: Option<Value>) -> u32 {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            let id = self
                .next_id
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    Some(if current >= MAX_NOTIFICATION_ID || current == 0 {
                        1
                    } else {
                        current + 1
                    })
                })
                .unwrap_or(1)
                .max(1);
            if let std::collections::hash_map::Entry::Vacant(entry) = pending.entry(id) {
                entry.insert(PendingNotification {
                    owner: Some(owner.to_owned()),
                    user_info,
                });
                return id;
            }
        }
    }

    pub fn remove(&self, id: u32) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
    }

    pub fn remove_window(&self, window_label: &str) {
        for notification in self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values_mut()
        {
            if notification.owner.as_deref() == Some(window_label) {
                notification.owner = None;
            }
        }
    }

    pub fn route_click(
        &self,
        id: u32,
        live_windows: &HashSet<String>,
        focused_window: Option<&str>,
    ) -> Option<NotificationRoute> {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id)?;
        let window_label = pending
            .owner
            .filter(|owner| live_windows.contains(owner))
            .or_else(|| {
                focused_window
                    .filter(|label| live_windows.contains(*label))
                    .map(str::to_owned)
            })
            .or_else(|| live_windows.contains("main").then(|| "main".to_owned()))
            .or_else(|| live_windows.iter().min().cloned())?;
        Some(NotificationRoute {
            window_label,
            event: NotificationEvent {
                event: "click",
                id: id.to_string(),
                user_info: pending.user_info,
            },
        })
    }
}

pub fn validate_user_info(user_info: &Option<Value>) -> Result<(), &'static str> {
    if user_info.as_ref().is_some_and(|value| !value.is_object()) {
        Err("notification userInfo must be a JSON object")
    } else {
        Ok(())
    }
}

impl Default for NotificationState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn show_native_notification(
    id: u32,
    title: &str,
    body: &str,
) -> Result<notify_rust::NotificationHandle, notify_rust::error::Error> {
    #[cfg(not(target_os = "macos"))]
    let _ = id;
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body);
    #[cfg(target_os = "macos")]
    notification
        .id(id.to_string())
        .sound_name("")
        .timeout(notify_rust::Timeout::Milliseconds(
            RESPONSE_TIMEOUT_MILLISECONDS,
        ));
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "Open");
    notification.show()
}

#[cfg(target_os = "macos")]
pub async fn get_permission() -> Result<NotificationPermission, String> {
    use mac_usernotifications::AuthorizationStatus;

    let settings = notify_rust::get_notification_settings()
        .await
        .map_err(|error| error.to_string())?;
    let status = match settings.authorization_status {
        AuthorizationStatus::NotDetermined => NativeAuthorization::NotDetermined,
        AuthorizationStatus::Denied => NativeAuthorization::Denied,
        AuthorizationStatus::Authorized => NativeAuthorization::Authorized,
        AuthorizationStatus::Provisional => NativeAuthorization::Provisional,
        AuthorizationStatus::Ephemeral => NativeAuthorization::Ephemeral,
        AuthorizationStatus::Unknown => NativeAuthorization::Unknown,
    };
    Ok(permission_from_authorization(status))
}

#[cfg(not(target_os = "macos"))]
pub async fn get_permission() -> Result<NotificationPermission, String> {
    Ok(NotificationPermission::Granted)
}

#[cfg(target_os = "macos")]
pub async fn request_permission() -> Result<bool, String> {
    notify_rust::request_auth()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn request_permission() -> Result<bool, String> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn live(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|label| (*label).to_owned()).collect()
    }

    #[test]
    fn ids_are_positive_unique_and_wrap_without_emitting_zero() {
        let state = NotificationState::with_next_id(MAX_NOTIFICATION_ID);
        assert_eq!(state.reserve("main", None), MAX_NOTIFICATION_ID);
        assert_eq!(state.reserve("main", None), 1);
        assert_eq!(state.reserve("main", None), 2);
    }

    #[test]
    fn click_routes_once_to_the_owner_with_exact_user_info() {
        let state = NotificationState::new();
        let user_info = json!({ "type": "pr-comment", "pull_request_number": 42 });
        let id = state.reserve("repository-1", Some(user_info.clone()));

        let route = state
            .route_click(id, &live(&["main", "repository-1"]), Some("main"))
            .expect("route");
        assert_eq!(route.window_label, "repository-1");
        assert_eq!(route.event.id, id.to_string());
        assert_eq!(route.event.user_info, Some(user_info));
        assert!(state
            .route_click(id, &live(&["main", "repository-1"]), Some("main"))
            .is_none());
    }

    #[test]
    fn missing_owner_falls_back_to_focused_then_main_then_first_label() {
        let state = NotificationState::new();
        let focused = state.reserve("gone", None);
        assert_eq!(
            state
                .route_click(
                    focused,
                    &live(&["main", "repository-2"]),
                    Some("repository-2")
                )
                .expect("focused route")
                .window_label,
            "repository-2"
        );

        let main = state.reserve("gone", None);
        assert_eq!(
            state
                .route_click(main, &live(&["repository-2", "main"]), None)
                .expect("main route")
                .window_label,
            "main"
        );

        let first = state.reserve("gone", None);
        assert_eq!(
            state
                .route_click(first, &live(&["repository-9", "repository-2"]), None)
                .expect("first route")
                .window_label,
            "repository-2"
        );
    }

    #[test]
    fn removing_a_window_keeps_payload_for_fallback_but_failed_show_removes_it() {
        let state = NotificationState::new();
        let fallback_id = state.reserve("repository-1", Some(json!({ "saved": true })));
        state.remove_window("repository-1");
        assert_eq!(
            state
                .route_click(fallback_id, &live(&["main"]), None)
                .expect("fallback")
                .event
                .user_info,
            Some(json!({ "saved": true }))
        );

        let failed_id = state.reserve("main", None);
        state.remove(failed_id);
        assert!(state
            .route_click(failed_id, &live(&["main"]), None)
            .is_none());
    }

    #[test]
    fn permission_mapping_preserves_default_denied_and_every_granted_state() {
        assert_eq!(
            permission_from_authorization(NativeAuthorization::NotDetermined),
            NotificationPermission::Default
        );
        assert_eq!(
            permission_from_authorization(NativeAuthorization::Unknown),
            NotificationPermission::Default
        );
        assert_eq!(
            permission_from_authorization(NativeAuthorization::Denied),
            NotificationPermission::Denied
        );
        for status in [
            NativeAuthorization::Authorized,
            NativeAuthorization::Provisional,
            NativeAuthorization::Ephemeral,
        ] {
            assert_eq!(
                permission_from_authorization(status),
                NotificationPermission::Granted
            );
        }
    }

    #[test]
    fn user_info_accepts_only_an_object_or_absence() {
        assert!(validate_user_info(&None).is_ok());
        assert!(validate_user_info(&Some(json!({ "type": "event" }))).is_ok());
        assert!(validate_user_info(&Some(json!(["event"]))).is_err());
        assert!(validate_user_info(&Some(json!("event"))).is_err());
        assert!(validate_user_info(&Some(Value::Null)).is_err());
    }
}
