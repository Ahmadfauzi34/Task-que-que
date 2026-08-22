Oke — lanjut. Kita **pertahankan desain inti**:  
- mesin queue tetap **sync + SQLite + Sinkhorn** sebagai core yang deterministik,
- Tokio masuk sebagai **async facade / runtime layer**, bukan mengubah inti,
- domain dibuat lebih aman dengan **typed value objects**.

Ini lebih “reference machine” daripada port biasa: kita siapkan lapisan nilai, adapter async, heartbeat, shutdown, dan worker runtime.

---

# 1. Prinsip desain

## Desain yang dipertahankan

```text
SQLite + Sinkhorn core
        │
        ▼
Sync Engine (RobustSinkhornQueue)
        │
        ▼
Tokio Adapter (spawn_blocking)
        │
        ▼
Worker Runtime / Dispatcher / Heartbeat
```

Alasan:

1. `rusqlite` itu blocking.
2. Perhitungan Sinkhorn juga CPU-bound.
3. Memanggil DB sync langsung di async task bisa memblokir Tokio runtime.
4. Jadi cara paling aman:
   - DB access → `tokio::task::spawn_blocking`
   - Sinkhorn dispatch → tetap di blocking thread
   - worker execution → async Tokio

---

# 2. Tambah dependency Tokio

`Cargo.toml`:

```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
ndarray = "0.15"
thiserror = "1"
rand = "0.8"

tokio = { version = "1", features = ["full"] }
```

---

# 3. Value types / typed values

Tujuan:

- `TaskId` tidak tertukar dengan `WorkerId`
- `Priority` bukan integer telanjang
- `SlotCount` tidak boleh negatif
- `Epsilon` harus valid
- `LeaseDuration` harus valid
- status task jadi enum
- task/worker type jadi enum yang tetap extensible

Misal sebelumnya kode sync ada di module:

```rust
pub mod sync_queue;
```

Lalu kita buat module baru:

```rust
pub mod value;
pub mod tokio_queue;
pub mod runtime;
```

---

## `src/value.rs`

