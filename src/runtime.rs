use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};

use crate::sync_queue::QueueResult;
use crate::tokio_queue::AsyncRobustSinkhornQueue;
use crate::value::{
    ClaimedTask, Epsilon, LeaseDuration, LeaseGeneration, LeaseMutation, TaskId, WorkerDescriptor,
    WorkerId,
};

pub async fn run_with_heartbeat<Fut>(
    queue: AsyncRobustSinkhornQueue,
    task_id: TaskId,
    worker_id: WorkerId,
    lease_generation: LeaseGeneration,
    lease: LeaseDuration,
    fut: Fut,
) -> Result<(), String>
where
    Fut: Future<Output = Result<(), String>> + Send,
{
    let mut tick = interval(lease.heartbeat_interval());
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    tokio::pin!(fut);

    loop {
        tokio::select! {
            _ = tick.tick() => {
                match queue
                    .heartbeat(
                        task_id,
                        worker_id.clone(),
                        lease_generation,
                        lease,
                    )
                    .await
                {
                    Ok(LeaseMutation::Applied) => {}
                    Ok(LeaseMutation::Stale) => {
                        return Err(
                            "lease hilang, kedaluwarsa, atau generation sudah stale".into()
                        );
                    }
                    Err(e) => {
                        return Err(format!("heartbeat error: {e}"));
                    }
                }
            }

            res = &mut fut => {
                return res;
            }
        }
    }
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
    let poll_interval = if poll_interval.as_nanos() == 0 {
        Duration::from_millis(100)
    } else {
        poll_interval
    };

    loop {
        if *shutdown.borrow() {
            return Ok(());
        }

        let claimed = queue.claim_task(worker.worker_id.clone()).await?;

        match claimed {
            Some(task) => {
                let task_id = task.id;
                let lease_generation = task.lease_generation;

                let fut = (*handler)(task);

                let result = run_with_heartbeat(
                    queue.clone(),
                    task_id,
                    worker.worker_id.clone(),
                    lease_generation,
                    lease,
                    fut,
                )
                .await;

                match result {
                    Ok(()) => {
                        let transition = queue
                            .complete_task(task_id, worker.worker_id.clone(), lease_generation)
                            .await?;

                        if transition == LeaseMutation::Stale {
                            continue;
                        }
                    }
                    Err(err) => {
                        let transition = queue
                            .fail_task(task_id, worker.worker_id.clone(), lease_generation, &err)
                            .await?;

                        if transition == LeaseMutation::Stale {
                            continue;
                        }
                    }
                }
            }

            None => {
                tokio::select! {
                    _ = tokio::time::sleep(poll_interval) => {}
                    _ = shutdown.changed() => {
                        return Ok(());
                    }
                }
            }
        }
    }
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
    let poll_interval = if poll_interval.as_nanos() == 0 {
        Duration::from_millis(500)
    } else {
        poll_interval
    };

    let mut ticker = interval(poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                return Ok(());
            }

            _ = ticker.tick() => {
                if *shutdown.borrow() {
                    return Ok(());
                }

                let workers = workers_source().await;

                queue.recover_expired_leases().await?;
                queue.dispatch_batch(workers, epsilon, lease).await?;
            }
        }
    }
}
