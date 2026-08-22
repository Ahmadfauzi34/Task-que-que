use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ndarray::{Array1, Array2};
use rand::Rng;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, TransactionBehavior};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum QueueError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("invalid queue state: {0}")]
    InvalidState(String),
}

pub type QueueResult<T> = std::result::Result<T, QueueError>;

fn now_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_name TEXT NOT NULL,
    task_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    locked_by TEXT,
    locked_until REAL,
    heartbeat_at REAL,
    error_log TEXT,
    scheduled_at REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS REAL)),
    updated_at REAL NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS REAL))
);

CREATE INDEX IF NOT EXISTS idx_tasks_dispatch
    ON tasks (status, scheduled_at, priority DESC, id);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_worker
    ON tasks (status, locked_by);
"#;

#[derive(Debug, Clone)]
pub struct WorkerDescriptor {
    pub worker_id: String,
    pub worker_type: String,
    pub capacity: i64,
    pub available_slots: i64,
}

#[derive(Debug, Clone)]
pub struct DispatchedTask {
    pub task_id: i64,
    pub task_name: String,
    pub task_type: String,
    pub priority: i64,
    pub worker_id: String,
    pub transport_score: f64,
}

#[derive(Debug, Clone)]
pub struct ClaimedTask {
    pub id: i64,
    pub task_name: String,
    pub task_type: String,
    pub payload: String,
    pub retry_count: i64,
    pub max_retries: i64,
}

#[derive(Debug, Clone)]
struct PendingTask {
    id: i64,
    name: String,
    task_type: String,
    priority: i64,
    created_at: f64,
}

pub struct DatabaseManager;

impl DatabaseManager {
    pub fn execute_with_retry<F, T>(db_path: &Path, mut op: F) -> QueueResult<T>
    where
        F: FnMut(&mut Connection) -> QueueResult<T>,
    {
        let max_attempts = 7u32;

        for attempt in 0..max_attempts {
            let mut conn = Self::open(db_path)?;

            match op(&mut conn) {
                Ok(value) => return Ok(value),
                Err(err) => {
                    if attempt + 1 < max_attempts && Self::is_retryable(&err) {
                        let shift = attempt.min(6);
                        let base = 25u64.saturating_mul(1u64 << shift);
                        let jitter = rand::thread_rng().gen_range(0..75u64);
                        thread::sleep(Duration::from_millis(base.saturating_add(jitter)));
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        unreachable!()
    }

    fn open(path: &Path) -> QueueResult<Connection> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_millis(2_000))?;

        // Best-effort tuning. Jika environment membatalkan pragma tertentu,
        // queue tetap jalan dengan fallback default SQLite.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");

        Ok(conn)
    }

    fn is_retryable(err: &QueueError) -> bool {
        if let QueueError::Sqlite(e) = err {
            if let Some(code) = e.sqlite_error_code() {
                if matches!(code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) {
                    return true;
                }
            }

            let msg = e.to_string().to_lowercase();
            return msg.contains("database is locked") || msg.contains("database table is locked");
        }

        false
    }
}

#[derive(Debug, Clone)]
pub struct RobustSinkhornQueue {
    db_path: PathBuf,
}

impl RobustSinkhornQueue {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn ensure_schema(&self) -> QueueResult<()> {
        DatabaseManager::execute_with_retry(&self.db_path, |conn| {
            conn.execute_batch(SCHEMA)?;
            Ok(())
        })
    }

    pub fn enqueue_simple(
        &self,
        task_name: &str,
        task_type: &str,
        payload: &str,
    ) -> QueueResult<i64> {
        self.enqueue(task_name, task_type, payload, 0, 3)
    }

    pub fn enqueue(
        &self,
        task_name: &str,
        task_type: &str,
        payload: &str,
        priority: i64,
        max_retries: i64,
    ) -> QueueResult<i64> {
        let now = now_f64();

        let task_name = task_name.to_owned();
        let task_type = task_type.to_owned();
        let payload = payload.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            tx.execute(
                "INSERT INTO tasks
                    (
                        task_name,
                        task_type,
                        payload,
                        priority,
                        max_retries,
                        status,
                        retry_count,
                        scheduled_at,
                        created_at,
                        updated_at
                    )
                 VALUES
                    (?1, ?2, ?3, ?4, ?5, 'PENDING', 0, ?6, ?7, ?8)",
                params![
                    task_name,
                    task_type,
                    payload,
                    priority,
                    max_retries,
                    now,
                    now,
                    now
                ],
            )?;

            let id = tx.last_insert_rowid();
            tx.commit()?;

            Ok(id)
        })
    }

