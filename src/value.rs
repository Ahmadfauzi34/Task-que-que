use std::time::Duration;

use crate::lease_fence::FencedClaimedTask;
use crate::sync_queue::{QueueError, QueueResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TaskId(i64);

impl TaskId {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkerId(String);

impl WorkerId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskName(String);

impl TaskName {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPayload(String);

impl TaskPayload {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Priority(i64);

impl Priority {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaxRetries(i64);

impl MaxRetries {
    pub fn new(value: i64) -> QueueResult<Self> {
        if value < 0 {
            return Err(QueueError::InvalidState(
                "max_retries tidak boleh negatif".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryCount(i64);

impl RetryCount {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LeaseGeneration(i64);

impl LeaseGeneration {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseMutation {
    Applied,
    Stale,
}

impl LeaseMutation {
    pub fn is_applied(self) -> bool {
        matches!(self, Self::Applied)
    }

    pub(crate) fn from_affected_rows(affected: usize) -> Self {
        if affected == 1 {
            Self::Applied
        } else {
            Self::Stale
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotCount(i64);

impl SlotCount {
    pub fn new(value: i64) -> QueueResult<Self> {
        if value < 0 {
            return Err(QueueError::InvalidState(
                "slot count tidak boleh negatif".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TransportScore(f64);

impl TransportScore {
    pub fn new(value: f64) -> Self {
        let safe = if value.is_finite() {
            value.clamp(0.0, 1.0)
        } else {
            0.0
        };

        Self(safe)
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Epsilon(f64);

impl Epsilon {
    pub fn new(value: f64) -> QueueResult<Self> {
        if !value.is_finite() || value <= 0.0 {
            return Err(QueueError::InvalidState(
                "epsilon harus finite dan > 0".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LeaseDuration(Duration);

impl LeaseDuration {
    pub fn new(value: Duration) -> QueueResult<Self> {
        if value.as_nanos() == 0 {
            return Err(QueueError::InvalidState(
                "lease duration tidak boleh nol".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> Duration {
        self.0
    }

    pub fn as_secs_f64(self) -> f64 {
        self.0.as_secs_f64()
    }

    pub fn heartbeat_interval(self) -> Duration {
        let half = self.0 / 2;

        if half.as_nanos() == 0 {
            Duration::from_millis(1)
        } else {
            half
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TaskKind {
    Gpu,
    Cpu,
    Other(String),
}

impl TaskKind {
    pub fn to_db(&self) -> String {
        match self {
            TaskKind::Gpu => "gpu".to_string(),
            TaskKind::Cpu => "cpu".to_string(),
            TaskKind::Other(value) => value.clone(),
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "gpu" => TaskKind::Gpu,
            "cpu" => TaskKind::Cpu,
            other => TaskKind::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkerKind {
    Gpu,
    Cpu,
    Other(String),
}

impl WorkerKind {
    pub fn to_db(&self) -> String {
        match self {
            WorkerKind::Gpu => "gpu".to_string(),
            WorkerKind::Cpu => "cpu".to_string(),
            WorkerKind::Other(value) => value.clone(),
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "gpu" => WorkerKind::Gpu,
            "cpu" => WorkerKind::Cpu,
            other => WorkerKind::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Assigned,
    Running,
    Completed,
    Failed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Pending => "PENDING",
            TaskStatus::Assigned => "ASSIGNED",
            TaskStatus::Running => "RUNNING",
            TaskStatus::Completed => "COMPLETED",
            TaskStatus::Failed => "FAILED",
        }
    }

    pub fn parse(value: &str) -> QueueResult<Self> {
        match value {
            "PENDING" => Ok(TaskStatus::Pending),
            "ASSIGNED" => Ok(TaskStatus::Assigned),
            "RUNNING" => Ok(TaskStatus::Running),
            "COMPLETED" => Ok(TaskStatus::Completed),
            "FAILED" => Ok(TaskStatus::Failed),
            other => Err(QueueError::InvalidState(format!(
                "unknown task status: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkerDescriptor {
    pub worker_id: WorkerId,
    pub kind: WorkerKind,
    pub capacity: SlotCount,
    pub available_slots: SlotCount,
}

impl WorkerDescriptor {
    pub fn to_sync(&self) -> crate::sync_queue::WorkerDescriptor {
        crate::sync_queue::WorkerDescriptor {
            worker_id: self.worker_id.clone().into_string(),
            worker_type: self.kind.to_db(),
            capacity: self.capacity.value(),
            available_slots: self.available_slots.value(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnqueueCommand {
    pub name: TaskName,
    pub kind: TaskKind,
    pub payload: TaskPayload,
    pub priority: Priority,
    pub max_retries: MaxRetries,
}

#[derive(Debug, Clone)]
pub struct DispatchedTask {
    pub task_id: TaskId,
    pub task_name: TaskName,
    pub task_kind: TaskKind,
    pub priority: Priority,
    pub worker_id: WorkerId,
    pub transport_score: TransportScore,
}

impl DispatchedTask {
    pub fn from_sync(value: crate::sync_queue::DispatchedTask) -> Self {
        Self {
            task_id: TaskId::new(value.task_id),
            task_name: TaskName::new(value.task_name),
            task_kind: TaskKind::from_db(&value.task_type),
            priority: Priority::new(value.priority),
            worker_id: WorkerId::new(value.worker_id),
            transport_score: TransportScore::new(value.transport_score),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClaimedTask {
    pub id: TaskId,
    pub task_name: TaskName,
    pub task_kind: TaskKind,
    pub payload: TaskPayload,
    pub retry_count: RetryCount,
    pub max_retries: MaxRetries,
    pub lease_generation: LeaseGeneration,
}

impl ClaimedTask {
    pub fn from_fenced(value: FencedClaimedTask) -> Self {
        Self {
            id: TaskId::new(value.id),
            task_name: TaskName::new(value.task_name),
            task_kind: TaskKind::from_db(&value.task_type),
            payload: TaskPayload::new(value.payload),
            retry_count: RetryCount::new(value.retry_count),
            max_retries: MaxRetries::new(value.max_retries).unwrap_or(MaxRetries(0)),
            lease_generation: value.lease_generation,
        }
    }
}
