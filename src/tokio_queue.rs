use std::path::PathBuf;
use std::sync::Arc;

use crate::cancellation::{CancellationOutcome, CancellationStore};
use crate::idempotency::IdempotencyStore;
use crate::lease_fence::LeaseFence;
use crate::result_projection::TaskResultStore;
use crate::sync_queue::{self, RobustSinkhornQueue};
use crate::value::{
    ClaimedTask, DispatchedTask, EnqueueCommand, Epsilon, LeaseDuration, LeaseGeneration,
    LeaseMutation, TaskId, WorkerDescriptor, WorkerId,
};

#[derive(Clone)]
pub struct AsyncRobustSinkhornQueue {
    inner: Arc<RobustSinkhornQueue>,
    lease_fence: Arc<LeaseFence>,
    cancellation: Arc<CancellationStore>,
    idempotency: Arc<IdempotencyStore>,
    result_projection: Arc<TaskResultStore>,
}

impl AsyncRobustSinkhornQueue {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        let db_path = db_path.into();

        Self {
            inner: Arc::new(RobustSinkhornQueue::new(db_path.clone())),
            lease_fence: Arc::new(LeaseFence::new(db_path.clone())),
            cancellation: Arc::new(CancellationStore::new(db_path.clone())),
            idempotency: Arc::new(IdempotencyStore::new(db_path.clone())),
            result_projection: Arc::new(TaskResultStore::new(db_path)),
        }
    }

    pub fn from_sync(queue: RobustSinkhornQueue, db_path: impl Into<PathBuf>) -> Self {
        let db_path = db_path.into();

        Self {
            inner: Arc::new(queue),
            lease_fence: Arc::new(LeaseFence::new(db_path.clone())),
            cancellation: Arc::new(CancellationStore::new(db_path.clone())),
            idempotency: Arc::new(IdempotencyStore::new(db_path.clone())),
            result_projection: Arc::new(TaskResultStore::new(db_path)),
        }
    }

    async fn blocking<F, T>(&self, op: F) -> sync_queue::QueueResult<T>
    where
        F: FnOnce(Arc<RobustSinkhornQueue>) -> sync_queue::QueueResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let inner = self.inner.clone();

        tokio::task::spawn_blocking(move || op(inner))
            .await
            .map_err(|e| {
                sync_queue::QueueError::InvalidState(format!("spawn_blocking join error: {e}"))
            })?
    }

    async fn blocking_fence<F, T>(&self, op: F) -> sync_queue::QueueResult<T>
    where
        F: FnOnce(Arc<LeaseFence>) -> sync_queue::QueueResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let lease_fence = self.lease_fence.clone();

        tokio::task::spawn_blocking(move || op(lease_fence))
            .await
            .map_err(|error| {
                sync_queue::QueueError::InvalidState(format!("spawn_blocking join error: {error}"))
            })?
    }

    async fn blocking_cancellation<F, T>(&self, op: F) -> sync_queue::QueueResult<T>
    where
        F: FnOnce(Arc<CancellationStore>) -> sync_queue::QueueResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let cancellation = self.cancellation.clone();

        tokio::task::spawn_blocking(move || op(cancellation))
            .await
            .map_err(|error| {
                sync_queue::QueueError::InvalidState(format!("spawn_blocking join error: {error}"))
            })?
    }

    async fn blocking_idempotency<F, T>(&self, op: F) -> sync_queue::QueueResult<T>
    where
        F: FnOnce(Arc<IdempotencyStore>) -> sync_queue::QueueResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let idempotency = self.idempotency.clone();

        tokio::task::spawn_blocking(move || op(idempotency))
            .await
            .map_err(|error| {
                sync_queue::QueueError::InvalidState(format!("spawn_blocking join error: {error}"))
            })?
    }

    async fn blocking_result<F, T>(&self, op: F) -> sync_queue::QueueResult<T>
    where
        F: FnOnce(Arc<TaskResultStore>) -> sync_queue::QueueResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let result_projection = self.result_projection.clone();

        tokio::task::spawn_blocking(move || op(result_projection))
            .await
            .map_err(|error| {
                sync_queue::QueueError::InvalidState(format!("spawn_blocking join error: {error}"))
            })?
    }

    pub async fn ensure_schema(&self) -> sync_queue::QueueResult<()> {
        self.blocking(|q| q.ensure_schema()).await?;
        self.blocking_fence(|fence| fence.ensure_schema()).await?;
        self.blocking_idempotency(|store| store.ensure_schema())
            .await?;
        self.blocking_result(|store| store.ensure_schema()).await
    }

    pub async fn enqueue(&self, cmd: EnqueueCommand) -> sync_queue::QueueResult<TaskId> {
        let name = cmd.name.into_string();
        let kind = cmd.kind.to_db();
        let payload = cmd.payload.into_string();
        let priority = cmd.priority.value();
        let max_retries = cmd.max_retries.value();

        self.blocking(move |q| {
            q.enqueue(&name, &kind, &payload, priority, max_retries)
                .map(TaskId::new)
        })
        .await
    }

    pub async fn cancel_task(
        &self,
        task_id: TaskId,
    ) -> sync_queue::QueueResult<CancellationOutcome> {
        self.blocking_cancellation(move |store| store.cancel_task(task_id.value()))
            .await
    }

    pub async fn recover_expired_leases(&self) -> sync_queue::QueueResult<usize> {
        self.blocking(|q| q.recover_expired_leases()).await
    }

    pub async fn dispatch_batch(
        &self,
        workers: Vec<WorkerDescriptor>,
        epsilon: Epsilon,
        lease: LeaseDuration,
    ) -> sync_queue::QueueResult<Vec<DispatchedTask>> {
        let sync_workers: Vec<sync_queue::WorkerDescriptor> =
            workers.into_iter().map(|w| w.to_sync()).collect();

        let eps = epsilon.value();
        let lease_sec = lease.as_secs_f64();

        let raw = self
            .blocking(move |q| q.dispatch_batch(&sync_workers, eps, lease_sec))
            .await?;

        Ok(raw.into_iter().map(DispatchedTask::from_sync).collect())
    }

    pub async fn claim_task(
        &self,
        worker_id: WorkerId,
    ) -> sync_queue::QueueResult<Option<ClaimedTask>> {
        let worker = worker_id.into_string();

        let raw = self
            .blocking_fence(move |fence| fence.claim_task(&worker))
            .await?;

        Ok(raw.map(ClaimedTask::from_fenced))
    }

    pub async fn heartbeat(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        generation: LeaseGeneration,
        lease: LeaseDuration,
    ) -> sync_queue::QueueResult<LeaseMutation> {
        let worker = worker_id.into_string();
        let lease_sec = lease.as_secs_f64();

        self.blocking_fence(move |fence| {
            fence.heartbeat(task_id.value(), &worker, generation, lease_sec)
        })
        .await
    }

    pub async fn complete_task(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        generation: LeaseGeneration,
    ) -> sync_queue::QueueResult<LeaseMutation> {
        let worker = worker_id.into_string();

        self.blocking_fence(move |fence| fence.complete_task(task_id.value(), &worker, generation))
            .await
    }

    pub async fn complete_task_with_projection(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        generation: LeaseGeneration,
        result_json: String,
    ) -> sync_queue::QueueResult<LeaseMutation> {
        let worker = worker_id.into_string();

        self.blocking_result(move |store| {
            store.complete_with_projection(task_id.value(), &worker, generation, &result_json)
        })
        .await
    }

    pub async fn fail_task(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        generation: LeaseGeneration,
        error_msg: &str,
    ) -> sync_queue::QueueResult<LeaseMutation> {
        let worker = worker_id.into_string();
        let error = error_msg.to_owned();

        self.blocking_fence(move |fence| {
            fence.fail_task(task_id.value(), &worker, generation, &error)
        })
        .await
    }
}
