use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationOutcome {
    Unchanged,
    Recovered,
    Completed,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CancellationCapability {
    Unavailable,
    Available { label: String },
    Requested,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationErrorKind {
    Cancelled,
    TimedOut,
    RecoveryFailed,
    Conflict,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub kind: OperationErrorKind,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub id: String,
    pub scope: OperationScope,
    pub owner_window: Option<String>,
    pub operation: GitOperationKind,
    pub state: OperationState,
    pub cancellation: CancellationCapability,
    pub progress: Option<OperationProgress>,
    pub last_activity_at: u64,
    pub outcome: Option<OperationOutcome>,
    pub error: Option<OperationError>,
}