```rust
use std::time::Duration;

use crate::sync_queue::{QueueError, QueueResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TaskId(i64);

impl TaskId {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkerId(String);

impl WorkerId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskName(String);

impl TaskName {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPayload(String);

impl TaskPayload {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Priority(i64);

impl Priority {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaxRetries(i64);

impl MaxRetries {
    pub fn new(value: i64) -> QueueResult<Self> {
        if value < 0 {
            return Err(QueueError::InvalidState(
                "max_retries tidak boleh negatif".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryCount(i64);

impl RetryCount {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotCount(i64);

impl SlotCount {
    pub fn new(value: i64) -> QueueResult<Self> {
        if value < 0 {
            return Err(QueueError::InvalidState(
                "slot count tidak boleh negatif".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TransportScore(f64);

impl TransportScore {
    pub fn new(value: f64) -> Self {
        let safe = if value.is_finite() {
            value.clamp(0.0, 1.0)
        } else {
            0.0
        };

        Self(safe)
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Epsilon(f64);

impl Epsilon {
    pub fn new(value: f64) -> QueueResult<Self> {
        if !value.is_finite() || value <= 0.0 {
            return Err(QueueError::InvalidState(
                "epsilon harus finite dan > 0".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LeaseDuration(Duration);

impl LeaseDuration {
    pub fn new(value: Duration) -> QueueResult<Self> {
        if value.as_nanos() == 0 {
            return Err(QueueError::InvalidState(
                "lease duration tidak boleh nol".into(),
            ));
        }

        Ok(Self(value))
    }

    pub fn value(self) -> Duration {
        self.0
    }

    pub fn as_secs_f64(self) -> f64 {
        self.0.as_secs_f64()
    }

    pub fn heartbeat_interval(self) -> Duration {
        let half = self.0 / 2;

        if half.as_nanos() == 0 {
            Duration::from_millis(1)
        } else {
            half
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TaskKind {
    Gpu,
    Cpu,
    Other(String),
}

impl TaskKind {
    pub fn to_db(&self) -> String {
        match self {
            TaskKind::Gpu => "gpu".to_string(),
            TaskKind::Cpu => "cpu".to_string(),
            TaskKind::Other(value) => value.clone(),
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "gpu" => TaskKind::Gpu,
            "cpu" => TaskKind::Cpu,
            other => TaskKind::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkerKind {
    Gpu,
    Cpu,
    Other(String),
}

impl WorkerKind {
    pub fn to_db(&self) -> String {
        match self {
            WorkerKind::Gpu => "gpu".to_string(),
            WorkerKind::Cpu => "cpu".to_string(),
            WorkerKind::Other(value) => value.clone(),
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "gpu" => WorkerKind::Gpu,
            "cpu" => WorkerKind::Cpu,
            other => WorkerKind::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Assigned,
    Running,
    Completed,
    Failed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Pending => "PENDING",
            TaskStatus::Assigned => "ASSIGNED",
            TaskStatus::Running => "RUNNING",
            TaskStatus::Completed => "COMPLETED",
            TaskStatus::Failed => "FAILED",
        }
    }

    pub fn parse(value: &str) -> QueueResult<Self> {
        match value {
            "PENDING" => Ok(TaskStatus::Pending),
            "ASSIGNED" => Ok(TaskStatus::Assigned),
            "RUNNING" => Ok(TaskStatus::Running),
            "COMPLETED" => Ok(TaskStatus::Completed),
            "FAILED" => Ok(TaskStatus::Failed),
            other => Err(QueueError::InvalidState(format!(
                "unknown task status: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkerDescriptor {
    pub worker_id: WorkerId,
    pub kind: WorkerKind,
    pub capacity: SlotCount,
    pub available_slots: SlotCount,
}

impl WorkerDescriptor {
    pub fn to_sync(&self) -> crate::sync_queue::WorkerDescriptor {
        crate::sync_queue::WorkerDescriptor {
            worker_id: self.worker_id.clone().into_string(),
            worker_type: self.kind.to_db(),
            capacity: self.capacity.value(),
            available_slots: self.available_slots.value(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnqueueCommand {
    pub name: TaskName,
    pub kind: TaskKind,
    pub payload: TaskPayload,
    pub priority: Priority,
    pub max_retries: MaxRetries,
}

#[derive(Debug, Clone)]
pub struct DispatchedTask {
    pub task_id: TaskId,
    pub task_name: TaskName,
    pub task_kind: TaskKind,
    pub priority: Priority,
    pub worker_id: WorkerId,
    pub transport_score: TransportScore,
}

impl DispatchedTask {
    pub fn from_sync(value: crate::sync_queue::DispatchedTask) -> Self {
        Self {
            task_id: TaskId::new(value.task_id),
            task_name: TaskName::new(value.task_name),
            task_kind: TaskKind::from_db(&value.task_type),
            priority: Priority::new(value.priority),
            worker_id: WorkerId::new(value.worker_id),
            transport_score: TransportScore::new(value.transport_score),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClaimedTask {
    pub id: TaskId,
    pub task_name: TaskName,
    pub task_kind: TaskKind,
    pub payload: TaskPayload,
    pub retry_count: RetryCount,
    pub max_retries: MaxRetries,
}

impl ClaimedTask {
    pub fn from_sync(value: crate::sync_queue::ClaimedTask) -> Self {
        Self {
            id: TaskId::new(value.id),
            task_name: TaskName::new(value.task_name),
            task_kind: TaskKind::from_db(&value.task_type),
            payload: TaskPayload::new(value.payload),
            retry_count: RetryCount::new(value.retry_count),
            max_retries: MaxRetries::new(value.max_retries)
                .unwrap_or_else(|_| MaxRetries(0)),
        }
    }
}
```

---

# 4. Async adapter untuk Tokio

Konsep penting:

- Semua operasi DB sync dibungkus dengan `spawn_blocking`.
- Jangan share `rusqlite::Connection` antar async task.
- Jangan hold blocking DB call langsung di async task.

---

## `src/tokio_queue.rs`

```rust
use std::path::PathBuf;
use std::sync::Arc;

use crate::sync_queue::{self, RobustSinkhornQueue};
use crate::value::{
    ClaimedTask, DispatchedTask, EnqueueCommand, Epsilon, LeaseDuration,
    MaxRetries, RetryCount, TaskId, WorkerDescriptor, WorkerId,
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
        F: FnOnce(Arc<RobustSinkhornQueue>) -> sync_queue::QueueResult<T>
            + Send
            + 'static,
        T: Send + 'static,
    {
        let inner = self.inner.clone();

        tokio::task::spawn_blocking(move || op(inner))
            .await
            .map_err(|e| {
                sync_queue::QueueError::InvalidState(format!(
                    "spawn_blocking join error: {e}"
                ))
            })?
    }

    pub async fn ensure_schema(&self) -> sync_queue::QueueResult<()> {
        self.blocking(|q| q.ensure_schema()).await
    }

    pub async fn enqueue(
        &self,
        cmd: EnqueueCommand,
    ) -> sync_queue::QueueResult<TaskId> {
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

    pub async fn recover_expired_leases(
        &self,
    ) -> sync_queue::QueueResult<usize> {
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
            .blocking(move |q| {
                q.dispatch_batch(&sync_workers, eps, lease_sec)
            })
            .await?;

        Ok(raw.into_iter().map(DispatchedTask::from_sync).collect())
    }

    pub async fn claim_task(
        &self,
        worker_id: WorkerId,
    ) -> sync_queue::QueueResult<Option<ClaimedTask>> {
        let worker = worker_id.into_string();

        let raw = self.blocking(move |q| q.claim_task(&worker)).await?;

        Ok(raw.map(ClaimedTask::from_sync))
    }

    pub async fn heartbeat(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
        lease: LeaseDuration,
    ) -> sync_queue::QueueResult<bool> {
        let worker = worker_id.into_string();
        let lease_sec = lease.as_secs_f64();

        self.blocking(move |q| {
            q.heartbeat(task_id.value(), &worker, lease_sec)
        })
        .await
    }

    pub async fn complete_task(
        &self,
        task_id: TaskId,
        worker_id: WorkerId,
    ) -> sync_queue::QueueResult<()> {
        let worker = worker_id.into_string();

        self.blocking(move |q| {
            q.complete_task(task_id.value(), &worker)
        })
        .await
    }

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
```

