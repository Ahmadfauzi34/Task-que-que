use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use robust_sinkhorn_queue::runtime::{run_dispatcher_loop, spawn_worker_slots};
use robust_sinkhorn_queue::tokio_queue::AsyncRobustSinkhornQueue;
use robust_sinkhorn_queue::value::*;

#[tokio::test]
async fn test_value_types_validation() {
    assert!(MaxRetries::new(-1).is_err());
    assert_eq!(MaxRetries::new(5).unwrap().value(), 5);

    assert!(SlotCount::new(-1).is_err());
    assert_eq!(SlotCount::new(3).unwrap().value(), 3);

    assert!(Epsilon::new(0.0).is_err());
    assert!(Epsilon::new(-1.0).is_err());
    assert!(Epsilon::new(f64::NAN).is_err());
    assert_eq!(Epsilon::new(1.5).unwrap().value(), 1.5);

    assert!(LeaseDuration::new(Duration::from_nanos(0)).is_err());
    let lease = LeaseDuration::new(Duration::from_secs(10)).unwrap();
    assert_eq!(lease.heartbeat_interval(), Duration::from_secs(5));
}

#[tokio::test]
async fn test_async_queue_flow() {
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_queue_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    let task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("gpu_task"),
            kind: TaskKind::Gpu,
            payload: TaskPayload::new("payload_123"),
            priority: Priority::new(10),
            max_retries: MaxRetries::new(3).unwrap(),
        })
        .await
        .unwrap();

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("w1"),
        kind: WorkerKind::Gpu,
        capacity: SlotCount::new(2).unwrap(),
        available_slots: SlotCount::new(2).unwrap(),
    };

    let epsilon = Epsilon::new(1.5).unwrap();
    let lease = LeaseDuration::new(Duration::from_secs(10)).unwrap();

    let dispatched = queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();

    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].task_id.value(), task_id.value());

    let claimed = queue
        .claim_task(WorkerId::new("w1"))
        .await
        .unwrap()
        .expect("task should be claimed");

    assert_eq!(claimed.id.value(), task_id.value());

    let hb = queue
        .heartbeat(task_id, WorkerId::new("w1"), lease)
        .await
        .unwrap();
    assert!(hb);

    queue
        .complete_task(task_id, WorkerId::new("w1"))
        .await
        .unwrap();

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_runtime_loops() {
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_runtime_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("w-runtime"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let lease = LeaseDuration::new(Duration::from_secs(5)).unwrap();
    let epsilon = Epsilon::new(1.5).unwrap();

    queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("cpu_task"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("data"),
            priority: Priority::new(1),
            max_retries: MaxRetries::new(1).unwrap(),
        })
        .await
        .unwrap();

    let w_clone = worker.clone();
    let dispatcher_handle = tokio::spawn(run_dispatcher_loop(
        queue.clone(),
        shutdown_rx.clone(),
        Duration::from_millis(100),
        epsilon,
        lease,
        move || {
            let workers = vec![w_clone.clone()];
            async move { workers }
        },
    ));

    let processed = Arc::new(AtomicBool::new(false));
    let processed_flag = processed.clone();

    let handler = Arc::new(move |_task: ClaimedTask| {
        let flag = processed_flag.clone();
        async move {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }
    });

    let worker_handles = spawn_worker_slots(
        queue.clone(),
        worker,
        shutdown_rx.clone(),
        Duration::from_millis(50),
        lease,
        handler,
    );

    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(processed.load(Ordering::SeqCst));

    shutdown_tx.send(true).unwrap();

    dispatcher_handle.await.unwrap().unwrap();
    for handle in worker_handles {
        handle.await.unwrap().unwrap();
    }

    let _ = std::fs::remove_file(&db_path);
}
