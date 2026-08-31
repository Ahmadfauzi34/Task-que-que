use std::path::PathBuf;
use std::sync::Arc;

use tracing::{info, info_span, instrument, Instrument, Span};

use crate::sync_queue::{self, RobustSinkhornQueue};
use crate::value::{
    ClaimedTask, DispatchedTask, EnqueueCommand, Epsilon, LeaseDuration, MaxRetries, RetryCount,
    TaskId, TraceId, WorkerDescriptor, WorkerId,
};

#[derive(Clone)]
pub struct AsyncRobustSinkhornQueue {
    inner: Arc<RobustSinkhornQueue>,
}

impl AsyncRobustSinkhornQueue {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            inner: Arc::new(RobustSinkhornQueue::new(db_path)),
        }
    }

    pub fn from_sync(queue: RobustSinkhornQueue) -> Self {
        Self {
            inner: Arc::new(queue),
        }
    }

    async fn blocking<F, T>(&self, op: F) -> sync_queue::QueueResult<T>
    where
        F: FnOnce(Arc<RobustSinkhornQueue>) -> sync_queue::QueueResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let inner = self.inner.clone();
        let parent_span = Span::current();

        tokio::task::spawn_blocking(move || {
            let _entered = parent_span.enter();
            op(inner)
        })
        .instrument(info_span!("queue.async.spawn_blocking"))
        .await
        .map_err(|e| {
            sync_queue::QueueError::InvalidState(format!("spawn_blocking join error: {e}"))
        })?
    }

    pub async fn ensure_schema(&self) -> sync_queue::QueueResult<()> {
        self.blocking(|q| q.ensure_schema()).await
    }

    #[instrument(
        name = "queue.async.enqueue",
        skip(self, cmd),
        fields(
            task.name = %cmd.name.as_str(),
            task.kind = ?cmd.kind,
            task.priority = cmd.priority.value(),
            task.trace_id = cmd.trace_id.as_ref().map(|t| t.as_str()).unwrap_or("auto")
        )
    )]
    pub async fn enqueue(&self, cmd: EnqueueCommand) -> sync_queue::QueueResult<TaskId> {
        let trace_id = cmd.trace_id.unwrap_or_else(TraceId::generate);
        let name = cmd.name.into_string();
        let kind = cmd.kind.to_db();
        let payload = cmd.payload.into_string();
        let priority = cmd.priority.value();
        let max_retries = cmd.max_retries.value();
        let trace_id_str = trace_id.into_string();

        let task_id = self
            .blocking(move |q| {
                q.enqueue(&name, &kind, &payload, priority, max_retries, &trace_id_str)
                    .map(TaskId::new)
            })
            .await?;

        info!(task.id = task_id.value(), "enqueue completed");
        Ok(task_id)
    }

    #[instrument(name = "queue.async.recover_expired_leases", skip(self))]
    pub async fn recover_expired_leases(&self) -> sync_queue::QueueResult<usize> {
        self.blocking(|q| q.recover_expired_leases()).await
    }

    #[instrument(
        name = "queue.async.dispatch_batch",
        skip(self, workers),
        fields(
            worker.count = workers.len(),
            epsilon = epsilon.value(),
            lease_sec = lease.as_secs_f64()
        )
    )]
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

        let dispatched: Vec<DispatchedTask> =
            raw.into_iter().map(DispatchedTask::from_sync).collect();

        info!(
            dispatched.count = dispatched.len(),
            "dispatch batch completed"
        );
        Ok(dispatched)
    }

    #[instrument(name = "queue.async.claim_task", skip(self), fields(worker.id = %worker_id.as_str()))]
    pub async fn claim_task(
        &self,
        worker_id: WorkerId,
    ) -> sync_queue::QueueResult<Option<ClaimedTask>> {
        let worker = worker_id.into_string();

        let raw = self.blocking(move |q| q.claim_task(&worker)).await?;

        Ok(raw.map(ClaimedTask::from_sync))
    }

    #[instrument(name = "queue.async.heartbeat", skip(self), fields(task.id = task_id.value(), worker.id = %worker_id.as_str()))]
    pub async fn heartbeat(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        lease: LeaseDuration,
    ) -> sync_queue::QueueResult<bool> {
        let worker = worker_id.into_string();
        let lease_sec = lease.as_secs_f64();

        self.blocking(move |q| q.heartbeat(task_id.value(), &worker, lease_sec))
            .await
    }

    #[instrument(name = "queue.async.complete_task", skip(self), fields(task.id = task_id.value(), worker.id = %worker_id.as_str()))]
    pub async fn complete_task(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
    ) -> sync_queue::QueueResult<()> {
        let worker = worker_id.into_string();

        self.blocking(move |q| q.complete_task(task_id.value(), &worker))
            .await
    }

    #[instrument(name = "queue.async.fail_task", skip(self), fields(task.id = task_id.value(), worker.id = %worker_id.as_str(), error = %error_msg))]
    pub async fn fail_task(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        error_msg: &str,
        retry_count: RetryCount,
        max_retries: MaxRetries,
    ) -> sync_queue::QueueResult<()> {
        let worker = worker_id.into_string();
        let error = error_msg.to_owned();

        self.blocking(move |q| {
            q.fail_task(
                task_id.value(),
                &worker,
                &error,
                retry_count.value(),
                max_retries.value(),
            )
        })
        .await
    }
}
