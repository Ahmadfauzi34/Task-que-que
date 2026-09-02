use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ndarray::{Array1, Array2};
use rusqlite::{params, params_from_iter, types::Value, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};
use crate::value::{Epsilon, LeaseDuration, WorkerKind};

const MAX_TASK_NAMES_PER_WORKER: usize = 32;
const MAX_TASK_NAME_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerSession {
    pub session_id: String,
    pub worker_id: String,
    pub kind: WorkerKind,
    pub capacity: i64,
    pub task_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRegistration {
    pub session: WorkerSession,
    pub session_token: String,
}

#[derive(Debug, Clone)]
struct WorkerSessionEntry {
    session: WorkerSession,
    session_token: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
pub struct WorkerRegistry {
    inner: Arc<Mutex<HashMap<String, WorkerSessionEntry>>>,
    ttl: Duration,
}

impl WorkerRegistry {
    pub fn new(ttl: Duration) -> QueueResult<Self> {
        if ttl.as_nanos() == 0 {
            return Err(QueueError::InvalidState(
                "worker session ttl must be greater than zero".into(),
            ));
        }

        Ok(Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            ttl,
        })
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    pub fn register(
        &self,
        worker_id: impl Into<String>,
        kind: WorkerKind,
        capacity: i64,
        task_names: Vec<String>,
    ) -> QueueResult<WorkerRegistration> {
        self.register_at(
            worker_id.into(),
            kind,
            capacity,
            task_names,
            Instant::now(),
        )
    }

    fn register_at(
        &self,
        worker_id: String,
        kind: WorkerKind,
        capacity: i64,
        task_names: Vec<String>,
        now: Instant,
    ) -> QueueResult<WorkerRegistration> {
        if worker_id.is_empty() {
            return Err(QueueError::InvalidState(
                "worker id must not be empty".into(),
            ));
        }
        if capacity <= 0 {
            return Err(QueueError::InvalidState(
                "worker capacity must be greater than zero".into(),
            ));
        }
        let task_names = normalize_task_names(task_names)?;

        let mut sessions = self.lock_sessions()?;
        sessions.retain(|_, entry| entry.expires_at > now && entry.session.worker_id != worker_id);

        let session_id = loop {
            let candidate = format!("{:032x}", rand::random::<u128>());
            if !sessions.contains_key(&candidate) {
                break candidate;
            }
        };
        let session_token = format!(
            "{:032x}{:032x}",
            rand::random::<u128>(),
            rand::random::<u128>()
        );
        let session = WorkerSession {
            session_id: session_id.clone(),
            worker_id,
            kind,
            capacity,
            task_names,
        };

        sessions.insert(
            session_id,
            WorkerSessionEntry {
                session: session.clone(),
                session_token: session_token.clone(),
                expires_at: now + self.ttl,
            },
        );

        Ok(WorkerRegistration {
            session,
            session_token,
        })
    }

    pub fn authenticate_and_touch(
        &self,
        session_id: &str,
        session_token: &str,
    ) -> QueueResult<Option<WorkerSession>> {
        self.authenticate_and_touch_at(session_id, session_token, Instant::now())
    }

    fn authenticate_and_touch_at(
        &self,
        session_id: &str,
        session_token: &str,
        now: Instant,
    ) -> QueueResult<Option<WorkerSession>> {
        let mut sessions = self.lock_sessions()?;
        let Some(entry) = sessions.get(session_id) else {
            return Ok(None);
        };

        if entry.expires_at <= now || !constant_time_equal(&entry.session_token, session_token) {
            if entry.expires_at <= now {
                sessions.remove(session_id);
            }
            return Ok(None);
        }

        let entry = sessions
            .get_mut(session_id)
            .expect("validated worker session remains present");
        entry.expires_at = now + self.ttl;
        Ok(Some(entry.session.clone()))
    }

    pub fn active_sessions(&self) -> QueueResult<Vec<WorkerSession>> {
        self.active_sessions_at(Instant::now())
    }

    fn active_sessions_at(&self, now: Instant) -> QueueResult<Vec<WorkerSession>> {
        let mut sessions = self.lock_sessions()?;
        sessions.retain(|_, entry| entry.expires_at > now);
        Ok(sessions
            .values()
            .map(|entry| entry.session.clone())
            .collect())
    }

    fn lock_sessions(
        &self,
    ) -> QueueResult<std::sync::MutexGuard<'_, HashMap<String, WorkerSessionEntry>>> {
        self.inner.lock().map_err(|_| {
            QueueError::InvalidState("worker session registry mutex was poisoned".into())
        })
    }
}

fn normalize_task_names(mut task_names: Vec<String>) -> QueueResult<Vec<String>> {
    if task_names.is_empty() || task_names.len() > MAX_TASK_NAMES_PER_WORKER {
        return Err(QueueError::InvalidState(format!(
            "worker must advertise between 1 and {MAX_TASK_NAMES_PER_WORKER} exact task names"
        )));
    }
    for task_name in &task_names {
        if !is_safe_task_name(task_name) {
            return Err(QueueError::InvalidState(
                "worker task names must be safe 1-128 character identifiers".into(),
            ));
        }
    }
    task_names.sort();
    if task_names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(QueueError::InvalidState(
            "worker task names must not contain duplicates".into(),
        ));
    }
    Ok(task_names)
}

