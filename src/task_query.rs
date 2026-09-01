use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};

use crate::sync_queue::{DatabaseManager, QueueResult};

#[derive(Debug, Clone, PartialEq)]
pub struct TaskSnapshot {
    pub id: i64,
    pub task_name: String,
    pub task_type: String,
    pub priority: i64,
    pub max_retries: i64,
    pub retry_count: i64,
    pub status: String,
    pub locked_by: Option<String>,
    pub locked_until: Option<f64>,
    pub heartbeat_at: Option<f64>,
    pub error_log: Option<String>,
    pub scheduled_at: f64,
    pub created_at: f64,
    pub updated_at: f64,
    pub lease_generation: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueueMetricsSnapshot {
    pub observed_at: f64,
    pub total_tasks: i64,
    pub pending: i64,
    pub assigned: i64,
    pub running: i64,
    pub completed: i64,
    pub failed: i64,
    pub unknown_status: i64,
    pub pending_runnable: i64,
    pub pending_delayed: i64,
    pub active_leases: i64,
    pub expired_leases: i64,
    pub active_without_lease_deadline: i64,
    pub oldest_runnable_pending_age_seconds: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TaskQueryStore {
    db_path: PathBuf,
}

impl TaskQueryStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn ping(&self) -> QueueResult<()> {
        DatabaseManager::execute_with_retry(&self.db_path, |conn| {
            conn.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
    }

    pub fn get_task(&self, task_id: i64) -> QueueResult<Option<TaskSnapshot>> {
        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            conn.query_row(
                "SELECT
                    t.id,
                    t.task_name,
                    t.task_type,
                    t.priority,
                    t.max_retries,
                    t.retry_count,
                    t.status,
                    t.locked_by,
                    t.locked_until,
                    t.heartbeat_at,
                    t.error_log,
                    t.scheduled_at,
                    t.created_at,
                    t.updated_at,
                    COALESCE(f.generation, 0)
                 FROM tasks AS t
                 LEFT JOIN task_lease_fences AS f ON f.task_id = t.id
                 WHERE t.id = ?1",
                params![task_id],
                |row| {
                    Ok(TaskSnapshot {
                        id: row.get(0)?,
                        task_name: row.get(1)?,
                        task_type: row.get(2)?,
                        priority: row.get(3)?,
                        max_retries: row.get(4)?,
                        retry_count: row.get(5)?,
                        status: row.get(6)?,
                        locked_by: row.get(7)?,
                        locked_until: row.get(8)?,
                        heartbeat_at: row.get(9)?,
                        error_log: row.get(10)?,
                        scheduled_at: row.get(11)?,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                        lease_generation: row.get(14)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn metrics(&self) -> QueueResult<QueueMetricsSnapshot> {
        let observed_at = now_f64();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let (
                total_tasks,
                pending,
                assigned,
                running,
                completed,
                failed,
                unknown_status,
                pending_runnable,
                pending_delayed,
                active_leases,
                expired_leases,
                active_without_lease_deadline,
                oldest_runnable_created_at,
            ) = conn.query_row(
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(status = 'PENDING'), 0),
                    COALESCE(SUM(status = 'ASSIGNED'), 0),
                    COALESCE(SUM(status = 'RUNNING'), 0),
                    COALESCE(SUM(status = 'COMPLETED'), 0),
                    COALESCE(SUM(status = 'FAILED'), 0),
                    COALESCE(SUM(status NOT IN ('PENDING', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED')), 0),
                    COALESCE(SUM(status = 'PENDING' AND scheduled_at <= ?1), 0),
                    COALESCE(SUM(status = 'PENDING' AND scheduled_at > ?1), 0),
                    COALESCE(SUM(status IN ('ASSIGNED', 'RUNNING') AND locked_until IS NOT NULL AND locked_until >= ?1), 0),
                    COALESCE(SUM(status IN ('ASSIGNED', 'RUNNING') AND locked_until IS NOT NULL AND locked_until < ?1), 0),
                    COALESCE(SUM(status IN ('ASSIGNED', 'RUNNING') AND locked_until IS NULL), 0),
                    MIN(CASE WHEN status = 'PENDING' AND scheduled_at <= ?1 THEN created_at END)
                 FROM tasks",
                params![observed_at],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, Option<f64>>(12)?,
                    ))
                },
            )?;

            let oldest_runnable_pending_age_seconds = oldest_runnable_created_at
                .filter(|created_at| created_at.is_finite())
                .map(|created_at| (observed_at - created_at).max(0.0));

            Ok(QueueMetricsSnapshot {
                observed_at,
                total_tasks,
                pending,
                assigned,
                running,
                completed,
                failed,
                unknown_status,
                pending_runnable,
                pending_delayed,
                active_leases,
                expired_leases,
                active_without_lease_deadline,
                oldest_runnable_pending_age_seconds,
            })
        })
    }
}

fn now_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_queue::RobustSinkhornQueue;

    #[test]
    fn metrics_report_storage_facts_without_inventing_stuck_state() {
        let db_path =
            std::env::temp_dir().join(format!("task_query_metrics_{}.db", rand::random::<u64>()));
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();

        let runnable_id = queue.enqueue_simple("runnable", "cpu", "secret-a").unwrap();
        let delayed_id = queue.enqueue_simple("delayed", "cpu", "secret-b").unwrap();
        let expired_id = queue.enqueue_simple("expired", "cpu", "secret-c").unwrap();
        let unknown_id = queue.enqueue_simple("unknown", "cpu", "secret-d").unwrap();
        let now = now_f64();

        DatabaseManager::execute_with_retry(&db_path, |conn| {
            conn.execute(
                "UPDATE tasks SET scheduled_at = ?1 WHERE id = ?2",
                params![now + 60.0, delayed_id],
            )?;
            conn.execute(
                "UPDATE tasks
                 SET status = 'RUNNING', locked_by = 'worker-proof', locked_until = ?1
                 WHERE id = ?2",
                params![now - 1.0, expired_id],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'FUTURE_STATE' WHERE id = ?1",
                params![unknown_id],
            )?;
            Ok(())
        })
        .unwrap();

        let snapshot = TaskQueryStore::new(&db_path).metrics().unwrap();
        assert_eq!(snapshot.total_tasks, 4);
        assert_eq!(snapshot.pending, 2);
        assert_eq!(snapshot.pending_runnable, 1);
        assert_eq!(snapshot.pending_delayed, 1);
        assert_eq!(snapshot.running, 1);
        assert_eq!(snapshot.expired_leases, 1);
        assert_eq!(snapshot.active_leases, 0);
        assert_eq!(snapshot.active_without_lease_deadline, 0);
        assert_eq!(snapshot.unknown_status, 1);
        assert!(snapshot.oldest_runnable_pending_age_seconds.is_some());
        assert!(snapshot.observed_at >= now);

        let runnable = TaskQueryStore::new(&db_path)
            .get_task(runnable_id)
            .unwrap()
            .unwrap();
        assert_eq!(runnable.status, "PENDING");

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }
}
