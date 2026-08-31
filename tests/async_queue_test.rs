use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use robust_sinkhorn_queue::runtime::{run_dispatcher_loop, run_with_heartbeat, spawn_worker_slots};
use robust_sinkhorn_queue::tokio_queue::AsyncRobustSinkhornQueue;
use robust_sinkhorn_queue::value::*;
use robust_sinkhorn_queue::RobustSinkhornQueue;

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

    assert_eq!(LeaseGeneration::new(7).value(), 7);
    assert!(LeaseMutation::Applied.is_applied());
    assert!(!LeaseMutation::Stale.is_applied());

    assert_eq!(TaskStatus::parse("PENDING").unwrap(), TaskStatus::Pending);
    assert_eq!(TaskStatus::parse("ASSIGNED").unwrap(), TaskStatus::Assigned);
    assert_eq!(TaskStatus::parse("RUNNING").unwrap(), TaskStatus::Running);
    assert_eq!(
        TaskStatus::parse("COMPLETED").unwrap(),
        TaskStatus::Completed
    );
    assert_eq!(TaskStatus::parse("FAILED").unwrap(), TaskStatus::Failed);
    assert!(TaskStatus::parse("UNKNOWN").is_err());
    assert_eq!(TaskStatus::Pending.as_str(), "PENDING");

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

    assert_eq!(TransportScore::new(0.85).value(), 0.85);
    assert_eq!(TransportScore::new(1.5).value(), 1.0);
    assert_eq!(TransportScore::new(-0.5).value(), 0.0);
    assert_eq!(TransportScore::new(f64::NAN).value(), 0.0);
}