fn is_safe_task_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TASK_NAME_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':')
        })
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerAssignment {
    pub task_id: i64,
    pub session_id: String,
    pub task_name: String,
    pub task_type: String,
}

#[derive(Debug, Clone)]
pub struct WorkerCoordinator {
    db_path: PathBuf,
    registry: WorkerRegistry,
    epsilon: Epsilon,
    lease: LeaseDuration,
}

impl WorkerCoordinator {
    pub fn new(
        db_path: impl Into<PathBuf>,
        registry: WorkerRegistry,
        epsilon: Epsilon,
        lease: LeaseDuration,
    ) -> Self {
        Self {
            db_path: db_path.into(),
            registry,
            epsilon,
            lease,
        }
    }

    pub fn registry(&self) -> &WorkerRegistry {
        &self.registry
    }

    pub async fn dispatch_available(&self) -> QueueResult<Vec<WorkerAssignment>> {
        let sessions = self.registry.active_sessions()?;
        if sessions.is_empty() {
            return Ok(Vec::new());
        }

        let db_path = self.db_path.clone();
        let epsilon = self.epsilon.value();
        let lease_sec = self.lease.as_secs_f64();
        tokio::task::spawn_blocking(move || {
            dispatch_registered(&db_path, sessions, epsilon, lease_sec)
        })
        .await
        .map_err(|error| QueueError::InvalidState(format!("worker dispatch join error: {error}")))?
    }
}

#[derive(Debug, Clone)]
struct DispatchWorker {
    session_id: String,
    available_slots: i64,
    task_names: Vec<String>,
}

impl DispatchWorker {
    fn supports(&self, task_name: &str) -> bool {
        self.task_names
            .binary_search_by(|candidate| candidate.as_str().cmp(task_name))
            .is_ok()
    }
}

#[derive(Debug, Clone)]
struct PendingTask {
    id: i64,
    task_name: String,
    task_type: String,
    priority: i64,
    created_at: f64,
}

