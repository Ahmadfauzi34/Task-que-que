use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use robust_sinkhorn_queue::runtime::{
    run_dispatcher_loop, run_with_heartbeat, spawn_worker_slots,
};
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

    // Test TaskStatus parsing
    assert_eq!(TaskStatus::parse("PENDING").unwrap(), TaskStatus::Pending);
    assert_eq!(TaskStatus::parse("ASSIGNED").unwrap(), TaskStatus::Assigned);
    assert_eq!(TaskStatus::parse("RUNNING").unwrap(), TaskStatus::Running);
    assert_eq!(TaskStatus::parse("COMPLETED").unwrap(), TaskStatus::Completed);
    assert_eq!(TaskStatus::parse("FAILED").unwrap(), TaskStatus::Failed);
    assert!(TaskStatus::parse("UNKNOWN").is_err());
    assert_eq!(TaskStatus::Pending.as_str(), "PENDING");

    // Test TaskKind & WorkerKind conversion
    assert_eq!(TaskKind::Gpu.to_db(), "gpu");
    assert_eq!(TaskKind::Cpu.to_db(), "cpu");
    assert_eq!(TaskKind::Other("tpu".into()).to_db(), "tpu");
    assert_eq!(TaskKind::from_db("gpu"), TaskKind::Gpu);
    assert_eq!(TaskKind::from_db("cpu"), TaskKind::Cpu);
    assert_eq!(TaskKind::from_db("tpu"), TaskKind::Other("tpu".into()));

    assert_eq!(WorkerKind::Gpu.to_db(), "gpu");
    assert_eq!(WorkerKind::Cpu.to_db(), "cpu");
    assert_eq!(WorkerKind::Other("tpu".into()).to_db(), "tpu");
    assert_eq!(WorkerKind::from_db("gpu"), WorkerKind::Gpu);
    assert_eq!(WorkerKind::from_db("cpu"), WorkerKind::Cpu);
    assert_eq!(WorkerKind::from_db("tpu"), WorkerKind::Other("tpu".into()));

    // Test TransportScore clamping
    assert_eq!(TransportScore::new(0.85).value(), 0.85);
    assert_eq!(TransportScore::new(1.5).value(), 1.0);
    assert_eq!(TransportScore::new(-0.5).value(), 0.0);
    assert_eq!(TransportScore::new(f64::NAN).value(), 0.0);
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
async fn test_lease_expiration_and_recovery() {
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_recovery_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    let task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("expiring_task"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("temp"),
            priority: Priority::new(5),
            max_retries: MaxRetries::new(3).unwrap(),
        })
        .await
        .unwrap();

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("w-expiring"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    // Dispatch with a micro lease duration of 1ms
    let lease = LeaseDuration::new(Duration::from_millis(1)).unwrap();
    let epsilon = Epsilon::new(1.5).unwrap();

    let dispatched = queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();

    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].task_id.value(), task_id.value());

    // Sleep past the lease duration
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Recover expired leases
    let recovered = queue.recover_expired_leases().await.unwrap();
    assert_eq!(recovered, 1);

    // After recovery, task should be back in PENDING status, claimable by next dispatch
    let lease2 = LeaseDuration::new(Duration::from_secs(60)).unwrap();
    let dispatched_again = queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease2)
        .await
        .unwrap();
    assert_eq!(dispatched_again.len(), 1);
    assert_eq!(dispatched_again[0].task_id.value(), task_id.value());

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_task_fail_and_retry_backoff() {
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_retry_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    let _task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("failing_task"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("fail_payload"),
            priority: Priority::new(5),
            max_retries: MaxRetries::new(2).unwrap(),
        })
        .await
        .unwrap();

    let worker_id = WorkerId::new("w-fail");
    let worker = WorkerDescriptor {
        worker_id: worker_id.clone(),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let lease = LeaseDuration::new(Duration::from_secs(10)).unwrap();
    let epsilon = Epsilon::new(1.5).unwrap();

    // First dispatch and claim
    queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();
    let claimed = queue.claim_task(worker_id.clone()).await.unwrap().unwrap();

    // Fail attempt 1 (retry_count = 0, max_retries = 2)
    queue
        .fail_task(
            claimed.id,
            worker_id.clone(),
            "Error on attempt 1",
            claimed.retry_count,
            claimed.max_retries,
        )
        .await
        .unwrap();

    // After failure 1, retry_count becomes 1 (< max_retries 2). Task is rescheduled with backoff.
    // Claiming immediately should return None because it's scheduled in the future
    let claimed_immediate = queue.claim_task(worker_id.clone()).await.unwrap();
    assert!(claimed_immediate.is_none());

    // Fail attempt 2 (retry_count = 1, max_retries = 2) -> Should reach FAILED state
    queue
        .fail_task(
            claimed.id,
            worker_id.clone(),
            "Error on attempt 2",
            RetryCount::new(1),
            MaxRetries::new(2).unwrap(),
        )
        .await
        .unwrap();

    // Verify task is now FAILED and cannot be claimed even after dispatch
    let dispatched_after_fail = queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();
    assert!(dispatched_after_fail.is_empty());

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_sinkhorn_affinity_dispatch() {
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_sinkhorn_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    // Enqueue 1 GPU task and 1 CPU task
    let gpu_task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("gpu_work"),
            kind: TaskKind::Gpu,
            payload: TaskPayload::new("{}"),
            priority: Priority::new(10),
            max_retries: MaxRetries::new(3).unwrap(),
        })
        .await
        .unwrap();

    let cpu_task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("cpu_work"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("{}"),
            priority: Priority::new(10),
            max_retries: MaxRetries::new(3).unwrap(),
        })
        .await
        .unwrap();

    // Workers: 1 GPU worker (1 slot), 1 CPU worker (1 slot)
    let gpu_worker = WorkerDescriptor {
        worker_id: WorkerId::new("gpu-node-1"),
        kind: WorkerKind::Gpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };
    let cpu_worker = WorkerDescriptor {
        worker_id: WorkerId::new("cpu-node-1"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let lease = LeaseDuration::new(Duration::from_secs(30)).unwrap();
    let epsilon = Epsilon::new(1.0).unwrap();

    let dispatched = queue
        .dispatch_batch(vec![gpu_worker.clone(), cpu_worker.clone()], epsilon, lease)
        .await
        .unwrap();

    assert_eq!(dispatched.len(), 2);

    let gpu_dispatch = dispatched
        .iter()
        .find(|d| d.task_id.value() == gpu_task_id.value())
        .expect("gpu task must be dispatched");
    let cpu_dispatch = dispatched
        .iter()
        .find(|d| d.task_id.value() == cpu_task_id.value())
        .expect("cpu task must be dispatched");

    assert_eq!(gpu_dispatch.worker_id.as_str(), "gpu-node-1");
    assert_eq!(cpu_dispatch.worker_id.as_str(), "cpu-node-1");

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_run_with_heartbeat_cancellation_and_failure() {
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_heartbeat_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    let task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("hb_task"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("{}"),
            priority: Priority::new(1),
            max_retries: MaxRetries::new(1).unwrap(),
        })
        .await
        .unwrap();

    let worker_id = WorkerId::new("w-hb");
    let worker = WorkerDescriptor {
        worker_id: worker_id.clone(),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let lease = LeaseDuration::new(Duration::from_millis(100)).unwrap();
    let epsilon = Epsilon::new(1.5).unwrap();

    queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();

    // Claim task to put it into RUNNING state
    queue.claim_task(worker_id.clone()).await.unwrap().unwrap();

    // Test successful task completed faster than heartbeat interval
    let task_fut = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        Ok(())
    };
    let res = run_with_heartbeat(
        queue.clone(),
        task_id,
        worker_id.clone(),
        lease,
        task_fut,
    )
    .await;

    assert!(res.is_ok());

    // Test heartbeat failure when task is marked COMPLETED (no longer RUNNING in DB)
    queue.complete_task(task_id, worker_id.clone()).await.unwrap();

    let slow_task_fut = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        Ok(())
    };

    let hb_err = run_with_heartbeat(
        queue.clone(),
        task_id,
        worker_id.clone(),
        lease,
        slow_task_fut,
    )
    .await;

    assert!(hb_err.is_err());
    assert!(hb_err.unwrap_err().contains("lease hilang"));

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
