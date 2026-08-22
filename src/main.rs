use std::sync::Arc;
use std::time::Duration;

use robust_sinkhorn_queue::metrics::{start_metrics_server, MetricsConfig};
use robust_sinkhorn_queue::observability::{ExporterKind, ObservabilityConfig};
use robust_sinkhorn_queue::runtime::{run_dispatcher_loop, spawn_worker_slots};
use robust_sinkhorn_queue::tokio_queue::AsyncRobustSinkhornQueue;
use robust_sinkhorn_queue::value::{
    ClaimedTask, EnqueueCommand, Epsilon, LeaseDuration, MaxRetries, Priority, SlotCount, TaskKind,
    TaskName, TaskPayload, TraceId, WorkerDescriptor, WorkerId, WorkerKind,
};
use robust_sinkhorn_queue::QueueResult;
use tracing::Instrument;

#[tokio::main]
async fn main() -> QueueResult<()> {
    let obs_config = ObservabilityConfig {
        service_name: "sinkhorn-queue-example".into(),
        log_exporter: ExporterKind::Console,
        otlp_endpoint: std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
        ..Default::default()
    };
    let _obs_guard = robust_sinkhorn_queue::observability::init(obs_config);

    let _metrics_handle = robust_sinkhorn_queue::metrics::init_metrics();

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

    let trace_id = TraceId::generate();
    queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("train-model"),
            kind: TaskKind::Gpu,
            payload: TaskPayload::new(r#"{"batch_size": 32}"#),
            priority: Priority::new(10),
            max_retries: MaxRetries::new(3)?,
            trace_id: Some(trace_id.clone()),
        })
        .await?;

    tracing::info!(trace.id = %trace_id.as_str(), "task enqueued with trace");

    let metrics_config = MetricsConfig {
        listen_addr: ([0, 0, 0, 0], 9090).into(),
    };
    let metrics_server = tokio::spawn(start_metrics_server(metrics_config, shutdown_rx.clone()));

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

    let handler = Arc::new(|task: ClaimedTask| {
        let span = tracing::info_span!(
            "worker.handler",
            task.id = task.id.value(),
            task.name = %task.task_name.as_str(),
            trace.id = %task.trace_id.as_str()
        );

        async move {
            tracing::info!("processing task payload");
            tokio::time::sleep(Duration::from_secs(2)).await;
            tracing::info!("task processing completed");
            Ok(())
        }
        .instrument(span)
    });

    let worker_handles = spawn_worker_slots(
        queue.clone(),
        worker,
        shutdown_rx.clone(),
        Duration::from_millis(500),
        lease,
        handler,
    );

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("ctrl+c received");
        },
        _ = tokio::time::sleep(Duration::from_millis(500)) => {
            tracing::info!("auto-shutdown after initial execution");
        }
    }

    println!("shutdown dimulai...");
    let _ = shutdown_tx.send(true);

    let _ = metrics_server.await;
    dispatcher.await.unwrap()?;

    for handle in worker_handles {
        handle.await.unwrap()?;
    }

    println!("shutdown selesai");

    Ok(())
}