fn dispatch_registered(
    db_path: &Path,
    sessions: Vec<WorkerSession>,
    epsilon: f64,
    lease_sec: f64,
) -> QueueResult<Vec<WorkerAssignment>> {
    if sessions.is_empty() {
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
        30.0
    };

    DatabaseManager::execute_with_retry(db_path, move |conn| {
        let now = now_f64();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let loads = {
            let mut stmt = tx.prepare(
                "SELECT locked_by, COUNT(*)
                 FROM tasks
                 WHERE status IN ('ASSIGNED', 'RUNNING')
                   AND locked_by IS NOT NULL
                 GROUP BY locked_by",
            )?;
            let mapped = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut result = HashMap::new();
            for item in mapped {
                let (owner, count) = item?;
                result.insert(owner, count);
            }
            result
        };

        let mut by_type: BTreeMap<String, Vec<DispatchWorker>> = BTreeMap::new();
        for session in &sessions {
            let used = loads.get(&session.session_id).copied().unwrap_or(0).max(0);
            let available_slots = session.capacity.saturating_sub(used);
            if available_slots <= 0 {
                continue;
            }
            by_type
                .entry(session.kind.to_db())
                .or_default()
                .push(DispatchWorker {
                    session_id: session.session_id.clone(),
                    available_slots,
                    task_names: session.task_names.clone(),
                });
        }

        let mut assignments_out = Vec::new();
        let lease_until = now + lease_sec;

        for (task_type, workers) in by_type {
            let total_available = workers.iter().fold(0i64, |sum, worker| {
                sum.saturating_add(worker.available_slots)
            });
            if total_available <= 0 {
                continue;
            }

            let supported_names: BTreeSet<String> = workers
                .iter()
                .flat_map(|worker| worker.task_names.iter().cloned())
                .collect();
            if supported_names.is_empty() {
                continue;
            }

            let tasks = {
                let placeholders = (0..supported_names.len())
                    .map(|index| format!("?{}", index + 3))
                    .collect::<Vec<_>>()
                    .join(",");
                let limit_parameter = supported_names.len() + 3;
                let sql = format!(
                    "SELECT id, task_name, task_type, priority, created_at
                     FROM tasks
                     WHERE status = 'PENDING'
                       AND scheduled_at <= ?1
                       AND task_type = ?2
                       AND task_name IN ({placeholders})
                     ORDER BY priority DESC, id ASC
                     LIMIT ?{limit_parameter}"
                );
                let mut values = Vec::with_capacity(supported_names.len() + 3);
                values.push(Value::Real(now));
                values.push(Value::Text(task_type.clone()));
                values.extend(supported_names.iter().cloned().map(Value::Text));
                values.push(Value::Integer(total_available));

                let mut stmt = tx.prepare(&sql)?;
                let mapped = stmt.query_map(params_from_iter(values.iter()), |row| {
                    Ok(PendingTask {
                        id: row.get(0)?,
                        task_name: row.get(1)?,
                        task_type: row.get(2)?,
                        priority: row.get(3)?,
                        created_at: row.get::<_, f64>(4).unwrap_or(now),
                    })
                })?;
                let mut result = Vec::new();
                for item in mapped {
                    result.push(item?);
                }
                result
            };

            if tasks.is_empty() {
                continue;
            }

            let workers: Vec<DispatchWorker> = workers
                .into_iter()
                .filter(|worker| tasks.iter().any(|task| worker.supports(&task.task_name)))
                .collect();
            if workers.is_empty() {
                continue;
            }

            let n = tasks.len();
            let m = workers.len();
            let mut cost = Array2::<f64>::zeros((n, m));
            let mut compatible = Array2::<bool>::from_elem((n, m), false);
            for (i, task) in tasks.iter().enumerate() {
                let age = (now - task.created_at).clamp(0.0, 300.0);
                let age_bonus = age * 0.15;
                let priority_bonus = task.priority as f64 * 1.8;
                let base_cost = (30.0 - priority_bonus - age_bonus).max(0.5);
                for (j, worker) in workers.iter().enumerate() {
                    if worker.supports(&task.task_name) {
                        compatible[[i, j]] = true;
                        cost[[i, j]] = base_cost;
                    } else {
                        cost[[i, j]] = 1.0e9;
                    }
                }
            }

            let effective_available = workers.iter().fold(0i64, |sum, worker| {
                sum.saturating_add(worker.available_slots)
            });
            let row_supply = Array1::from_vec(vec![1.0 / n as f64; n]);
            let col_demand = Array1::from_vec(
                workers
                    .iter()
                    .map(|worker| worker.available_slots as f64 / effective_available as f64)
                    .collect(),
            );
            let plan =
                sinkhorn_knopp_log_domain(&cost, &row_supply, &col_demand, epsilon, 120, 1e-6);
            let capacities: Vec<i64> = workers
                .iter()
                .map(|worker| worker.available_slots)
                .collect();
            let rounded = round_transport_plan_bounded(&plan, &capacities, &compatible);

            let mut update = tx.prepare(
                "UPDATE tasks
                 SET status = 'ASSIGNED',
                     locked_by = ?1,
                     locked_until = ?2,
                     heartbeat_at = ?3,
                     updated_at = ?4
                 WHERE id = ?5
                   AND status = 'PENDING'
                   AND task_type = ?6
                   AND task_name = ?7",
            )?;

            for (index, task) in tasks.iter().enumerate() {
                let worker_index = rounded[index];
                if worker_index < 0 {
                    continue;
                }
                let worker_index = worker_index as usize;
                let Some(worker) = workers.get(worker_index) else {
                    continue;
                };
                if !worker.supports(&task.task_name) {
                    continue;
                }

                let affected = update.execute(params![
                    worker.session_id,
                    lease_until,
                    now,
                    now,
                    task.id,
                    task.task_type,
                    task.task_name,
                ])?;
                if affected == 1 {
                    assignments_out.push(WorkerAssignment {
                        task_id: task.id,
                        session_id: worker.session_id.clone(),
                        task_name: task.task_name.clone(),
                        task_type: task.task_type.clone(),
                    });
                }
            }
        }

        tx.commit()?;
        Ok(assignments_out)
    })
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let length = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for index in 0..length {
        diff |= (left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0))
            as usize;
    }
    diff == 0
}