---

# 5. Runtime Tokio: heartbeat, worker loop, dispatcher

Sekarang kita bikin lapisan runtime.

Yang kita butuhkan:

1. Worker bisa claim task.
2. Saat task berjalan, heartbeat dikirim periodik.
3. Jika task sukses → `complete_task`.
4. Jika task gagal → `fail_task`.
5. Ada shutdown signal.
6. Dispatcher mengisi task ke worker secara periodik.

---

## `src/runtime.rs`

```rust
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};

use crate::sync_queue::{QueueError, QueueResult};
use crate::tokio_queue::AsyncRobustSinkhornQueue;
use crate::value::{
    ClaimedTask, Epsilon, LeaseDuration, TaskId, WorkerDescriptor, WorkerId,
};

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
    let mut tick = interval(lease.heartbeat_interval());
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    tokio::pin!(fut);

    loop {
        tokio::select! {
            _ = tick.tick() => {
                match queue.heartbeat(task_id, worker_id.clone(), lease).await {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(
                            "lease hilang atau task tidak lagi RUNNING".into()
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
                let retry_count = task.retry_count;
                let max_retries = task.max_retries;

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
                        queue
                            .complete_task(task_id, worker.worker_id.clone())
                            .await?;
                    }
                    Err(err) => {
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

            tokio::spawn(async move {
                run_worker_loop(q, w, rx, poll_interval, lease, h).await
            })
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
```

---

# 6. Contoh wiring lengkap dengan Tokio

Ini contoh cara pakai:

- buat queue
- enqueue task
- jalankan dispatcher
- jalankan worker
- shutdown dengan `ctrl+c`

---

## `src/main.rs`

```rust
mod runtime;
mod sync_queue;
mod tokio_queue;
mod value;

use std::sync::Arc;
use std::time::Duration;

use runtime::{run_dispatcher_loop, spawn_worker_slots};
use tokio_queue::AsyncRobustSinkhornQueue;
use value::{
    ClaimedTask, EnqueueCommand, Epsilon, LeaseDuration, MaxRetries,
    Priority, SlotCount, TaskKind, TaskName, TaskPayload, WorkerDescriptor,
    WorkerId, WorkerKind,
};

#[tokio::main]
async fn main() -> sync_queue::QueueResult<()> {
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
    tokio::signal::ctrl_c().await.ok();

    println!("shutdown dimulai...");
    let _ = shutdown_tx.send(true);

    dispatcher.await.unwrap()?;

    for handle in worker_handles {
        handle.await.unwrap()?;
    }

    println!("shutdown selesai");

    Ok(())
}
```

---

# 7. Penjelasan bagian penting

## 7.1 Kenapa pakai `spawn_blocking`?

Karena operasi sync seperti ini:

```rust
queue.dispatch_batch(...)
queue.claim_task(...)
queue.heartbeat(...)
```

bisa melakukan:

- I/O SQLite,
- lock database,
- komputasi Sinkhorn,
- matrix rounding,

yang semuanya bisa memblokir thread Tokio.

Jadi kita pindahkan ke blocking thread pool:

```rust
tokio::task::spawn_blocking(...)
```

---

## 7.2 Kenapa heartbeat pakai `tokio::select!`?

Karena kita harus menjalankan dua hal bersamaan:

1. task utama,
2. heartbeat lease.

```rust
tokio::select! {
    _ = tick.tick() => {
        // heartbeat
    }

    res = &mut fut => {
        // task selesai
    }
}
```

Jika task selesai lebih dulu, heartbeat berhenti.  
Jika heartbeat gagal, task dianggap kehilangan lease.

---

## 7.3 Kenapa ada `watch::channel<bool>`?

Untuk shutdown signal.

```rust
let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
```

