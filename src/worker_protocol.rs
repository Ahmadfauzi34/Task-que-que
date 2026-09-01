use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ndarray::{Array1, Array2};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};
use crate::value::{Epsilon, LeaseDuration, WorkerKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerSession {
    pub session_id: String,
    pub worker_id: String,
    pub kind: WorkerKind,
    pub capacity: i64,
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
    ) -> QueueResult<WorkerRegistration> {
        self.register_at(worker_id.into(), kind, capacity, Instant::now())
    }

    fn register_at(
        &self,
        worker_id: String,
        kind: WorkerKind,
        capacity: i64,
        now: Instant,
    ) -> QueueResult<WorkerRegistration> {
        if worker_id.is_empty() {
            return Err(QueueError::InvalidState("worker id must not be empty".into()));
        }
        if capacity <= 0 {
            return Err(QueueError::InvalidState(
                "worker capacity must be greater than zero".into(),
            ));
        }

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
        Ok(sessions.values().map(|entry| entry.session.clone()).collect())
    }

    fn lock_sessions(
        &self,
    ) -> QueueResult<std::sync::MutexGuard<'_, HashMap<String, WorkerSessionEntry>>> {
        self.inner.lock().map_err(|_| {
            QueueError::InvalidState("worker session registry mutex was poisoned".into())
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerAssignment {
    pub task_id: i64,
    pub session_id: String,
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
        .map_err(|error| {
            QueueError::InvalidState(format!("worker dispatch join error: {error}"))
        })?
    }
}

#[derive(Debug, Clone)]
struct DispatchWorker {
    session_id: String,
    available_slots: i64,
}

#[derive(Debug, Clone)]
struct PendingTask {
    id: i64,
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

            let tasks = {
                let mut stmt = tx.prepare(
                    "SELECT id, task_type, priority, created_at
                     FROM tasks
                     WHERE status = 'PENDING'
                       AND scheduled_at <= ?1
                       AND task_type = ?2
                     ORDER BY priority DESC, id ASC
                     LIMIT ?3",
                )?;
                let mapped = stmt.query_map(params![now, task_type, total_available], |row| {
                    Ok(PendingTask {
                        id: row.get(0)?,
                        task_type: row.get(1)?,
                        priority: row.get(2)?,
                        created_at: row.get::<_, f64>(3).unwrap_or(now),
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

            let n = tasks.len();
            let m = workers.len();
            let mut cost = Array2::<f64>::zeros((n, m));
            for (i, task) in tasks.iter().enumerate() {
                let age = (now - task.created_at).max(0.0).min(300.0);
                let age_bonus = age * 0.15;
                let priority_bonus = task.priority as f64 * 1.8;
                let base_cost = (30.0 - priority_bonus - age_bonus).max(0.5);
                for j in 0..m {
                    cost[[i, j]] = base_cost;
                }
            }

            let row_supply = Array1::from_vec(vec![1.0 / n as f64; n]);
            let col_demand = Array1::from_vec(
                workers
                    .iter()
                    .map(|worker| worker.available_slots as f64 / total_available as f64)
                    .collect(),
            );
            let plan = sinkhorn_knopp_log_domain(
                &cost,
                &row_supply,
                &col_demand,
                epsilon,
                120,
                1e-6,
            );
            let capacities: Vec<i64> = workers
                .iter()
                .map(|worker| worker.available_slots)
                .collect();
            let rounded = round_transport_plan_bounded(&plan, &capacities);

            let mut update = tx.prepare(
                "UPDATE tasks
                 SET status = 'ASSIGNED',
                     locked_by = ?1,
                     locked_until = ?2,
                     heartbeat_at = ?3,
                     updated_at = ?4
                 WHERE id = ?5
                   AND status = 'PENDING'
                   AND task_type = ?6",
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

                let affected = update.execute(params![
                    worker.session_id,
                    lease_until,
                    now,
                    now,
                    task.id,
                    task.task_type
                ])?;
                if affected == 1 {
                    assignments_out.push(WorkerAssignment {
                        task_id: task.id,
                        session_id: worker.session_id.clone(),
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
        diff |= (left.get(index).copied().unwrap_or(0)
            ^ right.get(index).copied().unwrap_or(0)) as usize;
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

fn round_transport_plan_bounded(plan: &Array2<f64>, capacities: &[i64]) -> Vec<i32> {
    let (n, m) = plan.dim();
    let mut remaining: Vec<usize> = capacities.iter().map(|value| (*value).max(0) as usize).collect();
    let mut assignment = vec![-1; n];
    let mut assigned = vec![false; n];
    let mut candidates = Vec::with_capacity(n.saturating_mul(m));

    for i in 0..n {
        for j in 0..m {
            let score = plan[[i, j]];
            if score.is_finite() && remaining[j] > 0 {
                candidates.push((score, i, j));
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(Ordering::Equal)
    });

    for (_, task, worker) in candidates {
        if !assigned[task] && remaining[worker] > 0 {
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

    #[test]
    fn session_authentication_is_bounded_and_restart_revokes_same_worker_label() {
        let registry = WorkerRegistry::new(Duration::from_secs(10)).unwrap();
        let start = Instant::now();
        let first = registry
            .register_at("worker-a".into(), WorkerKind::Cpu, 2, start)
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
    fn strict_dispatch_never_crosses_worker_capability_and_respects_capacity() {
        let db_path = std::env::temp_dir().join(format!(
            "worker_protocol_dispatch_{}.db",
            rand::random::<u64>()
        ));
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        let cpu_1 = queue.enqueue_simple("cpu-1", "cpu", "cpu-secret").unwrap();
        let cpu_2 = queue.enqueue_simple("cpu-2", "cpu", "cpu-secret-2").unwrap();
        let gpu = queue.enqueue_simple("gpu-1", "gpu", "gpu-secret").unwrap();

        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let gpu_registration = registry.register("gpu-worker", WorkerKind::Gpu, 1).unwrap();
        let first = dispatch_registered(
            &db_path,
            registry.active_sessions().unwrap(),
            1.5,
            30.0,
        )
        .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].task_id, gpu);
        assert_eq!(first[0].task_type, "gpu");
        assert_eq!(first[0].session_id, gpu_registration.session.session_id);

        let cpu_registration = registry.register("cpu-worker", WorkerKind::Cpu, 1).unwrap();
        let second = dispatch_registered(
            &db_path,
            registry.active_sessions().unwrap(),
            1.5,
            30.0,
        )
        .unwrap();
        assert_eq!(second.len(), 1);
        assert!(second[0].task_id == cpu_1 || second[0].task_id == cpu_2);
        assert_eq!(second[0].task_type, "cpu");
        assert_eq!(second[0].session_id, cpu_registration.session.session_id);

        let third = dispatch_registered(
            &db_path,
            registry.active_sessions().unwrap(),
            1.5,
            30.0,
        )
        .unwrap();
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

        cleanup(&db_path);
    }

    #[test]
    fn registration_rejects_non_positive_capacity() {
        let registry = WorkerRegistry::new(Duration::from_secs(1)).unwrap();
        assert!(registry
            .register("worker", WorkerKind::Cpu, 0)
            .is_err());
    }

    #[test]
    fn dispatch_ignores_unknown_or_unassigned_rows_when_calculating_load() {
        let db_path = std::env::temp_dir().join(format!(
            "worker_protocol_load_{}.db",
            rand::random::<u64>()
        ));
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        queue.enqueue_simple("cpu", "cpu", "{}") .unwrap();

        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let registration = registry.register("worker", WorkerKind::Cpu, 1).unwrap();
        DatabaseManager::execute_with_retry(&db_path, |conn| {
            conn.execute(
                "INSERT INTO tasks (task_name, task_type, payload, status, priority, max_retries, retry_count, scheduled_at, created_at, updated_at, locked_by)
                 VALUES ('historical', 'cpu', '{}', 'COMPLETED', 0, 3, 0, 0, 0, 0, ?1)",
                params![registration.session.session_id],
            )?;
            Ok(())
        })
        .unwrap();

        let assigned = dispatch_registered(
            &db_path,
            registry.active_sessions().unwrap(),
            1.5,
            30.0,
        )
        .unwrap();
        assert_eq!(assigned.len(), 1);

        cleanup(&db_path);
    }
}
