use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationState {
    Running,
    TakingLongerThanExpected,
    Cancelling,
    Recovering,
    Completed,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationLifecycleState {
    TakingLongerThanExpected,
    Cancelling,
    Recovering,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationOutcome {
    Unchanged,
    Recovered,
    Completed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitOperationKind {
    Fetch,
    Push,
    Pull,
    Checkout,
    Clone,
    Commit,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OperationScope {
    Repository {
        lock_key: String,
        repository_path: String,
    },
    CloneDestination {
        lock_key: String,
        destination_path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CancellationCapability {
    Unavailable,
    Available { label: String },
    Requested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationErrorKind {
    Cancelled,
    TimedOut,
    RecoveryFailed,
    Conflict,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub kind: OperationErrorKind,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRefresh {
    pub remote_names: Vec<String>,
    pub repository_facts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationHook {
    pub id: u64,
    pub hook: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub id: String,
    pub scope: OperationScope,
    pub owner_window: Option<String>,
    pub operation: GitOperationKind,
    pub state: OperationState,
    pub cancellation: CancellationCapability,
    pub progress: Option<OperationProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook: Option<OperationHook>,
    pub last_activity_at: u64,
    pub outcome: Option<OperationOutcome>,
    pub error: Option<OperationError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<OperationRefresh>,
}

// `rename_all` only renames the *variants*; the payload fields need `rename_all_fields`, which is
// how `operation_id` used to reach the frontend as snake_case while `src/models/operation.ts`
// declared `operationId`. Nothing read it, so nothing failed — the wire fixtures below are what
// keep it that way.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OperationEvent {
    Progress {
        operation_id: String,
        progress: OperationProgress,
    },
    State {
        operation_id: String,
        state: OperationLifecycleState,
    },
    Finished {
        operation_id: String,
        state: OperationState,
        outcome: OperationOutcome,
        error: Option<OperationError>,
    },
}

/// Registry event plus the routing metadata needed by every window.
///
/// A renderer can discard events for another repository without consulting a global busy flag. The
/// record snapshot also lets an observer distinguish the owner window from a peer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEventEnvelope {
    pub record: OperationRecord,
    pub event: OperationEvent,
}