Lalu:

```rust
shutdown_tx.send(true)
```

Semua worker dan dispatcher bisa mendengarkan:

```rust
shutdown.changed()
```

Ini cocok untuk graceful shutdown.

---

## 7.4 Kenapa worker bisa multi-slot?

Karena `WorkerDescriptor` punya:

```rust
available_slots
```

Lalu:

```rust
spawn_worker_slots(...)
```

akan membuat beberapa worker loop sebanyak slot tersedia.

Contoh:

```rust
available_slots = 3
```

akan menjalankan 3 loop claim-execute-heartbeat secara paralel.

---

# 8. Pola integrasi Tokio yang paling aman

## Pola terbaik saat ini

```text
Async Tokio World
      │
      ├─ dispatcher task
      ├─ worker tasks
      ├─ heartbeat
      └─ shutdown watcher
            │
            ▼
spawn_blocking
            │
            ▼
Sync SQLite Queue Engine
```

Ini menjaga:

- async tidak terblokir,
- SQLite tetap aman,
- Sinkhorn tetap bisa CPU-bound,
- desain lama tidak perlu dirombak.

---

# 9. Kalau mau lebih “non-conventional”: actor model

Kalau sistemnya makin besar, kita bisa naikkan desainnya jadi:

```text
Command Bus
   │
   ├─ Enqueue
   ├─ Dispatch
   ├─ Recover
   ├─ Complete
   ├─ Fail
   └─ Heartbeat
        │
        ▼
Queue Actor (tokio mpsc)
        │
        ▼
spawn_blocking → SQLite
```

Keuntungan:

- semua write path masuk lewat satu actor,
- lebih mudah backpressure,
- bisa batching command,
- bisa metrics/tracing terpusat.

Tapi untuk sekarang, adapter `spawn_blocking` sudah jadi dasar Tokio yang paling praktis dan aman.

---

# 10. Checklist desain yang sudah terbentuk

Yang sekarang sudah kita punya:

- ✅ Core queue tetap sync dan robust.
- ✅ Typed value objects:
  - `TaskId`
  - `WorkerId`
  - `TaskName`
  - `TaskPayload`
  - `Priority`
  - `MaxRetries`
  - `RetryCount`
  - `SlotCount`
  - `Epsilon`
  - `LeaseDuration`
  - `TaskKind`
  - `WorkerKind`
  - `TaskStatus`
- ✅ Async facade Tokio:
  - `AsyncRobustSinkhornQueue`
- ✅ Runtime:
  - worker loop
  - heartbeat
  - dispatcher
  - graceful shutdown
- ✅ Pola aman:
  - DB sync di `spawn_blocking`
  - async task tidak memegang koneksi SQLite
  - lease heartbeat berbasis interval
  - shutdown berbasis `watch`

---

# 11. Langkah lanjutan yang paling masuk akal

Kalau mau lanjut lagi, urutan terbaiknya:

## Tahap A

Tambahkan logging/tracing:

```rust
tracing = "0.1"
tracing-subscriber = "0.3"
```

Lalu log:

- enqueue
- dispatch
- claim
- heartbeat
- complete
- fail

---

## Tahap B

Tambahkan metrics:

- jumlah pending task
- jumlah assigned task
- jumlah failed task
- dispatch latency
- heartbeat failure rate

---

## Tahap C

Buat worker registry dinamis:

```rust
WorkerRegistry
```

Supaya dispatcher bisa ambil worker aktif secara real-time.

---

## Tahap D

Buat payload typed:

```rust
TaskPayload(serde_json::Value)
```

atau:

```rust
struct TrainPayload {
    batch_size: usize,
    model: String,
}
```

---

# 12. Ringkasan arsitektur final

```text
┌────────────────────────────┐
│      Tokio Runtime         │
│                            │
│  ┌────────────┐            │
│  │ Dispatcher │            │
│  └────────────┘            │
│                            │
│  ┌────────────┐            │
│  │ Worker x N │            │
│  └────────────┘            │
│                            │
│  ┌────────────┐            │
│  │ Heartbeat  │            │
│  └────────────┘            │
│                            │
│  ┌────────────┐            │
│  │ Shutdown   │            │
│  └────────────┘            │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│   AsyncRobustSinkhornQueue │
│        (spawn_blocking)    │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│ RobustSinkhornQueue (sync) │
│ SQLite + Sinkhorn Engine   │
└────────────────────────────┘
```

Jadi dasar integrasi Tokio-nya sudah jelas:

- **jangan ubah core sync dulu**
- bungkus dengan **async adapter**
- jalankan worker/dispatcher sebagai **Tokio tasks**
- pakai **heartbeat + shutdown channel**
- nanti kalau butuh scale-up, baru naik ke **actor/command bus**.