    pub fn recover_expired_leases(&self) -> QueueResult<usize> {
        let now = now_f64();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let affected = tx.execute(
                "UPDATE tasks
                 SET status = 'PENDING',
                     locked_by = NULL,
                     locked_until = NULL,
                     heartbeat_at = NULL,
                     updated_at = ?1
                 WHERE status IN ('ASSIGNED', 'RUNNING')
                   AND locked_until < ?2",
                params![now, now],
            )?;

            tx.commit()?;
            Ok(affected)
        })
    }

    pub fn dispatch_batch_defaults(
        &self,
        workers: &[WorkerDescriptor],
    ) -> QueueResult<Vec<DispatchedTask>> {
        self.dispatch_batch(workers, 1.5, 10.0)
    }

    pub fn dispatch_batch(
        &self,
        workers: &[WorkerDescriptor],
        epsilon: f64,
        lease_sec: f64,
    ) -> QueueResult<Vec<DispatchedTask>> {
        let active_workers: Vec<WorkerDescriptor> = workers
            .iter()
            .filter(|w| w.available_slots > 0)
            .cloned()
            .collect();

        if active_workers.is_empty() {
            return Ok(Vec::new());
        }

        let total_available = active_workers
            .iter()
            .fold(0i64, |acc, w| acc.saturating_add(w.available_slots));

        if total_available <= 0 {
            return Ok(Vec::new());
        }

        let epsilon = if epsilon.is_finite() && epsilon > 0.0 {
            epsilon
        } else {
            1.5
        };

        let lease_sec = if lease_sec.is_finite() && lease_sec > 0.0 {
            lease_sec
        } else {
            10.0
        };

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let rows = {
                let mut stmt = tx.prepare(
                    "SELECT id, task_name, task_type, priority, created_at
                     FROM tasks
                     WHERE status = 'PENDING'
                       AND scheduled_at <= ?1
                     ORDER BY priority DESC, id ASC
                     LIMIT ?2",
                )?;

                let mapped = stmt.query_map(params![now, total_available], |row| {
                    Ok(PendingTask {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        task_type: row.get(2)?,
                        priority: row.get(3)?,
                        created_at: row.get::<_, f64>(4).unwrap_or(now),
                    })
                })?;
                let mut vec = Vec::new();
                for item in mapped {
                    vec.push(item?);
                }
                vec
            };

            if rows.is_empty() {
                return Ok(Vec::new());
            }

            let n = rows.len();
            let m = active_workers.len();

            let mut cost = Array2::<f64>::zeros((n, m));

            for (i, task) in rows.iter().enumerate() {
                let mut age = now - task.created_at;
                if !age.is_finite() || age < 0.0 {
                    age = 0.0;
                }

                let age_bonus = age.min(300.0) * 0.15;

                for (j, worker) in active_workers.iter().enumerate() {
                    let affinity_cost = match (task.task_type.as_str(), worker.worker_type.as_str())
                    {
                        ("gpu", "gpu") => 0.0,
                        ("gpu", _) => 20.0,
                        ("cpu", "cpu") => 0.0,
                        ("cpu", _) => 6.0,
                        _ => 2.0,
                    };

                    let prio_bonus = task.priority as f64 * 1.8;
                    let base_cost = 30.0 - prio_bonus - age_bonus + affinity_cost;

                    cost[[i, j]] = base_cost.max(0.5);
                }
            }

            let row_supply = Array1::from_vec(vec![1.0 / n as f64; n]);

            let col_demand = Array1::from_vec(
                active_workers
                    .iter()
                    .map(|w| w.available_slots as f64 / total_available as f64)
                    .collect(),
            );

            let plan =
                sinkhorn_knopp_log_domain(&cost, &row_supply, &col_demand, epsilon, 120, 1e-6);

            let capacities: Vec<i64> = active_workers.iter().map(|w| w.available_slots).collect();
            let assignments = round_transport_plan_bounded(&plan, &capacities);

            let lease_until = now + lease_sec;
            let mut dispatched = Vec::new();

            {
                let mut update = tx.prepare(
                    "UPDATE tasks
                     SET status = ?1,
                         locked_by = ?2,
                         locked_until = ?3,
                         heartbeat_at = ?4,
                         updated_at = ?5
                     WHERE id = ?6",
                )?;

                for (i, task) in rows.iter().enumerate() {
                    let worker_idx = assignments[i];

                    if worker_idx < 0 {
                        continue;
                    }

                    let worker_idx = worker_idx as usize;

                    if worker_idx >= active_workers.len() {
                        continue;
                    }

                    let worker = &active_workers[worker_idx];

                    update.execute(params![
                        "ASSIGNED",
                        worker.worker_id,
                        lease_until,
                        now,
                        now,
                        task.id
                    ])?;

                    let raw_score = plan.get((i, worker_idx)).copied().unwrap_or(0.0);

                    let bounded_score = if raw_score.is_finite() {
                        raw_score.clamp(0.0, 1.0)
                    } else {
                        0.0
                    };

                    dispatched.push(DispatchedTask {
                        task_id: task.id,
                        task_name: task.name.clone(),
                        task_type: task.task_type.clone(),
                        priority: task.priority,
                        worker_id: worker.worker_id.clone(),
                        transport_score: (bounded_score * 10_000.0).round() / 10_000.0,
                    });
                }
            }

            tx.commit()?;
            Ok(dispatched)
        })
    }

    pub fn claim_task(&self, worker_id: &str) -> QueueResult<Option<ClaimedTask>> {
        let worker_id = worker_id.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let task = tx
                .query_row(
                    "SELECT id, task_name, task_type, payload, retry_count, max_retries
                     FROM tasks
                     WHERE status = 'ASSIGNED'
                       AND locked_by = ?1
                     ORDER BY priority DESC, id ASC
                     LIMIT 1",
                    params![worker_id],
                    |row| {
                        Ok(ClaimedTask {
                            id: row.get(0)?,
                            task_name: row.get(1)?,
                            task_type: row.get(2)?,
                            payload: row.get(3)?,
                            retry_count: row.get(4)?,
                            max_retries: row.get(5)?,
                        })
                    },
                )
                .optional()?;

            if let Some(task) = task {
                tx.execute(
                    "UPDATE tasks
                     SET status = 'RUNNING',
                         heartbeat_at = ?1,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![now, now, task.id],
                )?;

                tx.commit()?;
                return Ok(Some(task));
            }

            Ok(None)
        })
    }

    pub fn heartbeat(&self, task_id: i64, worker_id: &str, extend_sec: f64) -> QueueResult<bool> {
        let worker_id = worker_id.to_owned();

        let extend_sec = if extend_sec.is_finite() && extend_sec > 0.0 {
            extend_sec
        } else {
            10.0
        };

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let lease_until = now + extend_sec;

            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let affected = tx.execute(
                "UPDATE tasks
                 SET locked_until = ?1,
                     heartbeat_at = ?2,
                     updated_at = ?3
                 WHERE id = ?4
                   AND locked_by = ?5
                   AND status = 'RUNNING'",
                params![lease_until, now, now, task_id, worker_id],
            )?;

            tx.commit()?;
            Ok(affected > 0)
        })
    }

    pub fn complete_task(&self, task_id: i64, worker_id: &str) -> QueueResult<()> {
        let worker_id = worker_id.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            tx.execute(
                "UPDATE tasks
                 SET status = 'COMPLETED',
                     locked_by = NULL,
                     locked_until = NULL,
                     heartbeat_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2
                   AND locked_by = ?3",
                params![now, task_id, worker_id],
            )?;

            tx.commit()?;
            Ok(())
        })
    }

    pub fn fail_task(
        &self,
        task_id: i64,
        worker_id: &str,
        error_msg: &str,
        retry_count: i64,
        max_retries: i64,
    ) -> QueueResult<()> {
        let worker_id = worker_id.to_owned();
        let error_msg = error_msg.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            if retry_count + 1 >= max_retries {
                tx.execute(
                    "UPDATE tasks
                     SET status = 'FAILED',
                         retry_count = retry_count + 1,
                         locked_by = NULL,
                         locked_until = NULL,
                         heartbeat_at = NULL,
                         error_log = ?1,
                         updated_at = ?2
                     WHERE id = ?3
                       AND locked_by = ?4",
                    params![error_msg, now, task_id, worker_id],
                )?;
            } else {
                let capped_retry = retry_count.clamp(0, 20);
                let backoff_seconds = 2.0f64.powi(capped_retry as i32) * 2.0;
                let scheduled_next = now + backoff_seconds;

                tx.execute(
                    "UPDATE tasks
                     SET status = 'PENDING',
                         retry_count = retry_count + 1,
                         locked_by = NULL,
                         locked_until = NULL,
                         heartbeat_at = NULL,
                         scheduled_at = ?1,
                         error_log = ?2,
                         updated_at = ?3
                     WHERE id = ?4
                       AND locked_by = ?5",
                    params![scheduled_next, error_msg, now, task_id, worker_id],
                )?;
            }

            tx.commit()?;
            Ok(())
        })
    }
}

