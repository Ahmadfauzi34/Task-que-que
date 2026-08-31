use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Duration;

use axum::routing::get;
use axum::Router;
use metrics::{counter, describe_counter, describe_gauge, describe_histogram, gauge, histogram};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use tokio::sync::watch;

static METRICS_HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();

pub struct MetricsConfig {
    pub listen_addr: SocketAddr,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            listen_addr: ([0, 0, 0, 0], 9090).into(),
        }
    }
}

pub fn init_metrics() -> PrometheusHandle {
    if let Some(handle) = METRICS_HANDLE.get() {
        return handle.clone();
    }

    describe_counter!(
        "queue_tasks_enqueued_total",
        "Total number of tasks enqueued"
    );
    describe_counter!(
        "queue_tasks_dispatched_total",
        "Total number of tasks dispatched to workers"
    );
    describe_counter!(
        "queue_tasks_completed_total",
        "Total number of tasks completed successfully"
    );
    describe_counter!("queue_tasks_failed_total", "Total number of tasks failed");
    describe_counter!("queue_tasks_retried_total", "Total number of task retries");
    describe_counter!(
        "queue_lease_expirations_total",
        "Total number of lease expirations recovered"
    );
    describe_counter!("queue_heartbeats_total", "Total number of heartbeats sent");
    describe_counter!(
        "queue_heartbeat_failures_total",
        "Total number of failed heartbeats"
    );

    describe_histogram!(
        "queue_task_execution_duration_seconds",
        "Time spent executing tasks"
    );
    describe_histogram!(
        "queue_dispatch_latency_seconds",
        "Time spent in dispatch cycle"
    );
    describe_histogram!(
        "queue_sinkhorn_computation_seconds",
        "Time spent computing Sinkhorn transport plan"
    );
    describe_histogram!(
        "queue_db_operation_duration_seconds",
        "Time spent on database operations"
    );

    describe_gauge!("queue_tasks_pending", "Current number of pending tasks");
    describe_gauge!("queue_tasks_assigned", "Current number of assigned tasks");
    describe_gauge!("queue_tasks_running", "Current number of running tasks");
    describe_gauge!("queue_tasks_failed", "Current number of failed tasks");

    let builder = PrometheusBuilder::new();
    let handle = builder
        .install_recorder()
        .expect("failed to install Prometheus recorder");

    METRICS_HANDLE.get_or_init(|| handle.clone());

    handle
}

pub async fn start_metrics_server(
    config: MetricsConfig,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let handle = init_metrics();

    let app = Router::new()
        .route("/metrics", get(move || async move { handle.render() }))
        .route("/health", get(|| async move { "OK" }));

    let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;

    tracing::info!(addr = %config.listen_addr, "metrics server started");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.changed().await;
            tracing::info!("metrics server shutting down");
        })
        .await?;

    Ok(())
}

pub fn record_enqueue(task_type: &str) {
    counter!("queue_tasks_enqueued_total", "task_type" => task_type.to_string()).increment(1);
}

pub fn record_dispatch(task_type: &str, worker_type: &str) {
    counter!(
        "queue_tasks_dispatched_total",
        "task_type" => task_type.to_string(),
        "worker_type" => worker_type.to_string()
    )
    .increment(1);
}

pub fn record_complete(task_type: &str) {
    counter!("queue_tasks_completed_total", "task_type" => task_type.to_string()).increment(1);
}

pub fn record_failure(task_type: &str, error_type: &str) {
    counter!(
        "queue_tasks_failed_total",
        "task_type" => task_type.to_string(),
        "error_type" => error_type.to_string()
    )
    .increment(1);
}

pub fn record_retry(task_type: &str, retry_count: i64) {
    counter!(
        "queue_tasks_retried_total",
        "task_type" => task_type.to_string(),
        "retry_count" => retry_count.to_string()
    )
    .increment(1);
}

pub fn record_lease_expiration() {
    counter!("queue_lease_expirations_total").increment(1);
}

pub fn record_heartbeat() {
    counter!("queue_heartbeats_total").increment(1);
}

pub fn record_heartbeat_failure() {
    counter!("queue_heartbeat_failures_total").increment(1);
}

pub fn record_task_execution_duration(task_type: &str, duration: Duration) {
    histogram!(
        "queue_task_execution_duration_seconds",
        "task_type" => task_type.to_string()
    )
    .record(duration.as_secs_f64());
}

pub fn record_dispatch_latency(duration: Duration) {
    histogram!("queue_dispatch_latency_seconds").record(duration.as_secs_f64());
}

pub fn record_sinkhorn_computation(duration: Duration) {
    histogram!("queue_sinkhorn_computation_seconds").record(duration.as_secs_f64());
}

pub fn record_db_operation(operation: &str, duration: Duration) {
    histogram!(
        "queue_db_operation_duration_seconds",
        "operation" => operation.to_string()
    )
    .record(duration.as_secs_f64());
}

pub fn update_gauge_pending(count: usize) {
    gauge!("queue_tasks_pending").set(count as f64);
}

pub fn update_gauge_assigned(count: usize) {
    gauge!("queue_tasks_assigned").set(count as f64);
}

pub fn update_gauge_running(count: usize) {
    gauge!("queue_tasks_running").set(count as f64);
}

pub fn update_gauge_failed(count: usize) {
    gauge!("queue_tasks_failed").set(count as f64);
}
