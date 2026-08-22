use std::sync::Arc;
use std::time::Duration;

use robust_sinkhorn_queue::runtime::{run_dispatcher_loop, spawn_worker_slots};
use robust_sinkhorn_queue::tokio_queue::AsyncRobustSinkhornQueue;
use robust_sinkhorn_queue::value::{
    ClaimedTask, EnqueueCommand, Epsilon, LeaseDuration, MaxRetries, Priority, SlotCount,
    TaskKind, TaskName, TaskPayload, WorkerDescriptor, WorkerId, WorkerKind,
};
use robust_sinkhorn_queue::QueueResult;

#[tokio::main]
async fn main() -> QueueResult<()> {
    let queue = AsyncRobustSinkhornQueue::new("queue.db");
    queue.ensure_schema().await?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("gpu-01"),
        kind: WorkerKind::Gpu,
        capacity: SlotCount::new(4)?,
        available_slots: SlotCount::new(2)?,
    };

    let lease = LeaseDuration::new(Duration::from_secs(30))?;
    let epsilon = Epsilon::new(1.5)?;

    queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("train-model"),
            kind: TaskKind::Gpu,
            payload: TaskPayload::new(r#"{"batch_size": 32}"#),
            priority: Priority::new(10),
            max_retries: MaxRetries::new(3)?,
        })
        .await?;

    let dispatcher_workers = vec![worker.clone()];

    let dispatcher = tokio::spawn(run_dispatcher_loop(
        queue.clone(),
        shutdown_rx.clone(),
        Duration::from_secs(2),
        epsilon,
        lease,
        move || {
            let workers = dispatcher_workers.clone();
            async move { workers }
        },
    ));

    let handler = Arc::new(|task: ClaimedTask| async move {
        println!("processing task: {:?}", task.id);

        // Simulasi kerja async.
        tokio::time::sleep(Duration::from_secs(2)).await;

        Ok(())
    });

    let worker_handles = spawn_worker_slots(
        queue.clone(),
        worker,
        shutdown_rx.clone(),
        Duration::from_millis(500),
        lease,
        handler,
    );

    // Tunggu Ctrl+C.
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = tokio::time::sleep(Duration::from_millis(500)) => {
            // For main run in automated non-interactive environments, exit gracefully quickly
        }
    }

    println!("shutdown dimulai...");
    let _ = shutdown_tx.send(true);

    dispatcher.await.unwrap()?;

    for handle in worker_handles {
        handle.await.unwrap()?;
    }

    println!("shutdown selesai");

    Ok(())
}
