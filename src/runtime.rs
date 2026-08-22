use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, info, info_span, warn, Instrument};

use crate::sync_queue::{QueueError, QueueResult};
use crate::tokio_queue::AsyncRobustSinkhornQueue;
use crate::value::{ClaimedTask, Epsilon, LeaseDuration, TaskId, WorkerDescriptor, WorkerId};

pub async fn run_with_heartbeat<Fut>(
    queue: AsyncRobustSinkhornQueue,
    task_id: TaskId,
    worker_id: WorkerId,
    lease: LeaseDuration,
    fut: Fut,
) -> Result<(), String>
where
    Fut: Future<Output = Result<(), String>> + Send,
{
    let exec_span = info_span!(
        "queue.task.execution",
        task.id = task_id.value(),
        worker.id = %worker_id.as_str()
    );

    async move {
        let mut tick = interval(lease.heartbeat_interval());
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let mut heartbeat_count: u64 = 0;
        tokio::pin!(fut);

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    heartbeat_count += 1;
                    let hb_span = info_span!(
                        "queue.heartbeat",
                        heartbeat.count = heartbeat_count,
                        task.id = task_id.value()
                    );

                    let result = queue
                        .heartbeat(task_id, worker_id.clone(), lease)
                        .instrument(hb_span)
                        .await;

                    match result {
                        Ok(true) => {
                            debug!("heartbeat succeeded");
                        }
                        Ok(false) => {
                            warn!("lease lost during heartbeat");
                            return Err("lease hilang atau task tidak lagi RUNNING".into());
                        }
                        Err(e) => {
                            warn!(error = %e, "heartbeat failed");
                            return Err(format!("heartbeat error: {e}"));
                        }
                    }
                }

                res = &mut fut => {
                    info!(heartbeat.count = heartbeat_count, "task execution finished");
                    return res;
                }
            }
        }
    }
    .instrument(exec_span)
    .await
}

pub async fn run_worker_loop<F, Fut>(
    queue: AsyncRobustSinkhornQueue,
    worker: WorkerDescriptor,
    mut shutdown: watch::Receiver<bool>,
    poll_interval: Duration,
    lease: LeaseDuration,
    handler: Arc<F>,
) -> QueueResult<()>
where
    F: Fn(ClaimedTask) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    let loop_span = info_span!(
        "queue.worker.loop",
        worker.id = %worker.worker_id.as_str(),
        worker.kind = ?worker.kind,
        slots = worker.available_slots.value()
    );

    async move {
        let poll_interval = if poll_interval.as_nanos() == 0 {
            Duration::from_millis(100)
        } else {
            poll_interval
        };

        let mut iteration: u64 = 0;

        loop {
            if *shutdown.borrow() {
                info!(iterations = iteration, "worker loop shutting down");
                return Ok(());
            }

            iteration += 1;
            let iter_span = info_span!("queue.worker.iteration", iteration = iteration);

            async {
                let claimed = queue.claim_task(worker.worker_id.clone()).await?;

                match claimed {
                    Some(task) => {
                        let task_id = task.id;
                        let retry_count = task.retry_count;
                        let max_retries = task.max_retries;
                        let trace_id = task.trace_id.clone();

                        info!(
                            task.id = task_id.value(),
                            task.name = %task.task_name.as_str(),
                            trace.id = %trace_id.as_str(),
                            retry.count = retry_count.value(),
                            "task claimed, starting execution"
                        );

                        let fut = (*handler)(task);

                        let result = run_with_heartbeat(
                            queue.clone(),
                            task_id,
                            worker.worker_id.clone(),
                            lease,
                            fut,
                        )
                        .await;

                        match result {
                            Ok(()) => {
                                info!(task.id = task_id.value(), "task completed successfully");
                                queue
                                    .complete_task(task_id, worker.worker_id.clone())
                                    .await?;
                            }
                            Err(err) => {
                                warn!(
                                    task.id = task_id.value(),
                                    error = %err,
                                    "task failed, marking for retry/fail"
                                );
                                queue
                                    .fail_task(
                                        task_id,
                                        worker.worker_id.clone(),
                                        &err,
                                        retry_count,
                                        max_retries,
                                    )
                                    .await?;
                            }
                        }
                    }
                    None => {
                        debug!("no task available, polling later");
                        tokio::select! {
                            _ = tokio::time::sleep(poll_interval) => {}
                            _ = shutdown.changed() => {
                                info!("shutdown signal received");
                                return Ok(());
                            }
                        }
                    }
                }

                Ok::<_, QueueError>(())
            }
            .instrument(iter_span)
            .await?;
        }
    }
    .instrument(loop_span)
    .await
}

pub fn spawn_worker_slots<F, Fut>(
    queue: AsyncRobustSinkhornQueue,
    worker: WorkerDescriptor,
    shutdown: watch::Receiver<bool>,
    poll_interval: Duration,
    lease: LeaseDuration,
    handler: Arc<F>,
) -> Vec<tokio::task::JoinHandle<QueueResult<()>>>
where
    F: Fn(ClaimedTask) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    let slots = worker.available_slots.value().max(1) as usize;

    (0..slots)
        .map(|_| {
            let q = queue.clone();
            let w = worker.clone();
            let rx = shutdown.clone();
            let h = handler.clone();

            tokio::spawn(async move { run_worker_loop(q, w, rx, poll_interval, lease, h).await })
        })
        .collect()
}

pub async fn run_dispatcher_loop<W, Fut>(
    queue: AsyncRobustSinkhornQueue,
    mut shutdown: watch::Receiver<bool>,
    poll_interval: Duration,
    epsilon: Epsilon,
    lease: LeaseDuration,
    workers_source: W,
) -> QueueResult<()>
where
    W: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Vec<WorkerDescriptor>> + Send + 'static,
{
    let loop_span = info_span!(
        "queue.dispatcher.loop",
        poll_interval_ms = poll_interval.as_millis(),
        epsilon = epsilon.value(),
        lease_sec = lease.as_secs_f64()
    );

    async move {
        let poll_interval = if poll_interval.as_nanos() == 0 {
            Duration::from_millis(500)
        } else {
            poll_interval
        };

        let mut ticker = interval(poll_interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let mut iteration: u64 = 0;

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    info!(iterations = iteration, "dispatcher shutting down");
                    return Ok(());
                }

                _ = ticker.tick() => {
                    if *shutdown.borrow() {
                        return Ok(());
                    }

                    iteration += 1;
                    let iter_span = info_span!("queue.dispatcher.iteration", iteration = iteration);

                    async {
                        let workers = workers_source().await;

                        let recovered = queue.recover_expired_leases().await?;
                        if recovered > 0 {
                            info!(recovered.count = recovered, "recovered expired leases");
                        }

                        let dispatched = queue.dispatch_batch(workers, epsilon, lease).await?;
                        info!(dispatched.count = dispatched.len(), "dispatch cycle completed");

                        Ok::<_, QueueError>(())
                    }
                    .instrument(iter_span)
                    .await?;
                }
            }
        }
    }
    .instrument(loop_span)
    .await
}