fn clamp_positive(x: f64) -> f64 {
    if x.is_finite() && x > 0.0 {
        x
    } else {
        1e-300
    }
}

fn sinkhorn_knopp_log_domain(
    cost: &Array2<f64>,
    row_supply: &Array1<f64>,
    col_demand: &Array1<f64>,
    epsilon: f64,
    max_iter: usize,
    tol: f64,
) -> Array2<f64> {
    let (n, m) = cost.dim();

    if n == 0 || m == 0 {
        return Array2::zeros((n, m));
    }

    if row_supply.len() != n || col_demand.len() != m {
        return Array2::zeros((n, m));
    }

    let eps = if epsilon.is_finite() && epsilon > 0.0 {
        epsilon
    } else {
        1e-2
    };

    let r_sum: f64 = row_supply.iter().sum();
    let c_sum: f64 = col_demand.iter().sum();

    if !r_sum.is_finite() || !c_sum.is_finite() || r_sum <= 0.0 || c_sum <= 0.0 {
        return Array2::zeros((n, m));
    }

    let log_r: Vec<f64> = row_supply
        .iter()
        .map(|x| clamp_positive(*x / r_sum).ln())
        .collect();

    let log_c: Vec<f64> = col_demand
        .iter()
        .map(|x| clamp_positive(*x / c_sum).ln())
        .collect();

    let mut u = vec![0.0f64; n];
    let mut v = vec![0.0f64; m];

    let max_iter = max_iter.max(1);
    let tol = if tol.is_finite() && tol > 0.0 {
        tol
    } else {
        1e-6
    };

    for _ in 0..max_iter {
        let old_u = u.clone();

        for i in 0..n {
            let mut max_val = f64::NEG_INFINITY;

            for j in 0..m {
                let val = (v[j] - cost[[i, j]]) / eps;
                if val > max_val {
                    max_val = val;
                }
            }

            let lse = if max_val.is_finite() {
                let mut sum = 0.0f64;

                for j in 0..m {
                    let shifted = ((v[j] - cost[[i, j]]) / eps) - max_val;
                    sum += shifted.exp();
                }

                if sum > 0.0 {
                    max_val + sum.ln()
                } else {
                    max_val
                }
            } else {
                0.0
            };

            u[i] = eps * (log_r[i] - lse);
        }

        for j in 0..m {
            let mut max_val = f64::NEG_INFINITY;

            for i in 0..n {
                let val = (u[i] - cost[[i, j]]) / eps;
                if val > max_val {
                    max_val = val;
                }
            }

            let lse = if max_val.is_finite() {
                let mut sum = 0.0f64;

                for i in 0..n {
                    let shifted = ((u[i] - cost[[i, j]]) / eps) - max_val;
                    sum += shifted.exp();
                }

                if sum > 0.0 {
                    max_val + sum.ln()
                } else {
                    max_val
                }
            } else {
                0.0
            };

            v[j] = eps * (log_c[j] - lse);
        }

        let mut max_delta = 0.0f64;

        for i in 0..n {
            let delta = (u[i] - old_u[i]).abs();
            if delta.is_finite() && delta > max_delta {
                max_delta = delta;
            }
        }

        if max_delta.is_finite() && max_delta < tol {
            break;
        }
    }

    let mut plan = Array2::<f64>::zeros((n, m));

    for i in 0..n {
        for j in 0..m {
            let log_p = (u[i] + v[j] - cost[[i, j]]) / eps;

            let value = if !log_p.is_finite() || log_p < -700.0 {
                0.0
            } else if log_p > 700.0 {
                1e300
            } else {
                log_p.exp()
            };

            plan[[i, j]] = if value.is_finite() && value > 0.0 {
                value
            } else {
                0.0
            };
        }
    }

    for i in 0..n {
        let target = clamp_positive(row_supply[i] / r_sum);
        let mut sum = 0.0f64;

        for j in 0..m {
            sum += plan[[i, j]];
        }

        if sum.is_finite() && sum > 0.0 {
            let factor = target / sum;
            for j in 0..m {
                plan[[i, j]] *= factor;
            }
        } else {
            let uniform = target / m as f64;
            for j in 0..m {
                plan[[i, j]] = uniform;
            }
        }
    }

    plan
}