fn now_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

fn clamp_positive(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
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
    tolerance: f64,
) -> Array2<f64> {
    let (n, m) = cost.dim();
    if n == 0 || m == 0 || row_supply.len() != n || col_demand.len() != m {
        return Array2::zeros((n, m));
    }

    let row_sum: f64 = row_supply.iter().sum();
    let column_sum: f64 = col_demand.iter().sum();
    if !row_sum.is_finite() || !column_sum.is_finite() || row_sum <= 0.0 || column_sum <= 0.0 {
        return Array2::zeros((n, m));
    }

    let epsilon = if epsilon.is_finite() && epsilon > 0.0 {
        epsilon
    } else {
        1e-2
    };
    let tolerance = if tolerance.is_finite() && tolerance > 0.0 {
        tolerance
    } else {
        1e-6
    };
    let log_rows: Vec<f64> = row_supply
        .iter()
        .map(|value| clamp_positive(*value / row_sum).ln())
        .collect();
    let log_columns: Vec<f64> = col_demand
        .iter()
        .map(|value| clamp_positive(*value / column_sum).ln())
        .collect();
    let mut u = vec![0.0; n];
    let mut v = vec![0.0; m];

    for _ in 0..max_iter.max(1) {
        let old_u = u.clone();
        for i in 0..n {
            let mut max_value = f64::NEG_INFINITY;
            for j in 0..m {
                max_value = max_value.max((v[j] - cost[[i, j]]) / epsilon);
            }
            let mut sum = 0.0;
            for j in 0..m {
                sum += (((v[j] - cost[[i, j]]) / epsilon) - max_value).exp();
            }
            let log_sum_exp = if max_value.is_finite() && sum > 0.0 {
                max_value + sum.ln()
            } else {
                0.0
            };
            u[i] = epsilon * (log_rows[i] - log_sum_exp);
        }

        for j in 0..m {
            let mut max_value = f64::NEG_INFINITY;
            for i in 0..n {
                max_value = max_value.max((u[i] - cost[[i, j]]) / epsilon);
            }
            let mut sum = 0.0;
            for i in 0..n {
                sum += (((u[i] - cost[[i, j]]) / epsilon) - max_value).exp();
            }
            let log_sum_exp = if max_value.is_finite() && sum > 0.0 {
                max_value + sum.ln()
            } else {
                0.0
            };
            v[j] = epsilon * (log_columns[j] - log_sum_exp);
        }

        let max_delta = u
            .iter()
            .zip(old_u.iter())
            .map(|(new, old)| (new - old).abs())
            .filter(|delta| delta.is_finite())
            .fold(0.0f64, f64::max);
        if max_delta < tolerance {
            break;
        }
    }

    let mut plan = Array2::<f64>::zeros((n, m));
    for i in 0..n {
        for j in 0..m {
            let log_value = (u[i] + v[j] - cost[[i, j]]) / epsilon;
            let value = if !log_value.is_finite() || log_value < -700.0 {
                0.0
            } else if log_value > 700.0 {
                1e300
            } else {
                log_value.exp()
            };
            plan[[i, j]] = if value.is_finite() && value > 0.0 {
                value
            } else {
                0.0
            };
        }
    }

    for i in 0..n {
        let target = clamp_positive(row_supply[i] / row_sum);
        let current: f64 = (0..m).map(|j| plan[[i, j]]).sum();
        if current.is_finite() && current > 0.0 {
            let factor = target / current;
            for j in 0..m {
                plan[[i, j]] *= factor;
            }
        }
    }

    plan
}