#[tokio::test]
async fn test_fence_schema_upgrades_existing_queue_database() {
    let db_path = std::env::temp_dir().join(format!(
        "test_existing_queue_{}.db",
        rand::random::<u64>()
    ));

    let legacy_queue = RobustSinkhornQueue::new(&db_path);
    legacy_queue.ensure_schema().unwrap();
    let legacy_task_id = legacy_queue
        .enqueue("legacy_task", "cpu", "{}", 5, 3)
        .unwrap();

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("legacy-worker"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let dispatched = queue
        .dispatch_batch(
            vec![worker.clone()],
            Epsilon::new(1.5).unwrap(),
            LeaseDuration::new(Duration::from_secs(10)).unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].task_id.value(), legacy_task_id);

    let claimed = queue
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.lease_generation.value(), 1);

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_async_queue_flow() {
    let db_path = std::env::temp_dir().join(format!("test_queue_{}.db", rand::random::<u64>()));

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
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .expect("task should be claimed");

    assert_eq!(claimed.id.value(), task_id.value());
    assert_eq!(claimed.lease_generation.value(), 1);

    let heartbeat = queue
        .heartbeat(
            task_id,
            worker.worker_id.clone(),
            claimed.lease_generation,
            lease,
        )
        .await
        .unwrap();
    assert_eq!(heartbeat, LeaseMutation::Applied);

    let completed = queue
        .complete_task(
            task_id,
            worker.worker_id.clone(),
            claimed.lease_generation,
        )
        .await
        .unwrap();
    assert_eq!(completed, LeaseMutation::Applied);

    let replay = queue
        .complete_task(task_id, worker.worker_id, claimed.lease_generation)
        .await
        .unwrap();
    assert_eq!(replay, LeaseMutation::Stale);

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_expired_lease_reassignment_rejects_same_worker_aba() {
    let db_path = std::env::temp_dir().join(format!(
        "test_recovery_fence_{}.db",
        rand::random::<u64>()
    ));

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
        worker_id: WorkerId::new("same-worker"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let short_lease = LeaseDuration::new(Duration::from_millis(100)).unwrap();
    let epsilon = Epsilon::new(1.5).unwrap();

    queue
        .dispatch_batch(vec![worker.clone()], epsilon, short_lease)
        .await
        .unwrap();
    let first = queue
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .unwrap();

    tokio::time::sleep(Duration::from_millis(150)).await;

    let late_heartbeat = queue
        .heartbeat(
            task_id,
            worker.worker_id.clone(),
            first.lease_generation,
            short_lease,
        )
        .await
        .unwrap();
    assert_eq!(late_heartbeat, LeaseMutation::Stale);

    let recovered = queue.recover_expired_leases().await.unwrap();
    assert_eq!(recovered, 1);

    let long_lease = LeaseDuration::new(Duration::from_secs(10)).unwrap();
    queue
        .dispatch_batch(vec![worker.clone()], epsilon, long_lease)
        .await
        .unwrap();
    let second = queue
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .unwrap();

    assert!(second.lease_generation.value() > first.lease_generation.value());

    let stale_complete = queue
        .complete_task(
            task_id,
            worker.worker_id.clone(),
            first.lease_generation,
        )
        .await
        .unwrap();
    assert_eq!(stale_complete, LeaseMutation::Stale);

    let current_complete = queue
        .complete_task(task_id, worker.worker_id, second.lease_generation)
        .await
        .unwrap();
    assert_eq!(current_complete, LeaseMutation::Applied);

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_task_fail_retry_backoff_rejects_stale_replay() {
    let db_path = std::env::temp_dir().join(format!("test_retry_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("failing_task"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("fail_payload"),
            priority: Priority::new(5),
            max_retries: MaxRetries::new(2).unwrap(),
        })
        .await
        .unwrap();

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("w-fail"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };

    let lease = LeaseDuration::new(Duration::from_secs(10)).unwrap();
    let epsilon = Epsilon::new(1.5).unwrap();

    queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();
    let claimed = queue
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .unwrap();

    let first_failure = queue
        .fail_task(
            claimed.id,
            worker.worker_id.clone(),
            claimed.lease_generation,
            "Error on attempt 1",
        )
        .await
        .unwrap();
    assert_eq!(first_failure, LeaseMutation::Applied);

    let stale_replay = queue
        .fail_task(
            claimed.id,
            worker.worker_id.clone(),
            claimed.lease_generation,
            "stale replay",
        )
        .await
        .unwrap();
    assert_eq!(stale_replay, LeaseMutation::Stale);

    let claimed_immediate = queue.claim_task(worker.worker_id.clone()).await.unwrap();
    assert!(claimed_immediate.is_none());

    let dispatched_during_backoff = queue
        .dispatch_batch(vec![worker], epsilon, lease)
        .await
        .unwrap();
    assert!(dispatched_during_backoff.is_empty());

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_terminal_failure_uses_database_retry_state() {
    let db_path = std::env::temp_dir().join(format!(
        "test_terminal_failure_{}.db",
        rand::random::<u64>()
    ));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

    queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("terminal_failure"),
            kind: TaskKind::Cpu,
            payload: TaskPayload::new("{}"),
            priority: Priority::new(1),
            max_retries: MaxRetries::new(1).unwrap(),
        })
        .await
        .unwrap();

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("w-terminal"),
        kind: WorkerKind::Cpu,
        capacity: SlotCount::new(1).unwrap(),
        available_slots: SlotCount::new(1).unwrap(),
    };
    let epsilon = Epsilon::new(1.5).unwrap();
    let lease = LeaseDuration::new(Duration::from_secs(10)).unwrap();

    queue
        .dispatch_batch(vec![worker.clone()], epsilon, lease)
        .await
        .unwrap();
    let claimed = queue
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(claimed.retry_count.value(), 0);
    assert_eq!(claimed.max_retries.value(), 1);

    let failed = queue
        .fail_task(
            claimed.id,
            worker.worker_id.clone(),
            claimed.lease_generation,
            "terminal",
        )
        .await
        .unwrap();
    assert_eq!(failed, LeaseMutation::Applied);

    let dispatched_after_fail = queue
        .dispatch_batch(vec![worker], epsilon, lease)
        .await
        .unwrap();
    assert!(dispatched_after_fail.is_empty());

    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn test_sinkhorn_affinity_dispatch() {
    let db_path = std::env::temp_dir().join(format!("test_sinkhorn_{}.db", rand::random::<u64>()));

    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await.unwrap();

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
        .dispatch_batch(vec![gpu_worker, cpu_worker], epsilon, lease)
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
    let db_path = std::env::temp_dir().join(format!("test_heartbeat_{}.db", rand::random::<u64>()));

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

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("w-hb"),
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

    let claimed = queue
        .claim_task(worker.worker_id.clone())
        .await
        .unwrap()
        .unwrap();

    let task_fut = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        Ok(())
    };
    let res = run_with_heartbeat(
        queue.clone(),
        task_id,
        worker.worker_id.clone(),
        claimed.lease_generation,
        lease,
        task_fut,
    )
    .await;
    assert!(res.is_ok());

    let completed = queue
        .complete_task(
            task_id,
            worker.worker_id.clone(),
            claimed.lease_generation,
        )
        .await
        .unwrap();
    assert_eq!(completed, LeaseMutation::Applied);

    let slow_task_fut = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        Ok(())
    };

    let hb_err = run_with_heartbeat(
        queue.clone(),
        task_id,
        worker.worker_id,
        claimed.lease_generation,
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
    let db_path = std::env::temp_dir().join(format!("test_runtime_{}.db", rand::random::<u64>()));

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
        shutdown_rx,
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