fn round_transport_plan_bounded(plan: &Array2<f64>, capacities: &[i64]) -> Vec<i32> {
    let (n, m) = plan.dim();

    let mut remaining: Vec<usize> = capacities.iter().map(|c| (*c).max(0) as usize).collect();
    let mut assignment: Vec<i32> = vec![-1; n];
    let mut assigned = vec![false; n];

    let mut candidates: Vec<(f64, usize, usize)> = Vec::with_capacity(n.saturating_mul(m));

    for i in 0..n {
        for j in 0..m {
            let score = plan[[i, j]];

            if score.is_finite() && remaining[j] > 0 {
                candidates.push((score, i, j));
            }
        }
    }

    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));

    for (_, i, j) in candidates {
        if !assigned[i] && remaining[j] > 0 {
            assignment[i] = j as i32;
            assigned[i] = true;
            remaining[j] -= 1;
        }
    }

    for i in 0..n {
        if assigned[i] {
            continue;
        }

        let mut best: Option<(f64, usize)> = None;

        for j in 0..m {
            if remaining[j] == 0 {
                continue;
            }

            let score = if plan[[i, j]].is_finite() {
                plan[[i, j]]
            } else {
                0.0
            };

            if best.is_none_or(|(best_score, _)| score > best_score) {
                best = Some((score, j));
            }
        }

        if let Some((_, j)) = best {
            assignment[i] = j as i32;
            assigned[i] = true;
            remaining[j] -= 1;
        }
    }

    assignment
}