fn round_transport_plan_bounded(
    plan: &Array2<f64>,
    capacities: &[i64],
    compatible: &Array2<bool>,
) -> Vec<i32> {
    let (n, m) = plan.dim();
    if compatible.dim() != (n, m) || capacities.len() != m {
        return vec![-1; n];
    }
    let mut remaining: Vec<usize> = capacities
        .iter()
        .map(|value| (*value).max(0) as usize)
        .collect();
    let mut assignment = vec![-1; n];
    let mut assigned = vec![false; n];
    let mut candidates = Vec::with_capacity(n.saturating_mul(m));

    for i in 0..n {
        for j in 0..m {
            let score = plan[[i, j]];
            if compatible[[i, j]] && score.is_finite() && remaining[j] > 0 {
                candidates.push((score, i, j));
            }
        }
    }
    candidates.sort_by(|left, right| right.0.partial_cmp(&left.0).unwrap_or(Ordering::Equal));

    for (_, task, worker) in candidates {
        if !assigned[task] && remaining[worker] > 0 {
            assignment[task] = worker as i32;
            assigned[task] = true;
            remaining[worker] -= 1;
        }
    }

    let mut unresolved: Vec<usize> = (0..n).filter(|index| !assigned[*index]).collect();
    unresolved.sort_by_key(|task| {
        (
            (0..m).filter(|worker| compatible[[*task, *worker]]).count(),
            *task,
        )
    });
    for task in unresolved {
        let mut best: Option<(usize, usize)> = None;
        for worker in 0..m {
            if !compatible[[task, worker]] || remaining[worker] == 0 {
                continue;
            }
            let candidate = (remaining[worker], worker);
            if best.is_none_or(|current| candidate > current) {
                best = Some(candidate);
            }
        }
        if let Some((_, worker)) = best {
            assignment[task] = worker as i32;
            assigned[task] = true;
            remaining[worker] -= 1;
        }
    }

    assignment
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_queue::RobustSinkhornQueue;

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn session_authentication_is_bounded_and_restart_revokes_same_worker_label() {
        let registry = WorkerRegistry::new(Duration::from_secs(10)).unwrap();
        let start = Instant::now();
        let first = registry
            .register_at(
                "worker-a".into(),
                WorkerKind::Cpu,
                2,
                names(&["document.process"]),
                start,
            )
            .unwrap();

        assert!(registry
            .authenticate_and_touch_at(
                &first.session.session_id,
                "wrong-token",
                start + Duration::from_secs(1),
            )
            .unwrap()
            .is_none());
        assert!(registry
            .authenticate_and_touch_at(
                &first.session.session_id,
                &first.session_token,
                start + Duration::from_secs(1),
            )
            .unwrap()
            .is_some());

        let second = registry
            .register_at(
                "worker-a".into(),
                WorkerKind::Cpu,
                2,
                names(&["document.process"]),
                start + Duration::from_secs(2),
            )
            .unwrap();
        assert_ne!(first.session.session_id, second.session.session_id);
        assert!(registry
            .authenticate_and_touch_at(
                &first.session.session_id,
                &first.session_token,
                start + Duration::from_secs(3),
            )
            .unwrap()
            .is_none());
        assert!(registry
            .authenticate_and_touch_at(
                &second.session.session_id,
                &second.session_token,
                start + Duration::from_secs(13),
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn strict_dispatch_requires_exact_task_name_and_respects_capacity() {
        let db_path = std::env::temp_dir().join(format!(
            "worker_protocol_dispatch_{}.db",
            rand::random::<u64>()
        ));
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        let cpu_1 = queue.enqueue_simple("cpu-1", "cpu", "cpu-secret").unwrap();
        let cpu_2 = queue
            .enqueue_simple("cpu-2", "cpu", "cpu-secret-2")
            .unwrap();
        let gpu = queue.enqueue_simple("gpu-1", "gpu", "gpu-secret").unwrap();

        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let gpu_registration = registry
            .register("gpu-worker", WorkerKind::Gpu, 1, names(&["gpu-1"]))
            .unwrap();
        let first =
            dispatch_registered(&db_path, registry.active_sessions().unwrap(), 1.5, 30.0).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].task_id, gpu);
        assert_eq!(first[0].task_name, "gpu-1");
        assert_eq!(first[0].task_type, "gpu");
        assert_eq!(first[0].session_id, gpu_registration.session.session_id);

        let cpu_registration = registry
            .register("cpu-worker", WorkerKind::Cpu, 1, names(&["cpu-1"]))
            .unwrap();
        let second =
            dispatch_registered(&db_path, registry.active_sessions().unwrap(), 1.5, 30.0).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].task_id, cpu_1);
        assert_eq!(second[0].task_name, "cpu-1");
        assert_eq!(second[0].task_type, "cpu");
        assert_eq!(second[0].session_id, cpu_registration.session.session_id);

        let third =
            dispatch_registered(&db_path, registry.active_sessions().unwrap(), 1.5, 30.0).unwrap();
        assert!(third.is_empty());

        let remaining_cpu: i64 = DatabaseManager::execute_with_retry(&db_path, |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE task_type='cpu' AND status='PENDING'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .unwrap();
        assert_eq!(remaining_cpu, 1);

        let cpu_2_registration = registry
            .register("cpu-worker-2", WorkerKind::Cpu, 1, names(&["cpu-2"]))
            .unwrap();
        let fourth =
            dispatch_registered(&db_path, registry.active_sessions().unwrap(), 1.5, 30.0).unwrap();
        assert_eq!(fourth.len(), 1);
        assert_eq!(fourth[0].task_id, cpu_2);
        assert_eq!(fourth[0].task_name, "cpu-2");
        assert_eq!(fourth[0].session_id, cpu_2_registration.session.session_id);

        cleanup(&db_path);
    }

    #[test]
    fn registration_rejects_invalid_exact_task_name_sets() {
        let registry = WorkerRegistry::new(Duration::from_secs(1)).unwrap();
        assert!(registry
            .register("worker", WorkerKind::Cpu, 0, names(&["cpu.task"]))
            .is_err());
        assert!(registry
            .register("worker", WorkerKind::Cpu, 1, Vec::new())
            .is_err());
        assert!(registry
            .register(
                "worker",
                WorkerKind::Cpu,
                1,
                names(&["cpu.task", "cpu.task"]),
            )
            .is_err());
        assert!(registry
            .register("worker", WorkerKind::Cpu, 1, names(&["cpu/task"]))
            .is_err());
    }

    #[test]
    fn dispatch_ignores_unknown_or_unassigned_rows_when_calculating_load() {
        let db_path =
            std::env::temp_dir().join(format!("worker_protocol_load_{}.db", rand::random::<u64>()));
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        queue.enqueue_simple("cpu", "cpu", "{}").unwrap();

        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let registration = registry
            .register("worker", WorkerKind::Cpu, 1, names(&["cpu"]))
            .unwrap();
        DatabaseManager::execute_with_retry(&db_path, |conn| {
            conn.execute(
                "INSERT INTO tasks (task_name, task_type, payload, status, priority, max_retries, retry_count, scheduled_at, created_at, updated_at, locked_by)
                 VALUES ('historical', 'cpu', '{}', 'COMPLETED', 0, 3, 0, 0, 0, 0, ?1)",
                params![registration.session.session_id],
            )?;
            Ok(())
        })
        .unwrap();

        let assigned =
            dispatch_registered(&db_path, registry.active_sessions().unwrap(), 1.5, 30.0).unwrap();
        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].task_name, "cpu");

        cleanup(&db_path);
    }
}
